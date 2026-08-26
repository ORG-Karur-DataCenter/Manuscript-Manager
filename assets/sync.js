/**
 * "Sync now" — run the Gmail sync on demand instead of waiting for the
 * three-hourly schedule.
 *
 * HOW THIS HAS TO WORK, AND WHY. The page is static; there is no server here
 * that could run a sync. The sync runs as a GitHub Actions workflow, which is
 * also the only place the Gmail refresh tokens exist. So this button asks
 * GitHub to start that workflow, then watches it.
 *
 * Starting a workflow is a write, and a write needs a token. That token can
 * never live in this repository: the repository is public, so committing one
 * would publish it to the world and GitHub would revoke it within minutes
 * anyway. Instead each person supplies their own, once, and it is kept in that
 * browser's localStorage and sent only to api.github.com.
 *
 * Scope matters. Ask for a FINE-GRAINED token, this repository only, with the
 * single permission "Actions: Read and write". A token like that can start and
 * watch workflow runs and nothing else — it cannot read the repository's
 * secrets, push code, or touch any other repository. A classic token with
 * "repo" scope would hand over far more; do not use one.
 */

const OWNER = "ORG-Karur-DataCenter";
const REPO = "Manuscript-Manager";
const WORKFLOW = "sync-manuscripts.yml";
const BRANCH = "claude/manuscript-tracking-app-jhj4p7";
const TOKEN_KEY = "orgkarur.ghtoken";
const API = `https://api.github.com/repos/${OWNER}/${REPO}`;

// Falls back to the observed duration of a normal run until real history is
// available; runs have been taking two to three minutes.
const FALLBACK_SECONDS = 165;

const getToken = () => { try { return localStorage.getItem(TOKEN_KEY) || ""; } catch { return ""; } };
export const hasToken = () => Boolean(getToken());
export function setToken(value) {
  try {
    if (value) localStorage.setItem(TOKEN_KEY, value.trim());
    else localStorage.removeItem(TOKEN_KEY);
  } catch { /* storage refused; the button will simply ask again */ }
}

async function api(path, options = {}) {
  const token = getToken();
  const res = await fetch(`${API}${path}`, {
    ...options,
    headers: {
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(options.body ? { "Content-Type": "application/json" } : {}),
    },
  });
  if (res.status === 401 || res.status === 403) {
    const err = new Error("GitHub rejected the token. It may be expired, or missing the Actions permission.");
    err.code = "auth";
    throw err;
  }
  if (!res.ok && res.status !== 204) {
    throw new Error(`GitHub returned ${res.status}. ${(await res.text()).slice(0, 140)}`);
  }
  return res.status === 204 ? null : res.json();
}

/**
 * Estimate from what this workflow actually does, not a guess: the median of
 * recent successful runs. Median rather than mean so one stuck run that sat in
 * a queue for ten minutes does not distort every future estimate.
 */
async function estimateSeconds() {
  try {
    const data = await api(`/actions/workflows/${WORKFLOW}/runs?status=success&per_page=10`);
    const durations = (data.workflow_runs || [])
      .map((r) => (new Date(r.updated_at) - new Date(r.run_started_at)) / 1000)
      .filter((s) => s > 5 && s < 3600)
      .sort((a, b) => a - b);
    if (!durations.length) return FALLBACK_SECONDS;
    return Math.round(durations[Math.floor(durations.length / 2)]);
  } catch {
    return FALLBACK_SECONDS;
  }
}

/**
 * A dispatch returns 204 with no body, so the new run has to be found by
 * looking for one that started after the request went out. GitHub can take a
 * few seconds to register it.
 */
async function findRunSince(startedAfter, attempts = 12) {
  for (let i = 0; i < attempts; i++) {
    const data = await api(`/actions/workflows/${WORKFLOW}/runs?per_page=5`);
    const run = (data.workflow_runs || []).find(
      (r) => new Date(r.created_at).getTime() >= startedAfter - 15000
    );
    if (run) return run;
    await new Promise((r) => setTimeout(r, 2500));
  }
  throw new Error("The run was started but could not be found. Check the Actions tab.");
}

/**
 * Runs a sync and reports progress.
 * onProgress({ phase, elapsed, estimate, remaining, fraction })
 */
export async function runSync(onProgress) {
  const requestedAt = Date.now();
  const estimate = await estimateSeconds();

  onProgress({ phase: "starting", elapsed: 0, estimate, remaining: estimate, fraction: 0 });

  await api(`/actions/workflows/${WORKFLOW}/dispatches`, {
    method: "POST",
    body: JSON.stringify({ ref: BRANCH }),
  });

  const run = await findRunSince(requestedAt);
  const startedAt = new Date(run.run_started_at || run.created_at).getTime();

  let ticker = null;
  const tick = (phase) => {
    const elapsed = Math.round((Date.now() - startedAt) / 1000);
    // Never show a countdown that has run out while the job is still going —
    // an estimate that says "0s left" for a minute reads as a hang. Hold at a
    // few seconds and let the real completion end it.
    const remaining = Math.max(estimate - elapsed, elapsed > estimate ? 5 : 0);
    const fraction = Math.min(elapsed / Math.max(estimate, 1), 0.97);
    onProgress({ phase, elapsed, estimate, remaining, fraction });
  };

  try {
    ticker = setInterval(() => tick("running"), 1000);
    tick("running");

    for (;;) {
      await new Promise((r) => setTimeout(r, 5000));
      const current = await api(`/actions/runs/${run.id}`);
      if (current.status === "completed") {
        clearInterval(ticker);
        const elapsed = Math.round((Date.now() - startedAt) / 1000);
        if (current.conclusion !== "success") {
          const err = new Error(`The sync run finished as "${current.conclusion}".`);
          err.runUrl = current.html_url;
          throw err;
        }
        onProgress({ phase: "done", elapsed, estimate, remaining: 0, fraction: 1 });
        return { elapsed, runUrl: current.html_url };
      }
    }
  } finally {
    if (ticker) clearInterval(ticker);
  }
}

/**
 * The workflow commits its results, and this page reads plain files, so the
 * fresh data only appears once the commit is actually being served. Poll for
 * a changed generatedAt rather than reloading blind.
 */
export async function waitForFreshData(previousGeneratedAt, timeoutMs = 90000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch("data/manuscripts.json?_=" + Date.now(), { cache: "no-store" });
      const data = await res.json();
      if (data.generatedAt && data.generatedAt !== previousGeneratedAt) return data;
    } catch {
      // A transient failure mid-deploy is expected; keep waiting.
    }
    await new Promise((r) => setTimeout(r, 4000));
  }
  return null;
}
