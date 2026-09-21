# Starter data — for someone setting up their own copy

The five files in `starter/data/` are **empty versions** of the five files in
`data/`. They exist for one reason: so that handing this app to another
research group does not hand them your manuscripts as well.

`data/manuscripts.json` and its four companions are not code. They are the
tracker's record of *your* papers: every title, every journal, every rejection,
every reviewer deadline, and in `data/excluded-log.json` the subject line and
sender of mail that was read and set aside. A ZIP of this repository carries
all of it.

So the first thing a new owner does, before anything else works or matters, is
copy these five files over the five in `data/`. They then start from nothing,
and the first sync fills the tracker from their own inbox.

`SETUP-GUIDE.md` walks through this as Step 4. It is written for someone who
has never used GitHub.

## Why empty rather than a sample

A sample dataset would make the dashboard look alive on the first visit, which
is tempting and wrong: the new owner cannot tell invented papers from their
own until the first sync lands, and a tracker that shows papers nobody
submitted is worse than one that honestly shows none. The dashboard has a
proper empty state — *"No manuscripts yet"* — and that is the truthful thing
to show until real mail arrives.

(If you do want a populated dashboard to look around, `node
scripts/seed-sample.mjs` writes `data/manuscripts.sample.json` for exactly
that. Do not commit it over the real file.)
