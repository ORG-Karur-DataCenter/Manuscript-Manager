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

The token is the same kind described in the main README: **fine-grained**, this
repository only, permission **Actions: Read and write**, nothing else.

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

Callers must send the dashboard password. That is a deliberately modest bar:
the worst an unauthorised caller can do is start a sync that the schedule would
have run within three hours anyway. Nothing here reads or returns manuscript
data, and the GitHub token cannot be extracted through these endpoints — a
test asserts it never appears in a response body. The check exists to stop idle
abuse, not because a breach would be costly.

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

`estimateSeconds` is the median duration of recent successful runs, so the
countdown in the dashboard tracks this workflow rather than a fixed guess.
