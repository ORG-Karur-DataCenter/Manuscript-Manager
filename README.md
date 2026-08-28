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

A **revision requested** or **sent back for edits** event raises a pulsing action
flag on the card, since both need your work — a revision even though the paper is
still "in review". A sent-back paper also gets a **deadline**, and a WhatsApp
reminder as it approaches; see [Deadline reminders on WhatsApp](#deadline-reminders-on-whatsapp).

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

   **Publish before minting tokens, not after.** The seven days run from when a
   token was issued, not from the app's current status, so publishing does not
   rescue a token minted while the app was still in Testing — it expires on
   schedule and the sync stops with `invalid_grant`. If the app was published
   after tokens were issued, redo step 2 and replace the secrets. It is the
   easiest thing here to get wrong, because everything looks correct right up
   until the day it breaks.
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

Before pushing anything, run the checks. None of them need a network, a token,
or a deployed Worker:

```bash
npm run check            # all of the below
npm run check-registry   # how emails fold into the record, and manual edits
npm run check-timestamps # the two clocks per message
npm run check-worker     # the sync proxy, against a stubbed GitHub
npm run check-notify     # deadline reminders: when they fire, and how often
npm run check-editing    # editing in a real browser, end to end
```

`check-editing` needs Playwright (`npm install`); it skips itself with a note
if that is missing.

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


## Opening the dashboard

The page asks for a password before it shows anything. Tick **Stay signed in on
this device** to skip it for 30 days; leave it unticked and the unlock lasts
until the browser closes, or 12 hours, whichever comes first.

Be clear about what that password does and does not do. The page is static:
there is no server to check a password against, so the check happens in the
browser and anyone who opens developer tools can step past it. More
importantly, **this repository is public**, so `data/manuscripts.json` and the
rest can be read directly from GitHub without ever loading the page. The
password stops a passer-by or a shared screen; it does not keep the contents
secret. The only change that does that is making the repository private.

To change the password, replace `PASSWORD_HASH` in `assets/auth.js` with the
SHA-256 of the new one:

```sh
node -e "console.log(require('crypto').createHash('sha256').update('NEW PASSWORD').digest('hex'))"
```

## Correcting a record, and moving one between sections

Open a manuscript and press **Edit**. You can correct the title, journal,
status, manuscript number, DOI or article link, add notes for anything the
email trail does not carry, and move it to a different section.

**What you set by hand stays set.** This matters more than it looks. Every
field on this dashboard is derived from email: the classifier reads each
message and the sync folds it into the record, every three hours. So a
correction that was merely written down would be silently undone by the next
message from the journal — you would fix a title on Monday and find it wrong
again on Tuesday, with nothing to say why.

Instead a manual value is *pinned*. The sync is required to leave it alone,
permanently, and the field is marked **set by hand** wherever it appears. Your
judgement outranks the classifier's until you say otherwise.

**And you can say otherwise.** Each pinned field carries a **use automatic
again** link that hands it back to the sync. Pinning with no way out would turn
one hasty correction into a permanent lie, so the release is part of the
feature, not an afterthought.

Two details worth knowing:

- **Renaming keeps the manuscript whole.** Journals go on sending whatever title
  they were originally given, so the previous title is kept as a matching alias.
  Without that, correcting a title would quietly unhook the record from its own
  future and the next email would open a second copy alongside it.
- **Nothing is lost.** Every edit is recorded in the manuscript's history with
  what changed and when, and the data file is under version control, so any
  change can be read back or undone from the commit log.

Editing needs the sync service deployed (see `worker/README.md`) — it holds the
only credential allowed to write to the repository. Without it there is nowhere
to save to, and the **Edit** button is not offered rather than failing at the
last step. Its token needs **Contents: Read and write** as well as **Actions:
Read and write**; if it only has the latter, saving reports exactly that.

## Deadline reminders on WhatsApp

An amendment — a manuscript returned by the editorial office before peer review
— runs on a clock of five to fourteen days, and missing it usually withdraws
the submission. The tracker works out when each one is due and sends a WhatsApp
message when it is first seen, again at three days and one day out, and once if
it passes.

### Turning it on

Each recipient does this once, on their own phone:

1. Save **+34 613 01 49 37** to contacts. Verify it against
   [callmebot.com](https://www.callmebot.com/blog/free-api-whatsapp-messages/)
   first — this number has already changed once (it used to be +34 644 51 95 23)
   and it will change again. Messaging a stale number is not harmless: the old
   ones get reassigned, so the messages go to a stranger who can read them.
2. Send it exactly: `I allow callmebot to send me messages`
   The bot's own name in the phrase is the literal word `callmebot`, whatever
   you happened to name the contact.
3. It replies `API Activated for your phone number. Your APIKEY is 123123`.

Then add one repository secret, under **Settings → Secrets and variables →
Actions**, named `WHATSAPP_RECIPIENTS`:

```json
[{"name":"Dr Sathish","phone":"9600856806","apiKey":"123456"},
 {"name":"Dhibin","phone":"8778138148","apiKey":"654321"}]
```

Phone numbers live in the secret and never in this repository. That is not
fussiness: this repository is public, and a published number — unlike a token —
cannot be revoked and reissued. A check asserts no number reaches the committed
ledger either.

With the secret unset, nothing is sent and the sync runs exactly as before.

### If no API key comes back

CallMeBot is free and needs no account, which is why it is the default, but it
is one person's side project and it does sometimes not reply. In order:

- Check the number first. It has changed, and a message to the old one is
  delivered and read by whoever holds it now — two blue ticks prove nothing
  about whether the bot ever saw it.
- Check the phrase is exactly `I allow callmebot to send me messages`, with
  the literal word `callmebot` rather than the name you gave the contact.
- Their own advice if nothing comes back within two minutes is to leave it and
  try again after 24 hours. Repeating it every few minutes does not help.

If it still will not answer, the transport is pluggable and two others are
already implemented. Set the `WHATSAPP_TRANSPORT` repository variable to
`twilio` (needs `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`,
`TWILIO_WHATSAPP_FROM`) or `meta` (needs `META_WHATSAPP_TOKEN` and
`META_WHATSAPP_PHONE_ID`). Meta's own test number is free and messages up to
five verified recipients, which is ample here. The message itself is identical
whichever is in use.

### Checking it works, from a phone

The **Test WhatsApp reminders** workflow in the Actions tab is a button for
this. `dry-run` prints what would be sent without sending it, `send-test` sends
one short message to everybody, and `send-real` sends anything genuinely due.
It also reports which recipients are configured and whether each has a key —
by name and last four digits only, since workflow logs here are public.

### When a date is a guess

A journal that states a date or a period gets taken at its word. When it says
neither, `config/deadlines.json` supplies that journal's usual window, and the
result is labelled **estimated** on the card, in the drawer, and in the
message. A guessed date that looks stated is worse than no date at all — it
invites someone to rearrange a week around a number the journal never gave.
Correct one with **Edit** and the reminders follow your date instead.

## Sync now

The header has a **Sync now** button that runs the Gmail sync immediately
instead of waiting for the three-hourly schedule. It shows a progress ring and
a countdown; the estimate is the median duration of recent runs of this
workflow, not a fixed guess, so it tracks reality as the workflow changes.

The sync itself runs in GitHub Actions — that is the only place the Gmail
refresh tokens exist — so the button has to ask GitHub to start the workflow,
and that requires a token. It cannot be committed here: the repository is
public, so a committed token would be published and revoked within minutes.
Each person supplies their own once, and it is kept in that browser's
localStorage and sent only to `api.github.com`.

Create it at **GitHub → Settings → Developer settings → Personal access tokens
→ Fine-grained tokens**:

| Setting | Value |
| --- | --- |
| Repository access | Only `ORG-Karur-DataCenter/Manuscript-Manager` |
| Permissions | **Actions: Read and write** — nothing else |

A token scoped like that can start and watch workflow runs and do nothing
else: it cannot read repository secrets, push code, or reach any other
repository. **Do not use a classic token with `repo` scope** — that grants far
more than this needs.

You are asked for it **once per device**. After that it is reused
indefinitely; the prompt only returns if GitHub rejects the token or the
browser's data is cleared. To swap it deliberately, use *Use a different
GitHub token* at the bottom of the sync panel.

### Why the token cannot simply be built into the app

The obvious wish is to enter it once and have the app remember it for
everyone, forever. That cannot be done here, and it is worth being precise
about why rather than treating it as a limitation of effort.

The app is a static page: every file it uses is served from this repository,
which is **public**. A token committed here would be readable by anyone on the
internet the moment it was pushed. GitHub's secret scanning would also spot it
and revoke it automatically, usually within minutes — so it would not even
work, let alone be safe. Encrypting it against the app password does not help
either: that password is itself in the public source, so anyone could decrypt
it. Storing it per-browser is not a workaround for a missing feature; it is
the only place a credential can live when there is no server.

If entering it once per device is too much — several people on several phones —
deploy the sync proxy in `worker/`. It is a Cloudflare Worker holding one token
server-side, so nobody is asked for a token anywhere and the credential never
reaches a browser. See `worker/README.md`; it is two commands plus two secret
prompts, and the free tier covers this many times over.

Set `SYNC_PROXY_URL` in `assets/config.js` to the deployed Worker and the
dashboard uses it; leave it empty and the per-device token flow above applies.
Both sit behind the same code path, so switching between them changes nothing
else.

The button targets the branch named in `BRANCH` at the top of
`assets/sync.js`; update it if the deployed branch ever changes.


## Adding an Outlook mailbox

The tracker reads Gmail and Outlook. Each account in `config/accounts.json`
names its `provider`; omit it and the account is treated as Gmail, so existing
entries keep working untouched.

Outlook goes through Microsoft Graph, which needs an app registration. It is
free, and a personal Microsoft account can create one.

### 1. Register the app

[portal.azure.com](https://portal.azure.com) → **Microsoft Entra ID** → **App
registrations** → **New registration**.

| Field | Value |
| --- | --- |
| Name | anything, e.g. `ORG Karur COMMS` |
| Supported account types | **Accounts in any organizational directory and personal Microsoft accounts** |
| Redirect URI | **Public client/native**, `http://localhost:53683/callback` |

That account-type setting matters: pick a narrower one and the token exchange
fails later with an audience error that reads as though the credentials are
wrong.

Copy the **Application (client) ID** from the overview page.

Under **API permissions**, add **Microsoft Graph → Delegated → Mail.Read**.
Read-only is all this needs; it never sends or modifies mail.

A client secret is optional for a public client. If you create one
(**Certificates & secrets**), keep it for the next step; secrets expire, so a
public client with no secret is one less thing to renew.

### 2. Get a refresh token

```sh
OUTLOOK_CLIENT_ID=<client id> npm run get-outlook-token
```

Open the printed URL, sign in as the Outlook account, approve. The refresh
token is printed once — nothing is written to disk.

### 3. Store the secrets

In the repository, **Settings → Secrets and variables → Actions**:

| Secret | Value |
| --- | --- |
| `OUTLOOK_CLIENT_ID` | the Application (client) ID |
| `OUTLOOK_CLIENT_SECRET` | only if you created one |
| `OUTLOOK_REFRESH_TOKEN_DHIBIN` | the refresh token from step 2 |

The next scheduled run picks the mailbox up. A missing credential skips only
that account and logs which variable is absent — a half-configured Outlook
never stops the Gmail inboxes syncing.

### Differences worth knowing

Graph returns the whole message in the listing, so Outlook needs one request
per page rather than one per message — noticeably faster on a backfill.

`/me/messages` spans folders, including Deleted Items. Filtering that out
costs an extra lookup for little gain: seen ids and the registry both dedupe
by message id, so a deleted message is read once and never filed twice.
