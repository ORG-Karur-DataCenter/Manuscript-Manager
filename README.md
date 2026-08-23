# Manuscript Tracker

A self-updating dashboard that watches your Gmail inbox(es), pulls in **only** the
emails that report on the status of **your own submitted manuscripts**, and tracks
each paper through its whole life — submission → review → revision → rejection →
resubmission to another journal → acceptance → publication (with DOI) — so a
rejected paper never gets lost in the daily flood of email and forgotten before
you resubmit it.

It deliberately **ignores** predatory-journal solicitations, invitations to *peer
review* someone else's paper, newsletters, and calls for papers.

- **Frontend:** a static dashboard (`index.html` + `assets/`), served by GitHub Pages.
- **Backend:** a Node script (`scripts/sync-gmail.mjs`) run by GitHub Actions on a
  schedule. It reads Gmail over the API, classifies each email with a **free-tier
  LLM** (no paid API, no card), updates a JSON registry (`data/manuscripts.json`),
  and commits the result. The dashboard just reads that JSON.

There is no server and no database — the git repo *is* the database.

---

## How an email becomes a tracked entry

```
Gmail inbox(es)
   │  (poll every 3h, only mail since last sync)
   ▼
keyword prefilter  ──► obvious non-candidates dropped (no AI cost)
   │
   ▼
free-tier LLM      ──► relevant?  ──no──► logged in data/excluded-log.json with a reason
   │ yes                                   (predatory / review-invite / newsletter / unrelated)
   ▼
second model       ──► do the two agree?  ──no──► data/review-queue.json (never guessed)
cross-checks it    │ yes
   ▼
extract { title, journal, manuscript no., event_type, revision round, DOI, link }
   │
   ▼
match against registry:
   • same journal + manuscript number  → same submission
   • else fuzzy title match (≥ 0.82)    → same manuscript, NEW journal = resubmission
   • else                               → brand-new manuscript
   │
   ▼
update status, append a timestamped timeline event, recompute the dashboard bucket
```

### Status buckets (the dashboard action buttons)

| Button | What's in it |
| --- | --- |
| **Submissions** | Freshly submitted, acknowledged by a journal, awaiting first editorial check. |
| **Needs action** | Rejected papers to resubmit elsewhere **and** papers sent back for edits before peer review. |
| **In review** | Under peer review, revision in progress, transferred, or accepted-awaiting-publication. |
| **Published** | Published, with DOI and article link. |

A **revision requested** event also raises a pulsing action flag on the card, since it needs your work even though the paper is still "in review".

### Resubmission continuity

If a paper is rejected at Journal A and later submitted to Journal B, both journals
appear as one manuscript with a **submission thread** — A marked *rejected*, B marked
*active* — so the rejection→resubmission is a single continuous record, not two
disconnected entries.

---

## One-time setup

### 1. Google Cloud — create OAuth credentials

1. Go to <https://console.cloud.google.com/> and create a project (any name).
2. **APIs & Services → Library →** enable the **Gmail API**.
3. **APIs & Services → OAuth consent screen:** choose **External**, fill the
   required fields. Add every Gmail address you'll track as a **Test user**.

   **Then publish it: click "Publish app" so the status reads "In production".**
   Google expires refresh tokens after **7 days** for apps left in "Testing", which
   would break the sync every week with an `invalid_grant` error. Publishing stops
   that. You will see an "unverified app" warning once, during the authorisation in
   step 2 — click through it (Advanced → Go to *app name*). No Google review is
   needed for personal use.
4. **APIs & Services → Credentials → Create credentials → OAuth client ID →
   Application type: Desktop app.** Note the **Client ID** and **Client secret**.

### 2. Mint a refresh token for each inbox

Run locally (Node 18+), once per Gmail account listed in `config/accounts.json`:

```bash
npm install
GMAIL_CLIENT_ID=xxx GMAIL_CLIENT_SECRET=yyy npm run get-refresh-token
```

A browser window opens; **sign in with the specific Gmail account** you're minting
the token for and approve read-only access. The script prints a `refresh_token`.
Repeat for the second account, signing in with that account.

### 3. Add GitHub Actions secrets

In the repo: **Settings → Secrets and variables → Actions → New repository secret.**

| Secret | Value |
| --- | --- |
| `GMAIL_CLIENT_ID` | OAuth client ID from step 1 |
| `GMAIL_CLIENT_SECRET` | OAuth client secret from step 1 |
| `GMAIL_REFRESH_TOKEN_SATHISH` | refresh token for drsathishmuthu@gmail.com |
| `GMAIL_REFRESH_TOKEN_DHIBIN` | refresh token for dhibinvikash1@gmail.com |
| **at least one** classifier key below | see [The classifier](#the-classifier) |

| Classifier secret | Where to get it (all free, no card) |
| --- | --- |
| `GEMINI_API_KEY` | <https://aistudio.google.com/apikey> |
| `CEREBRAS_API_KEY` | <https://cloud.cerebras.ai/> |
| `GROQ_API_KEY` | <https://console.groq.com/keys> |

Also enable Actions write access: **Settings → Actions → General → Workflow
permissions → Read and write permissions.**

### 4. Turn on GitHub Pages

**Settings → Pages → Build and deployment → Deploy from a branch →** pick the branch
(`main` once merged) and `/ (root)`. Your dashboard will be at
`https://<user>.github.io/Manuscript-Manager/`.

### 5. Run it

**Actions → Sync manuscript tracker → Run workflow** to do the first sync manually
(the first run looks back 30 days). After that it runs every 3 hours automatically.

---

## Adding or removing an inbox

Edit `config/accounts.json` — add an object with the account's `label`, `email`, and
a `refreshTokenEnv` name, mint a token for it (step 2), add that secret (step 3), and
reference the secret in `.github/workflows/sync-manuscripts.yml`. No code changes.

## Privacy note

This repository is **public**, so `data/manuscripts.json` — your manuscript titles,
journals, and rejection/resubmission history — is publicly readable. If you'd rather
keep that private, make the repo private (GitHub Pages on a private repo needs a paid
plan) or host the data elsewhere.

## Local development

```bash
node scripts/seed-sample.mjs          # writes data/manuscripts.sample.json
cp data/manuscripts.sample.json data/manuscripts.json   # preview only — don't commit
python3 -m http.server 8099           # open http://localhost:8099
```

## The classifier

The engine costs nothing. It runs on permanently free API tiers, and it is built so
that being free never means being less accurate.

**Two models, not one.** The first model classifies the email. Anything it calls
relevant — anything that would create a dashboard entry — plus anything it answers
with less than high confidence is then re-run on a **different** model. If the two
agree, the entry is filed. If they disagree, the email is written to
`data/review-queue.json` with both verdicts rather than being guessed at. A paper is
never silently lost, and junk never silently appears.

**Worked examples, not keyword rules.** The hardest call in this inbox is telling a
peer-review invitation for someone else's paper apart from a decision on your own —
both quote a manuscript number, a title and an abstract. `scripts/lib/classify.mjs`
teaches that distinction with worked examples of each, which is what actually moves a
smaller model's accuracy.

**Provider chain.** Configure one key or all three. They are tried in order and a
rate-limited or failing provider falls through to the next:

| Order | Provider | Free tier | Trains on your email? |
| --- | --- | --- | --- |
| 1 | `gemini-3.7-flash` | ~1,000 req/day (Flash-Lite tier); 1M context | **Yes** — Google may use free-tier content to improve its products |
| 2 | `gemini-2.5-flash` | ~250 req/day | **Yes**, as above |
| 3 | Cerebras `gpt-oss-120b` | ~1M tokens/day | Check current policy |
| 4 | Groq `kimi-k2-instruct` | ~1,000 req/day, ~6K tokens/min | **No** — stated no-training policy |

Free-tier quotas move; treat the numbers as a starting point. Override any model with
`GEMINI_MODEL`, `GEMINI_FALLBACK_MODEL`, `CEREBRAS_MODEL`, `GROQ_MODEL`.

Set `CLASSIFIER_PROVIDERS` to restrict the chain to a comma-separated allowlist, in
the order given — `CLASSIFIER_PROVIDERS=cerebras,groq` keeps email text away from
Gemini's free tier without deleting the key.

Verify the engine at any time, without needing Gmail access:

```bash
npm run check-classifier                          # full chain
CLASSIFIER_PROVIDERS=cerebras,groq npm run check-classifier
```

It runs three realistic journal emails with known correct answers — including the
reviewer-invitation case free models most often get wrong — and reports which
provider answered, what the cross-check concluded, and whether each was right.
The **Check classifier** workflow runs the same thing with the repository secrets.

> **Privacy:** whichever provider you choose sees the full text of the journal
> correspondence in both inboxes. On Google's free tier that content may be used to
> improve their models. If that matters, set only `GROQ_API_KEY` and
> `CEREBRAS_API_KEY` and leave `GEMINI_API_KEY` unset — the chain works fine with a
> subset. Since a second person's mail is in scope, this is their decision too.

### Staying inside a free quota

Each run classifies at most `MAX_CLASSIFICATIONS_PER_RUN` emails (default 100).
Anything left over is **deferred, not dropped**: its Gmail ID stays out of the seen
list and the sync window is held back to it, so the next run picks it up. The same
holds for an email whose classification failed on a rate limit. A 30-day first
backfill therefore spreads itself across several runs instead of blowing a daily
quota in one go.

## Tuning classification

The triage prompt, worked examples and cross-check policy live in
`scripts/lib/classify.mjs`. The output schema is in `scripts/lib/schema.mjs` and the
provider adapters in `scripts/lib/providers.mjs`. The prefilter keywords are in
`scripts/sync-gmail.mjs`. The fuzzy-title match threshold and bucket rules are in
`scripts/lib/registry.mjs`.
