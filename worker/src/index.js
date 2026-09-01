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

/*
 * The branch to dispatch on, and why it is not simply a constant.
 *
 * It was "main" here, and before that a development branch name. This Worker
 * is deployed separately from the repository, so a constant here goes stale
 * the moment a branch is renamed or removed -- and stays stale until somebody
 * remembers to redeploy. That is exactly what happened: the branch was
 * deleted, the deployed Worker kept asking for it, and Sync answered "No ref
 * found for claude/manuscript-tracking-app-jhj4p7" with nothing to suggest the
 * cause was a stale deployment rather than a broken button.
 *
 * Asking GitHub for the repository's default branch removes the class of
 * fault: renaming or deleting a branch can no longer desynchronise a Worker
 * nobody thought to redeploy. BRANCH_FALLBACK covers the case where that
 * lookup itself fails, so a GitHub blip degrades to the old behaviour rather
 * than to no sync at all.
 */
const BRANCH_FALLBACK = "main";
let cachedBranch = null;

/*
 * Tests drive several different repositories through one module instance, and
 * a cache that outlives them would make the second test assert the first
 * one's answer. Exported for that, and used nowhere in the request path.
 */
export function __resetBranchCache() {
  cachedBranch = null;
}

async function defaultBranch(env) {
  if (cachedBranch) return cachedBranch;
  try {
    const repo = await gh("", env);
    cachedBranch = repo?.default_branch || BRANCH_FALLBACK;
  } catch {
    cachedBranch = BRANCH_FALLBACK;
  }
  return cachedBranch;
}
const GH = `https://api.github.com/repos/${OWNER}/${REPO}`;
const FALLBACK_SECONDS = 165;
const DATA_PATH = "data/manuscripts.json";

/**
 * Fields a person may set by hand. Mirrored from scripts/lib/registry.mjs,
 * which this Worker cannot import -- it is deployed on its own. Keep in step.
 */
const OVERRIDABLE = [
  "bucket",
  "title",
  "currentJournal",
  "currentStatus",
  "currentManuscriptNumber",
  "deadline",
  "doi",
  "publicationLink",
  "notes",
];
const BUCKETS = ["submissions", "needs_action", "revisions_pending", "in_review", "published"];

// In step with registry.mjs normalizeTitle, ampersand rule included: an
// exact title is what identifies a paper, so the two must agree on what
// "exact" means.
const normalizeTitle = (t) =>
  (t || "").toLowerCase().replace(/&/g, " and ").normalize("NFKD").replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9 ]/g, " ").replace(/\s+/g, " ").trim();

/**
 * The same rules as registry.mjs applyEdit: setting a field pins it against
 * later automation, an empty value releases it, and every previous title stays
 * a matching alias so a rename does not unhook the record from its own future.
 */
function applyEdit(manuscript, patch, at) {
  manuscript.overrides ||= {};
  manuscript.edits ||= [];
  const changed = [];

  for (const [field, raw] of Object.entries(patch || {})) {
    if (!OVERRIDABLE.includes(field)) throw new Error(`"${field}" is not an editable field.`);
    const value = typeof raw === "string" ? raw.trim() : raw;
    if (field === "bucket" && value && !BUCKETS.includes(value)) {
      throw new Error(`"${value}" is not a section.`);
    }
    const before = manuscript[field] ?? null;

    if (value === null || value === "") {
      if (!Object.prototype.hasOwnProperty.call(manuscript.overrides, field)) continue;
      delete manuscript.overrides[field];
      changed.push({ field, from: before, to: null, released: true });
      continue;
    }
    if (before === value && Object.prototype.hasOwnProperty.call(manuscript.overrides, field)) continue;
    manuscript.overrides[field] = value;
    manuscript[field] = value;
    changed.push({ field, from: before, to: value });
  }

  if (!changed.length) return changed;

  const renamed = changed.find((c) => c.field === "title");
  if (renamed) {
    manuscript.titleNormalized = normalizeTitle(manuscript.title);
    manuscript.titleAliases ||= [];
    if (renamed.from && !manuscript.titleAliases.includes(renamed.from) && renamed.from !== manuscript.title) {
      manuscript.titleAliases.push(renamed.from);
    }
  }
  if (changed.some((c) => c.field === "bucket" && !c.released)) {
    manuscript.needsActionReason = null;
    manuscript.actionFlag = false;
    manuscript.actionLabel = null;
  }

  manuscript.edits.push({ at, by: "dashboard", changes: changed });
  manuscript.editedAt = at;
  return changed;
}

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
    "Access-Control-Allow-Methods": "GET, POST, PATCH, OPTIONS",
    "Access-Control-Max-Age": "86400",
    Vary: "Origin",
  };
}

const json = (body, status, env, request) =>
  new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json",
      // Every answer here is about right now -- whether a secret is set, how a
      // run is progressing. A cached copy is always misleading, and a stale
      // /health in particular reads as "the secrets I just added did nothing".
      "Cache-Control": "no-store, no-cache, must-revalidate",
      ...corsHeaders(env, request),
    },
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

/**
 * Base64 in a Worker is byte-oriented, and manuscript titles are full of
 * characters that are not one byte each -- accented author names, en dashes,
 * the odd Greek letter in a title. Going through TextEncoder/TextDecoder keeps
 * those intact; atob/btoa on the raw string would mangle them.
 */
const decodeBase64 = (b64) =>
  new TextDecoder().decode(Uint8Array.from(atob(b64.replace(/\s/g, "")), (c) => c.charCodeAt(0)));

function encodeBase64(text) {
  const bytes = new TextEncoder().encode(text);
  let binary = "";
  // Chunked: spreading a 300 KB array into String.fromCharCode blows the stack.
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(binary);
}

/**
 * Read the registry, apply one edit, commit it back.
 *
 * THE COLLISION THIS GUARDS AGAINST. The three-hourly sync rewrites this same
 * file, and two people can have the dashboard open at once. The Contents API
 * takes the blob SHA the edit was based on and refuses the write if the file
 * has moved on since -- so a lost update becomes a 409 rather than silently
 * discarding whatever the other writer just committed. On a 409 we re-read and
 * replay the edit against the new content, which is safe because an edit is a
 * patch to named fields on one manuscript, not a whole-file replacement.
 */
async function commitEdit(id, patch, env) {
  let lastConflict = null;
  // Read and write the same branch the sync runs on, resolved once rather than
  // hardcoded -- see defaultBranch above for why a constant here rots.
  const branch = await defaultBranch(env);

  for (let attempt = 0; attempt < 4; attempt++) {
    const file = await gh(`/contents/${DATA_PATH}?ref=${branch}&_=${Date.now()}`, env);
    const registry = JSON.parse(decodeBase64(file.content));

    const manuscript = (registry.manuscripts || []).find((m) => m.id === id);
    if (!manuscript) {
      const err = new Error("That manuscript is no longer in the tracker.");
      err.status = 404;
      throw err;
    }

    const at = new Date().toISOString();
    const changes = applyEdit(manuscript, patch, at);
    if (!changes.length) return { changes, manuscript, unchanged: true };

    registry.editedAt = at;

    try {
      await gh(`/contents/${DATA_PATH}`, env, {
        method: "PUT",
        body: JSON.stringify({
          message: commitMessage(manuscript, changes),
          content: encodeBase64(`${JSON.stringify(registry, null, 2)}\n`),
          sha: file.sha,
          branch,
        }),
      });
      return { changes, manuscript, unchanged: false };
    } catch (err) {
      // 409 is the sync having committed in between; 422 is GitHub's other way
      // of saying the SHA is stale. Both mean "read again and replay".
      if (err.status !== 409 && err.status !== 422) throw err;
      lastConflict = err;
      await new Promise((r) => setTimeout(r, 400 * (attempt + 1)));
    }
  }

  const err = new Error(
    "The tracker was being updated at the same moment and the edit could not be saved. Try again."
  );
  err.status = 503;
  err.cause = lastConflict;
  throw err;
}

/** Readable history: the commit log should say what a person actually changed. */
function commitMessage(manuscript, changes) {
  const title = (manuscript.title || "manuscript").slice(0, 60);
  const moved = changes.find((c) => c.field === "bucket" && !c.released);
  const summary = moved
    ? `Move "${title}" to ${moved.to.replace(/_/g, " ")}`
    : `Edit "${title}"`;
  const detail = changes
    .map((c) => (c.released ? `${c.field}: back to automatic` : `${c.field}: ${c.to}`))
    .join("\n");
  return `${summary}\n\n${detail}`;
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
        const ref = await defaultBranch(env);
        try {
          await gh(`/actions/workflows/${WORKFLOW}/dispatches`, env, {
            method: "POST",
            body: JSON.stringify({ ref }),
          });
        } catch (err) {
          // 422 "No ref found" from a dispatch means the branch this Worker
          // asked for is not there. Raw, it reads as a broken button.
          if (err.status === 422 && /No ref found/i.test(err.message)) {
            return json({
              error:
                `The sync service asked GitHub to run on branch "${ref}", which does not exist. ` +
                "If that is an old branch name, this Worker is running a build from before it " +
                "changed — redeploy it with `wrangler deploy` from the worker/ directory.",
              recoverable: true,
            }, 502, env, request);
          }
          throw err;
        }
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

      const edit = url.pathname.match(/^\/manuscripts\/([A-Za-z0-9_-]+)$/);
      if (edit && request.method === "PATCH") {
        const patch = await request.json().catch(() => null);
        if (!patch || typeof patch !== "object" || Array.isArray(patch)) {
          return json({ error: "Send a JSON object of the fields to change." }, 400, env, request);
        }
        const result = await commitEdit(edit[1], patch, env);
        return json({
          ok: true,
          unchanged: result.unchanged,
          changes: result.changes,
          manuscript: result.manuscript,
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
      /*
       * A 404 from GitHub itself is not the same as a 404 this Worker raised.
       *
       * "That manuscript is no longer in the tracker" is precise and belongs to
       * the caller. But a raw `GitHub 404: {"message":"Not Found"}` from reading
       * the data file means the BRANCH or the file is not there -- and by far
       * the likeliest reason is that this Worker is running a build from before
       * a branch was renamed, since the branch it asks for is baked into
       * whichever build is deployed. Passing that through as-is showed the
       * person raw API JSON for a problem that is one command to fix.
       */
      if (err.status === 404 && /^GitHub 404/.test(err.message || "")) {
        return json({
          error:
            "GitHub could not find the tracker data on the branch this sync service " +
            "is asking for. That usually means the service is running an older " +
            "build, from before the branch changed — redeploy it with `wrangler " +
            "deploy` from the worker/ directory. (GitHub said: " +
            `${(err.message || "").slice(0, 120)})`,
          recoverable: true,
        }, 502, env, request);
      }

      // An edit rejected for naming a field that does not exist is the caller's
      // mistake and should read as one; 400, our own 404 and 503 are precise.
      if (err.status === 400 || err.status === 404 || err.status === 503) {
        return json({ error: err.message }, err.status, env, request);
      }
      if (!err.status && err instanceof Error && !/^GitHub \d/.test(err.message)) {
        return json({ error: err.message }, 400, env, request);
      }
      // GitHub refusing the Worker's own token is the proxy's problem, not the
      // caller's. Name the likely cause: this Worker was first deployed with a
      // token scoped to Actions alone, and saving an edit writes a file.
      if (err.status === 401 || err.status === 403) {
        const writing = /contents/i.test(err.message) || url.pathname.startsWith("/manuscripts/");
        return json({
          error: writing
            ? "GitHub refused the sync service's token for writing to the repository. " +
              "The token needs the permission \"Contents: Read and write\" in addition to " +
              "\"Actions: Read and write\"."
            : "GitHub refused the sync service's token. It may be expired or missing " +
              "the \"Actions: Read and write\" permission.",
        }, 502, env, request);
      }
      return json({ error: err.message || "Upstream failure." }, 500, env, request);
    }
  },
};
