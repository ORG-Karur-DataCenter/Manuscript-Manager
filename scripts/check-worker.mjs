#!/usr/bin/env node
/**
 * Checks the sync proxy without deploying it.
 *
 * The Worker is the one piece of this system that cannot be tried out by
 * running the app: it lives on Cloudflare, holds the only GitHub token, and
 * writing to it means writing to the real repository. So it gets exercised
 * here instead — its fetch handler is imported directly and GitHub is replaced
 * by a stub that records what the Worker asked for.
 *
 * What this is really guarding is the edit path. Two people can have the
 * dashboard open while the three-hourly sync rewrites the same file, and a
 * lost update there means someone's correction silently disappears. The
 * conflict cases below are the point of the file.
 *
 *   node scripts/check-worker.mjs
 */
import worker from "../worker/src/index.js";
import { applyEdit as applyEditInSync, OVERRIDABLE } from "./lib/registry.mjs";

const PASSWORD = "test-password";
const TOKEN = "github_pat_SECRET_MUST_NOT_LEAK";
const BRANCH = "main";

let passed = 0;
const failures = [];

function check(name, fn) {
  return Promise.resolve()
    .then(fn)
    .then(() => { passed++; })
    .catch((err) => { failures.push(`${name}\n    ${err.message}`); });
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

const registryWith = (...manuscripts) => ({
  generatedAt: "2026-08-26T19:54:00.000Z",
  manuscripts: manuscripts.map((m) => ({
    id: m.id || "m1",
    title: m.title || "A Paper About Knees",
    titleNormalized: "a paper about knees",
    bucket: m.bucket || "submissions",
    currentJournal: m.currentJournal || "Journal of Orthopaedics",
    currentStatus: m.currentStatus || "Submitted",
    events: [],
    ...m,
  })),
});

const b64 = (text) => Buffer.from(text, "utf8").toString("base64");
const fromB64 = (text) => Buffer.from(text, "base64").toString("utf8");

/**
 * Stands in for api.github.com. `plan` lets a test say what the write should do
 * on each attempt — "conflict" makes GitHub reject the blob SHA the way it does
 * when the sync has committed in between.
 */
function stubGitHub({ registry, sha = "sha-1", plan = [] } = {}) {
  const calls = [];
  let current = registry;
  let currentSha = sha;
  let attempt = 0;

  globalThis.fetch = async (url, options = {}) => {
    const path = new URL(url).pathname;
    calls.push({ path, method: options.method || "GET", options });

    if (path.endsWith("/contents/data/manuscripts.json") && (options.method || "GET") === "GET") {
      return new Response(JSON.stringify({ content: b64(JSON.stringify(current)), sha: currentSha }), {
        status: 200,
      });
    }

    if (path.endsWith("/contents/data/manuscripts.json") && options.method === "PUT") {
      const body = JSON.parse(options.body);
      const outcome = plan[attempt++] || "ok";

      if (outcome === "conflict") {
        // What GitHub actually does when the file has moved on: it rejects the
        // stale SHA. Advance the stored file too, so the retry has to re-read.
        currentSha = `sha-${attempt + 1}`;
        return new Response(JSON.stringify({ message: "does not match" }), { status: 409 });
      }
      if (outcome === "forbidden") {
        return new Response(JSON.stringify({ message: "Resource not accessible by personal access token" }), {
          status: 403,
        });
      }
      assert(body.sha === currentSha, `write used SHA ${body.sha}, expected ${currentSha}`);
      current = JSON.parse(fromB64(body.content));
      currentSha = `sha-written-${attempt}`;
      return new Response(JSON.stringify({ commit: { sha: "abc123" } }), { status: 200 });
    }

    return new Response(JSON.stringify({ workflow_runs: [] }), { status: 200 });
  };

  return { calls, written: () => current };
}

const env = { GITHUB_TOKEN: TOKEN, APP_PASSWORD: PASSWORD, ALLOWED_ORIGIN: "*" };

function patchRequest(id, patch, { password = PASSWORD } = {}) {
  return new Request(`https://proxy.test/manuscripts/${id}`, {
    method: "PATCH",
    headers: { Authorization: `Bearer ${password}`, "Content-Type": "application/json" },
    body: JSON.stringify(patch),
  });
}

const call = (request, e = env) => worker.fetch(request, e);

// --- the password gate ------------------------------------------------------

await check("an edit without the password is refused", async () => {
  stubGitHub({ registry: registryWith({}) });
  const res = await call(new Request("https://proxy.test/manuscripts/m1", {
    method: "PATCH",
    body: JSON.stringify({ bucket: "in_review" }),
  }));
  assert(res.status === 401, `expected 401, got ${res.status}`);
});

await check("a wrong password is refused", async () => {
  stubGitHub({ registry: registryWith({}) });
  const res = await call(patchRequest("m1", { bucket: "in_review" }, { password: "wrong" }));
  assert(res.status === 401, `expected 401, got ${res.status}`);
});

await check("no response body ever contains the GitHub token", async () => {
  const paths = ["/health", "/manuscripts/m1", "/sync", "/sync/12345", "/nope"];
  for (const path of paths) {
    for (const method of ["GET", "POST", "PATCH"]) {
      stubGitHub({ registry: registryWith({}) });
      const res = await call(new Request(`https://proxy.test${path}`, {
        method,
        headers: { Authorization: `Bearer ${PASSWORD}` },
        ...(method === "GET" ? {} : { body: JSON.stringify({ bucket: "in_review" }) }),
      }));
      const text = await res.text();
      assert(!text.includes(TOKEN), `${method} ${path} leaked the token`);
      assert(!text.includes("github_pat_"), `${method} ${path} leaked something token-shaped`);
    }
  }
});

// --- editing ----------------------------------------------------------------

await check("an edit is committed and pins the field", async () => {
  const gh = stubGitHub({ registry: registryWith({}) });
  const res = await call(patchRequest("m1", { title: "A Properly Corrected Title" }));
  assert(res.status === 200, `expected 200, got ${res.status}`);

  const saved = gh.written().manuscripts[0];
  assert(saved.title === "A Properly Corrected Title", `title is ${saved.title}`);
  assert(saved.overrides.title === "A Properly Corrected Title", "the field was not pinned");
});

await check("a rename keeps the old title as an alias", async () => {
  const gh = stubGitHub({ registry: registryWith({ title: "Origional Title From The Journal" }) });
  await call(patchRequest("m1", { title: "Original Title From The Journal" }));

  const saved = gh.written().manuscripts[0];
  assert(
    (saved.titleAliases || []).includes("Origional Title From The Journal"),
    "the previous title was not kept as an alias, so future emails would split the record"
  );
});

await check("moving to a section pins the bucket and clears the action flag", async () => {
  const gh = stubGitHub({
    registry: registryWith({ bucket: "needs_action", actionFlag: true, needsActionReason: "Revision requested" }),
  });
  const res = await call(patchRequest("m1", { bucket: "in_review" }));
  assert(res.status === 200, `expected 200, got ${res.status}`);

  const saved = gh.written().manuscripts[0];
  assert(saved.bucket === "in_review", `bucket is ${saved.bucket}`);
  assert(saved.overrides.bucket === "in_review", "the move was not pinned");
  assert(saved.actionFlag === false, "the action flag survived the move");
  assert(saved.needsActionReason === null, "the action reason survived the move");
});

await check("an edit is recorded in the manuscript's own history", async () => {
  const gh = stubGitHub({ registry: registryWith({}) });
  await call(patchRequest("m1", { currentStatus: "With editor" }));

  const saved = gh.written().manuscripts[0];
  assert(saved.edits.length === 1, `expected 1 edit, got ${saved.edits.length}`);
  assert(saved.edits[0].changes[0].field === "currentStatus", "the change was not described");
  assert(saved.edits[0].changes[0].from === "Submitted", "the previous value was not kept");
  assert(saved.editedAt, "editedAt was not set");
});

await check("an empty value releases the field back to automatic", async () => {
  const gh = stubGitHub({
    registry: registryWith({ overrides: { bucket: "in_review" }, bucket: "in_review" }),
  });
  await call(patchRequest("m1", { bucket: "" }));

  const saved = gh.written().manuscripts[0];
  assert(!("bucket" in (saved.overrides || {})), "the pin was not released");
  assert(saved.edits[0].changes[0].released === true, "the release was not recorded");
});

await check("a field nobody may edit is refused", async () => {
  stubGitHub({ registry: registryWith({}) });
  const res = await call(patchRequest("m1", { events: [] }));
  assert(res.status === 400, `expected 400, got ${res.status}`);
  const body = await res.json();
  assert(/events/.test(body.error), `unhelpful message: ${body.error}`);
});

await check("a section that does not exist is refused", async () => {
  stubGitHub({ registry: registryWith({}) });
  const res = await call(patchRequest("m1", { bucket: "somewhere_else" }));
  assert(res.status === 400, `expected 400, got ${res.status}`);
});

await check("editing a manuscript that is gone says so", async () => {
  stubGitHub({ registry: registryWith({}) });
  const res = await call(patchRequest("does-not-exist", { bucket: "in_review" }));
  assert(res.status === 404, `expected 404, got ${res.status}`);
});

await check("an edit that changes nothing does not commit", async () => {
  const gh = stubGitHub({
    registry: registryWith({ overrides: { currentStatus: "Submitted" } }),
  });
  const res = await call(patchRequest("m1", { currentStatus: "Submitted" }));
  assert(res.status === 200, `expected 200, got ${res.status}`);
  assert((await res.json()).unchanged === true, "an empty edit was not reported as such");
  assert(!gh.calls.some((c) => c.method === "PUT"), "an empty edit still wrote a commit");
});

await check("a title with characters outside ASCII survives the round trip", async () => {
  const gh = stubGitHub({ registry: registryWith({}) });
  const title = "Outcomes in Müller–Weiss Disease: a 5° Correction — Königsberg et al.";
  await call(patchRequest("m1", { title }));
  assert(gh.written().manuscripts[0].title === title, "the title was mangled by base64");
});

// --- the collision this exists for -----------------------------------------

await check("a sync committing mid-edit is retried, not lost", async () => {
  const gh = stubGitHub({ registry: registryWith({}), plan: ["conflict", "ok"] });
  const res = await call(patchRequest("m1", { bucket: "published" }));
  assert(res.status === 200, `expected 200, got ${res.status}`);
  assert(gh.written().manuscripts[0].bucket === "published", "the edit was lost to the conflict");

  const reads = gh.calls.filter((c) => c.method === "GET" && c.path.includes("/contents/")).length;
  assert(reads === 2, `expected a re-read after the conflict, saw ${reads} reads`);
});

await check("the retry replays onto the newest file, not a stale copy", async () => {
  // The sync's own commit has to survive the edit. If the Worker replayed onto
  // the copy it read first, whatever the sync just wrote would be erased.
  const gh = stubGitHub({ registry: registryWith({}), plan: ["conflict", "ok"] });
  const original = globalThis.fetch;
  let served = 0;
  globalThis.fetch = async (url, options = {}) => {
    const path = new URL(url).pathname;
    if (path.endsWith("/contents/data/manuscripts.json") && (options.method || "GET") === "GET") {
      served++;
      // Second read carries a new event the sync added while the edit was in flight.
      const registry = registryWith(served > 1 ? { events: [{ id: "e-from-sync" }] } : {});
      return new Response(
        JSON.stringify({ content: b64(JSON.stringify(registry)), sha: served > 1 ? "sha-2" : "sha-1" }),
        { status: 200 }
      );
    }
    return original(url, options);
  };

  await call(patchRequest("m1", { bucket: "published" }));
  const saved = gh.written().manuscripts[0];
  assert(saved.bucket === "published", "the edit was lost");
  assert(saved.events.length === 1 && saved.events[0].id === "e-from-sync",
    "the retry overwrote what the sync had just committed");
});

await check("persistent conflicts give up with something a person can act on", async () => {
  stubGitHub({ registry: registryWith({}), plan: ["conflict", "conflict", "conflict", "conflict"] });
  const res = await call(patchRequest("m1", { bucket: "published" }));
  assert(res.status === 503, `expected 503, got ${res.status}`);
  assert(/try again/i.test((await res.json()).error), "the message does not say what to do");
});

// --- the token permission this Worker was not originally given --------------

await check("a token missing Contents write says exactly that", async () => {
  stubGitHub({ registry: registryWith({}), plan: ["forbidden"] });
  const res = await call(patchRequest("m1", { bucket: "published" }));
  assert(res.status === 502, `expected 502, got ${res.status}`);
  const body = await res.json();
  assert(/Contents: Read and write/.test(body.error), `unhelpful message: ${body.error}`);
});

// --- the two copies of the edit rules must not drift apart ------------------

await check("the Worker edits a manuscript exactly as the sync would", async () => {
  // The Worker is deployed on its own and cannot import registry.mjs, so the
  // edit rules exist twice. That is a standing hazard: the sync and the
  // dashboard would start disagreeing about what an edit means, and nothing
  // would say so. This runs the same patches through both and compares.
  const patches = [
    { title: "A Renamed Paper" },
    { bucket: "published" },
    { bucket: "" },
    { currentStatus: "With editor", currentJournal: "Somewhere Else" },
    { doi: "10.1234/x", publicationLink: "https://example.org/a" },
    { notes: "Rang the editor on the 14th." },
    { title: "  Padded, Then Trimmed  " },
  ];

  for (const patch of patches) {
    const base = () => registryWith({
      overrides: { bucket: "needs_action" },
      bucket: "needs_action",
      actionFlag: true,
      needsActionReason: "rejected_needs_resubmission",
      titleAliases: ["An Even Older Title"],
    }).manuscripts[0];

    const gh = stubGitHub({ registry: { manuscripts: [base()] } });
    const res = await call(patchRequest("m1", patch));
    assert(res.status === 200, `${JSON.stringify(patch)} returned ${res.status}`);
    const viaWorker = gh.written().manuscripts[0];

    const viaSync = base();
    applyEditInSync(viaSync, patch, { at: viaWorker.editedAt || "x", by: "dashboard" });

    // editedAt is a wall clock and will differ by milliseconds; everything
    // else has to match, edit history included.
    const strip = (m) => JSON.stringify({ ...m, editedAt: null }, Object.keys(m).sort());
    assert(
      strip(viaWorker) === strip(viaSync),
      `the Worker and the sync disagree about ${JSON.stringify(patch)}:\n` +
      `      worker: ${strip(viaWorker)}\n      sync:   ${strip(viaSync)}`
    );
  }
});

await check("the Worker allows exactly the fields the sync protects", async () => {
  const stub = await import("../worker/src/index.js");
  // Not exported, so it is read out of the source -- a mismatch here is the
  // silent failure this whole pair of checks exists to catch.
  const source = await (await import("node:fs/promises")).readFile(
    new URL("../worker/src/index.js", import.meta.url), "utf8"
  );
  const block = source.match(/const OVERRIDABLE = \[([^\]]+)\]/);
  assert(block, "the Worker no longer declares OVERRIDABLE in a readable form");
  const inWorker = [...block[1].matchAll(/"([^"]+)"/g)].map((m) => m[1]).sort();
  assert(
    inWorker.join(",") === [...OVERRIDABLE].sort().join(","),
    `the editable fields have drifted:\n      worker: ${inWorker}\n      sync:   ${[...OVERRIDABLE].sort()}`
  );
  assert(stub.default, "the Worker no longer has a default export");
});

// --- the endpoints that already existed -------------------------------------

await check("health reports a missing secret by name", async () => {
  stubGitHub({ registry: registryWith({}) });
  const res = await call(new Request("https://proxy.test/health"), { APP_PASSWORD: PASSWORD });
  const body = await res.json();
  assert(body.configured === false, "an unconfigured Worker reported itself as configured");
  assert(body.missing.includes("GITHUB_TOKEN"), `missing is ${JSON.stringify(body.missing)}`);
});

await check("a browser preflight is answered", async () => {
  stubGitHub({ registry: registryWith({}) });
  const res = await call(new Request("https://proxy.test/manuscripts/m1", {
    method: "OPTIONS",
    headers: { Origin: "https://org-karur-datacenter.github.io" },
  }));
  assert(res.status === 204, `expected 204, got ${res.status}`);
  assert(/PATCH/.test(res.headers.get("Access-Control-Allow-Methods") || ""),
    "PATCH is not allowed, so the browser will block every edit");
});

await check("edits are written to the branch the dashboard reads", async () => {
  const gh = stubGitHub({ registry: registryWith({}) });
  await call(patchRequest("m1", { bucket: "published" }));
  const put = gh.calls.find((c) => c.method === "PUT");
  assert(JSON.parse(put.options.body).branch === BRANCH, "the edit went to the wrong branch");
});

// ---------------------------------------------------------------------------

if (failures.length) {
  console.error(`\n${failures.length} of ${passed + failures.length} worker checks failed:\n`);
  for (const f of failures) console.error(`  ✗ ${f}\n`);
  process.exit(1);
}
console.log(`✓ all ${passed} worker checks passed`);
