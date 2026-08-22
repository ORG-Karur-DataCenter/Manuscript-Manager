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
  schedule. It reads Gmail over the API, classifies each email with the Claude API,
  updates a JSON registry (`data/manuscripts.json`), and commits the result. The
  dashboard just reads that JSON.

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
Claude classifier  ──► relevant?  ──no──► logged in data/excluded-log.json with a reason
   │ yes                                   (predatory / review-invite / newsletter / unrelated)
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
   required fields. Add every Gmail address you'll track as a **Test user** (this
   lets the app work without Google verification). You can leave it in "Testing".
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
| `ANTHROPIC_API_KEY` | a key from <https://console.anthropic.com/> |

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

## Tuning classification

The triage rules and the extraction schema live in `scripts/lib/classify.mjs`. The
prefilter keywords are in `scripts/sync-gmail.mjs`. The fuzzy-title match threshold
and bucket rules are in `scripts/lib/registry.mjs`.
