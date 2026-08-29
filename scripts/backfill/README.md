# Backfill tooling

Loading an inbox's history through the classifier costs a day of free-tier
quota and gets it wrong in ways that are expensive to undo. These scripts do it
offline instead: they read a dump from `dump-candidates`, sort it into buckets,
and emit files in the same shape `classifyEmail` returns, ready for
`apply-import.mjs`.

They exist because the same handful of mistakes kept recurring, each one
encoded here as a rule with the reason attached. Read the comments before
loosening anything.

## Order

```sh
# 1. See the shape of the dump.
node scripts/backfill/triage.mjs dump.json

# 2. Rule-based buckets. Both take (dump, out, registry); the registry is read
#    only to fold new journal names onto spellings already in use.
node scripts/backfill/build-submissions.mjs dump.json sub.json data/manuscripts.json
node scripts/backfill/build-unclear.mjs     dump.json unc.json data/manuscripts.json

# 3. Decisions are read by hand — see below.

# 4. Apply. --seen-only is required for a historical window: it records the
#    message ids without dragging the forward sync window backwards.
node scripts/apply-import.mjs sub.json --handover someone@gmail.com --seen-only
```

Always review the journal names a build produces before applying. A name that
has absorbed a following word ("World Journal of Orthopedics Notification")
creates a second journal in the dashboard that looks real.

## Decisions are not automatable

`triage.mjs` separates a DECISION bucket, but nothing here classifies it.
"Unfortunately, we were not able to accept your manuscript" and "It is a
pleasure to accept your manuscript" are the same shape, and reading one as the
other makes a dead paper show as live. Read each email and write the verdicts
out by hand — `build-decisions-*.mjs` in the git history shows the format.

Three helpers make that pass quick:

```sh
CHARS=400 node scripts/backfill/read-ids.mjs dump.json <id>...  # excerpts
node scripts/backfill/verdict.mjs dump.json <id>...             # verdict phrases
node scripts/backfill/titles.mjs  dump.json <id>...             # titles
```

Two classes must never be filed, however much they look like decisions:

- **Other people's manuscripts.** A researcher who edits or reviews receives
  decision letters, assignment notices and "invitations to handle" that quote a
  manuscript number and title exactly like their own. Filing one puts a
  stranger's paper in the registry.
- **Transfer offers.** "Transfer recommendations", "Transfer Not Completed" and
  transfer invitations are not transfers. Filing one opens a phantom live
  submission at a journal that has already rejected the paper, and lifts it out
  of `needs_action`.

## Why the extraction is written the way it is

`extract.mjs` walks tokens rather than matching a lazy character run, because a
lazy run swallows whatever follows the journal name. The rules it applies, each
from a real failure:

- A quoted span in a subject is the manuscript title, never the journal —
  otherwise a preposition inside the title starts a journal match.
- A name that repeats the manuscript title is not a journal ("Submission
  Confirmation for \<title\>").
- Introducer words are skipped ("Editors of the World Journal of Stem Cells"),
  and trailing sentence words cut at the first one, not just from the end.
- Journal names containing a comma are restored by alias, since token walking
  stops at punctuation.

`triage.mjs` reads bodies, not just subjects: Baishideng titles a peer-review
invitation "…Manuscript peer review invitation…" and quotes the full manuscript
title inside, and ten such emails in one window were identifiable only from the
body.

`build-unclear.mjs` covers the emails whose subjects match no pattern. Most is
noise, but the production and publication trail lives there — Springer, Sage and
Wiley announce that a paper is published with subjects that never mention a
manuscript. Note that Editorial Manager builds a PDF for the author to approve
at *submission* time, so "Your PDF has been built" is not a proof and does not
mean acceptance.
