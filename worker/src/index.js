/**
 * Sync proxy for the ORG Karur COMMS dashboard.
 *
 * WHY THIS EXISTS. The dashboard is a static page served from a public
 * repository, so it has nowhere safe to keep a GitHub token: anything
 * committed there is world-readable, and GitHub's secret scanning revokes
 * published tokens within minutes. Without a server, the only alternative is
 * for each person to paste their own token into their own browser.
 *
 * This Worker is that server. It holds one GitHub token as a secret, and
 * exposes the two operations the dashboard actually needs — start a sync, and
 * ask how it is going. The token never reaches a browser.
 *
 * ON THE PASSWORD CHECK. Callers must present the app password. That is a
 * modest bar, and deliberately so: the worst an unauthorised caller can do is
 * start a sync that the schedule would have run within three hours anyway.
 * Nothing here reads or returns manuscript data, and the token cannot be
 * extracted through these endpoints. The check exists to stop idle abuse, not
 * because a breach would be costly.
 *
 * Secrets (wrangler secret put ...):
 *   GITHUB_TOKEN   fine-grained PAT, this repo only, Actions: Read and write
 *   APP_PASSWORD   the dashboard password
 * Vars (wrangler.toml):
 *   ALLOWED_ORIGIN where the dashboard is served from
 */

const OWNER = "ORG-Karur-DataCenter";
const REPO = "Manuscript-Manager";
const WORKFLOW = "sync-manuscripts.yml";
const BRANCH = "claude/manuscript-tracking-app-jhj4p7";
const GH = `https://api.github.com/repos/${OWNER}/${REPO}`;
const FALLBACK_SECONDS = 165;

/** Constant-time compare, so a wrong password cannot be found byte by byte. */
function safeEqual(a, b) {
  const enc = new TextEncoder();
  const x = enc.encode(a || "");
  const y = enc.encode(b || "");
  if (x.length !== y.length) return false;
  let diff = 0;
  for (let i = 0; i < x.length; i++) diff |= x[i] ^ y[i];
  return diff === 0;
}

function corsHeaders(env, request) {
  const allowed = env.ALLOWED_ORIGIN || "*";
  const origin = request.headers.get("Origin") || "";
  // Echo the caller's origin when it is the permitted one; browsers reject a
  // wildcard on a request that carries an Authorization header.
  const value = allowed === "*" ? (origin || "*") : allowed;
  return {
    "Access-Control-Allow-Origin": value,
    "Access-Control-Allow-Headers": "Authorization, Content-Type",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Max-Age": "86400",
    Vary: "Origin",
  };
}

const json = (body, status, env, request) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...corsHeaders(env, request) },
  });

async function gh(path, env, options = {}) {
  const res = await fetch(`${GH}${path}`, {
    ...options,
    headers: {
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      Authorization: `Bearer ${env.GITHUB_TOKEN}`,
      // GitHub rejects API calls without one.
      "User-Agent": "orgkarur-comms-sync",
      ...(options.body ? { "Content-Type": "application/json" } : {}),
    },
  });
  if (res.status === 204) return null;
  const text = await res.text();
  if (!res.ok) {
    const err = new Error(`GitHub ${res.status}: ${text.slice(0, 200)}`);
    err.status = res.status;
    throw err;
  }
  return text ? JSON.parse(text) : null;
}

/** Median duration of recent successful runs, so the estimate tracks reality. */
async function estimateSeconds(env) {
  try {
    const data = await gh(`/actions/workflows/${WORKFLOW}/runs?status=success&per_page=10`, env);
    const durations = (data.workflow_runs || [])
      .map((r) => (new Date(r.updated_at) - new Date(r.run_started_at)) / 1000)
      .filter((s) => s > 5 && s < 3600)
      .sort((a, b) => a - b);
    return durations.length ? Math.round(durations[Math.floor(durations.length / 2)]) : FALLBACK_SECONDS;
  } catch {
    return FALLBACK_SECONDS;
  }
}

/** A dispatch returns no body, so the new run has to be found by its start time. */
async function findRunSince(since, env) {
  for (let i = 0; i < 12; i++) {
    const data = await gh(`/actions/workflows/${WORKFLOW}/runs?per_page=5`, env);
    const run = (data.workflow_runs || []).find(
      (r) => new Date(r.created_at).getTime() >= since - 15000
    );
    if (run) return run;
    await new Promise((r) => setTimeout(r, 2000));
  }
  return null;
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders(env, request) });
    }

    // Liveness, deliberately unauthenticated: lets the dashboard tell "the
    // worker is not deployed" apart from "your password is wrong".
    if (url.pathname === "/health") {
      // Name which secret is missing. "configured: false" alone sends people
      // hunting through a dashboard with no idea which of the two is wrong,
      // and a typo in a name looks identical to not having added it at all.
      const names = ["GITHUB_TOKEN", "APP_PASSWORD"];
      const missing = names.filter((n) => !env[n]);
      return json({
        ok: true,
        configured: missing.length === 0,
        missing,
        // Everything else this Worker can see, so a misspelled name shows up
        // as an unexpected entry rather than as silence. Names only.
        secretsFound: Object.keys(env).filter((k) => typeof env[k] === "string" && k !== "ALLOWED_ORIGIN"),
      }, 200, env, request);
    }

    const supplied = (request.headers.get("Authorization") || "").replace(/^Bearer\s+/i, "");
    if (!env.APP_PASSWORD || !env.GITHUB_TOKEN) {
      return json({ error: "The sync proxy is not configured. Set GITHUB_TOKEN and APP_PASSWORD." }, 500, env, request);
    }
    if (!safeEqual(supplied, env.APP_PASSWORD)) {
      return json({ error: "Not authorised." }, 401, env, request);
    }

    try {
      if (url.pathname === "/sync" && request.method === "POST") {
        const requestedAt = Date.now();
        const estimate = await estimateSeconds(env);
        await gh(`/actions/workflows/${WORKFLOW}/dispatches`, env, {
          method: "POST",
          body: JSON.stringify({ ref: BRANCH }),
        });
        const run = await findRunSince(requestedAt, env);
        if (!run) {
          return json({ error: "The sync started but its run could not be found." }, 502, env, request);
        }
        return json({
          runId: run.id,
          htmlUrl: run.html_url,
          startedAt: run.run_started_at || run.created_at,
          estimateSeconds: estimate,
        }, 200, env, request);
      }

      const match = url.pathname.match(/^\/sync\/(\d+)$/);
      if (match && request.method === "GET") {
        const run = await gh(`/actions/runs/${match[1]}`, env);
        return json({
          status: run.status,
          conclusion: run.conclusion,
          htmlUrl: run.html_url,
          startedAt: run.run_started_at || run.created_at,
        }, 200, env, request);
      }

      return json({ error: "Not found." }, 404, env, request);
    } catch (err) {
      // A GitHub auth failure is the proxy's problem, not the caller's, so say
      // so rather than returning a 401 the dashboard would blame on the user.
      const status = err.status === 401 || err.status === 403 ? 502 : 500;
      return json({ error: err.message || "Upstream failure." }, status, env, request);
    }
  },
};
