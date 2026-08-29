# Sync proxy

A Cloudflare Worker that lets **Sync now** work without anyone holding a GitHub
token in their browser.

## Why it exists

The dashboard is a static page in a public repository, so it has nowhere safe
to keep a GitHub token — anything committed here is world-readable, and
GitHub's secret scanning revokes published tokens within minutes. Without a
server the only option is for each person to paste their own token into their
own browser, once per device.

This Worker is that server. It holds one token as a secret and exposes only the
two operations the dashboard needs: start a sync, and report how it is going.
The token never reaches a browser. Once it is deployed, nobody is asked for a
token anywhere.

## Deploy

Free tier is ample — this runs a handful of requests a day against a limit of
100,000.

```sh
cd worker
npx wrangler login          # opens a browser once
npx wrangler deploy         # prints the Worker URL
```

Then set the two secrets. These are prompts, so nothing is written to disk or
shell history:

```sh
npx wrangler secret put GITHUB_TOKEN   # paste the fine-grained PAT
npx wrangler secret put APP_PASSWORD   # the dashboard password
```

The token is **fine-grained**, this repository only, with two permissions:

| Permission | What needs it |
| --- | --- |
| **Actions: Read and write** | starting and watching a sync run |
| **Contents: Read and write** | saving an edit, which commits `data/manuscripts.json` |

Nothing else. A token like that cannot read the repository's secrets or touch
any other repository. A classic token with `repo` scope grants far more; do not
use one.

If the Worker was deployed before editing existed, its token has only the first
permission. Add the second on the token's page on GitHub — the Worker keeps
working throughout, and there is no need to redeploy or re-enter the secret.
Until then, saving an edit fails with a message naming exactly that.

Finally, point the dashboard at it — edit `assets/config.js`:

```js
export const SYNC_PROXY_URL = "https://orgkarur-comms-sync.<subdomain>.workers.dev";
```

and tighten `ALLOWED_ORIGIN` in `wrangler.toml` from `"*"` to wherever the
dashboard is actually served from, then `npx wrangler deploy` again. That stops
another site calling this Worker from a visitor's browser.

Check it is alive:

```sh
curl https://<your-worker-url>/health
# {"ok":true,"configured":true}
```

`configured: false` means a secret is missing.

## Falling back

Leave `SYNC_PROXY_URL` empty and the dashboard reverts to asking each person
for their own token. Both paths are behind the same `runSync()`, so nothing
else changes. Deleting the Worker is a safe way to undo this.

## What the password check is for

Callers must send the dashboard password. For `/sync` that is a deliberately
modest bar: the worst an unauthorised caller can do is start a sync that the
schedule would have run within three hours anyway.

Editing raises the stakes, and it is worth being clear about how far. A caller
who knows the password can change a manuscript's title, section, journal, or
status. They cannot write anywhere else: the endpoint takes a manuscript id and
a list of named fields, applies them through the same rules the sync uses, and
commits that one file. It cannot add files, run code, reach another repository,
or return the token — a test asserts the token never appears in a response
body. And nothing is destroyed: every edit is recorded in the manuscript's own
`edits` list, and the whole file is under version control, so any change can be
read back and undone from the commit history.

The password is sent from the browser over HTTPS and held in `sessionStorage`
for that browser session only. It is deliberately not kept in `localStorage`:
a session flag surviving on a shared device is one thing, the password itself
surviving there is another. So the first sync in a new browser session asks you
to confirm it; after that it does not ask again until the browser is closed.

## Endpoints

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` | `/health` | Liveness; unauthenticated, so the dashboard can tell "not deployed" from "wrong password" |
| `POST` | `/sync` | Start a run. Returns `runId`, `htmlUrl`, `startedAt`, `estimateSeconds` |
| `GET` | `/sync/:runId` | Report `status` and `conclusion` for that run |
| `PATCH` | `/manuscripts/:id` | Save an edit. Body is `{field: value}`; `""` hands a field back to the sync |

`estimateSeconds` is the median duration of recent successful runs, so the
countdown in the dashboard tracks this workflow rather than a fixed guess.

## Editing, and the collision it has to survive

`PATCH /manuscripts/:id` reads `data/manuscripts.json`, applies the change, and
commits it back. The difficulty is not the edit — it is that the three-hourly
sync rewrites the same file, and two people can have the dashboard open at
once.

The write therefore carries the blob SHA the edit was based on. If the file has
moved on since, GitHub refuses it rather than letting one writer overwrite the
other, and the Worker re-reads and replays the edit against the new content.
That is safe precisely because an edit is a patch to named fields on one
manuscript rather than a whole-file replacement. After four failed attempts it
gives up and says so, instead of forcing the write.

The sync handles the mirror image of this with `git pull --rebase --autostash`
before it pushes.

The edit rules themselves — which fields may be set, what pinning means, how a
rename is handled — exist twice: in `scripts/lib/registry.mjs` for the sync, and
again here, because a Worker is deployed alone and cannot import from the repo.
That is a standing drift hazard, so `npm run check-worker` runs the same patches
through both and fails if they disagree.

## Checking it

```sh
npm run check-worker    # the Worker's own logic, against a stubbed GitHub
npm run check-editing   # the whole feature in a real browser, both servers live
```

Neither needs the Worker deployed, a GitHub token, or a network.
