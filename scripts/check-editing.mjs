#!/usr/bin/env node
/**
 * Drives the edit feature in a real browser, end to end.
 *
 * check-worker.mjs proves the Worker's half and check-registry.mjs proves the
 * sync's half, but neither touches the part a person actually uses: the lock
 * screen, the drawer, the form, and the four network hops between them. This
 * runs the genuine index.html against the genuine worker/src/index.js, with
 * only GitHub itself replaced by an in-memory file.
 *
 * The proxy is served from a second port on purpose, so the browser has to do
 * a real cross-origin preflight — a CORS mistake would otherwise only show up
 * once it was deployed.
 *
 *   node scripts/check-editing.mjs
 */
import http from "node:http";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import worker from "../worker/src/index.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PASSWORD = "orgkarur2026";

let chromium;
try {
  ({ chromium } = await import("playwright"));
} catch {
  console.log("· playwright is not installed; skipping the browser checks");
  process.exit(0);
}

// --- the data the page will see --------------------------------------------

let registry = {
  generatedAt: new Date().toISOString(),
  manuscripts: [
    {
      id: "m-knees",
      title: "Origional Title As The Journal Typed It",
      titleNormalized: "origional title as the journal typed it",
      bucket: "submissions",
      currentJournal: "Journal of Experimental Orthopaedics",
      currentStatus: "Submitted",
      currentManuscriptNumber: "JEO-1234",
      authorAccounts: ["sathish@example.org"],
      createdAt: "2026-03-01T10:00:00.000Z",
      updatedAt: "2026-08-20T10:00:00.000Z",
      submissions: [
        { journal: "Journal of Experimental Orthopaedics", submittedDate: "2026-03-01T10:00:00.000Z", manuscriptNumber: "JEO-1234", outcome: "active" },
      ],
      timeline: [{ eventType: "new_submission", timestamp: "2026-03-01T10:00:00.000Z", journal: "Journal of Experimental Orthopaedics" }],
      events: [],
    },
    {
      id: "m-amend",
      title: "An Amendment The Editorial Office Wants Back",
      titleNormalized: "an amendment the editorial office wants back",
      bucket: "needs_action",
      needsActionReason: "pre_review_edits",
      actionFlag: true,
      actionLabel: "Amendments requested",
      currentJournal: "International Orthopaedics",
      // Four days out, estimated rather than stated -- the case that must never
      // read as though the journal set the date.
      deadline: new Date(Date.now() + 4 * 86400000).toISOString(),
      deadlineSource: "assumed",
      authorAccounts: ["sathish@example.org"],
      createdAt: "2026-08-01T10:00:00.000Z",
      updatedAt: "2026-08-24T10:00:00.000Z",
      submissions: [],
      timeline: [{ eventType: "sent_back", timestamp: "2026-08-24T10:00:00.000Z", journal: "International Orthopaedics", note: "Returned after technical check." }],
      events: [],
    },
    {
      id: "m-hips",
      title: "A Second Paper, Left Alone",
      titleNormalized: "a second paper left alone",
      bucket: "in_review",
      currentJournal: "Bone & Joint",
      currentStatus: "Under review",
      authorAccounts: ["sathish@example.org"],
      createdAt: "2026-04-01T10:00:00.000Z",
      updatedAt: "2026-08-01T10:00:00.000Z",
      submissions: [],
      timeline: [],
      events: [],
    },
  ],
};

// --- GitHub, in memory ------------------------------------------------------

let blobSha = "sha-1";
const b64 = (s) => Buffer.from(s, "utf8").toString("base64");

globalThis.fetch = async (url, options = {}) => {
  const { pathname } = new URL(url);
  if (pathname.endsWith("/contents/data/manuscripts.json")) {
    if ((options.method || "GET") === "GET") {
      return new Response(JSON.stringify({ content: b64(JSON.stringify(registry)), sha: blobSha }), { status: 200 });
    }
    const body = JSON.parse(options.body);
    if (body.sha !== blobSha) return new Response("{}", { status: 409 });
    registry = JSON.parse(Buffer.from(body.content, "base64").toString("utf8"));
    blobSha = `sha-${Number(blobSha.split("-")[1]) + 1}`;
    return new Response(JSON.stringify({ commit: { sha: "deadbeef" } }), { status: 200 });
  }
  return new Response(JSON.stringify({ workflow_runs: [] }), { status: 200 });
};

// --- the two servers --------------------------------------------------------

const TYPES = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".json": "application/json" };

/** Serves the site, with config.json answered from memory so nothing is written into the repo. */
function siteServer(proxyUrl) {
  return http.createServer(async (req, res) => {
    const url = new URL(req.url, "http://x");
    let rel = url.pathname === "/" ? "/index.html" : url.pathname;

    // The browser asks for one unprompted; a 404 would show up as a console
    // error and mask a real one.
    if (rel === "/favicon.ico") return res.writeHead(204).end();

    if (rel === "/assets/config.json") {
      res.writeHead(200, { "Content-Type": "application/json" });
      return res.end(JSON.stringify({ syncProxyUrl: proxyUrl }));
    }
    // The page reads its data from a file; serve the live in-memory copy so
    // a reload reflects what the Worker committed.
    if (rel === "/data/manuscripts.json") {
      res.writeHead(200, { "Content-Type": "application/json" });
      return res.end(JSON.stringify(registry));
    }
    if (rel === "/data/review-queue.json") {
      res.writeHead(200, { "Content-Type": "application/json" });
      return res.end(JSON.stringify({ review: [] }));
    }
    try {
      const body = await fs.readFile(path.join(ROOT, rel));
      res.writeHead(200, { "Content-Type": TYPES[path.extname(rel)] || "application/octet-stream" });
      res.end(body);
    } catch {
      res.writeHead(404).end("not found");
    }
  });
}

/** Bridges Node's http server to the Worker's fetch handler. */
function proxyServer(env) {
  return http.createServer(async (req, res) => {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const request = new Request(`http://127.0.0.1${req.url}`, {
      method: req.method,
      headers: req.headers,
      ...(chunks.length ? { body: Buffer.concat(chunks) } : {}),
    });
    const out = await worker.fetch(request, env);
    res.writeHead(out.status, Object.fromEntries(out.headers));
    res.end(Buffer.from(await out.arrayBuffer()));
  });
}

const listen = (server) =>
  new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(server.address().port)));

const proxy = proxyServer({
  GITHUB_TOKEN: "github_pat_TEST",
  APP_PASSWORD: PASSWORD,
  ALLOWED_ORIGIN: "*",
});
const proxyPort = await listen(proxy);
const site = siteServer(`http://127.0.0.1:${proxyPort}`);
const sitePort = await listen(site);
const BASE = `http://127.0.0.1:${sitePort}`;

// --- the checks -------------------------------------------------------------

let passed = 0;
const failures = [];
const assert = (cond, msg) => { if (!cond) throw new Error(msg); };

// This sandbox ships a Chromium at a fixed path; elsewhere (CI, a laptop)
// Playwright knows where its own download is.
const SANDBOX_CHROME = "/opt/pw-browsers/chromium";
const preinstalled = await fs.access(SANDBOX_CHROME).then(() => true, () => false);

let browser;
try {
  browser = await chromium.launch(preinstalled ? { executablePath: SANDBOX_CHROME } : {});
} catch (err) {
  console.log(`· no browser available (${err.message.split("\n")[0]}); skipping the browser checks`);
  site.close();
  proxy.close();
  process.exit(0);
}

/**
 * `expectErrors` marks the checks that deliberately provoke a failure. Every
 * other check asserts the page stayed quiet, which is how a broken import or a
 * typo in a selector gets caught rather than passing silently.
 */
async function check(name, fn, { expectErrors = false } = {}) {
  const context = await browser.newContext();
  const page = await context.newPage();
  const errors = [];
  // Fonts come from Google and this sandbox has no route to them; that is the
  // environment, not the app.
  const ours = (t) => !/fonts\.(googleapis|gstatic)\.com|ERR_CONNECTION_RESET|favicon/.test(t);
  page.on("console", (m) => { if (m.type() === "error" && ours(m.text())) errors.push(m.text()); });
  page.on("pageerror", (e) => { if (ours(String(e))) errors.push(String(e)); });
  try {
    await page.goto(BASE);
    await unlock(page);
    await fn(page);
    if (!expectErrors) assert(!errors.length, `the page logged errors: ${errors.join(" | ")}`);
    passed++;
  } catch (err) {
    failures.push(`${name}\n    ${err.message}`);
  } finally {
    await context.close();
  }
}

/** Tolerates an already-unlocked page: "stay signed in" survives a reload. */
async function unlock(page) {
  // The gate decides asynchronously whether to show itself; wait for whichever
  // answer it reaches rather than racing it.
  await page.waitForFunction(() =>
    !document.body.classList.contains("locked") ||
    !document.getElementById("lock-screen").hidden
  );
  if (await page.isVisible("#lock-screen")) {
    await page.fill("#lock-password", PASSWORD);
    await page.click(".lock-btn");
  }
  await page.waitForSelector("#cards .card");
}

const addDays = (yyyymmdd, n) =>
  new Date(Date.parse(`${yyyymmdd}T00:00:00Z`) + n * 86400000).toISOString().slice(0, 10);
/** End-of-day in +05:30 lands on the same UTC date; guard the boundary anyway. */
const nextDay = (yyyymmdd) => addDays(yyyymmdd, 1);

const openFirst = async (page) => {
  // Saving leaves the drawer open on the detail view, so a second edit in the
  // same check must not try to click a card the overlay is covering.
  if (await page.isHidden("#drawer")) await page.click('.card[data-id="m-knees"]');
  await page.waitForSelector("#drawer:not([hidden])");
};
const startEditing = async (page) => {
  await openFirst(page);
  await page.click("#drawer-edit");
  await page.waitForSelector("#edit-form");
};
const save = async (page) => {
  await page.click("#edit-save");
  await page.waitForSelector("#edit-form", { state: "detached" });
};

await check("an amendment shows how long is left, and says the date is an estimate", async (page) => {
  const chip = await page.textContent('.card[data-id="m-amend"] .deadline-chip');
  assert(/4 days left/.test(chip), `the card reads "${chip}"`);
  assert(/\*/.test(chip), "an estimated date is not marked as one on the card");

  const title = await page.getAttribute('.card[data-id="m-amend"] .deadline-chip', "title");
  assert(/Estimated/i.test(title), `the explanation does not admit it is a guess: ${title}`);

  await page.click('.card[data-id="m-amend"]');
  await page.waitForSelector("#drawer:not([hidden])");
  const drawer = await page.textContent("#drawer-body");
  assert(/Due back/.test(drawer), "the drawer does not show the deadline");
  assert(/did not give a date/.test(drawer), "the drawer passes an estimate off as the journal's");
});

await check("a deadline can be corrected by hand, and stops being an estimate", async (page) => {
  await page.click('.card[data-id="m-amend"]');
  await page.waitForSelector("#drawer:not([hidden])");
  await page.click("#drawer-edit");
  await page.waitForSelector("#edit-form");

  const box = await page.inputValue('[name="deadline"]');
  assert(/^\d{4}-\d{2}-\d{2}$/.test(box), `the date box holds "${box}"`);

  // Counted from the date the app itself is showing, not from a UTC clock:
  // the deadline on screen is already "4 days left", so five days later must
  // read as nine. Working from Date.now() here would drift by a day whenever
  // the run happens after 18:30 UTC, which is early evening in India.
  const target = addDays(box, 5);
  await page.fill('[name="deadline"]', target);
  await page.click("#edit-save");
  await page.waitForSelector("#edit-form", { state: "detached" });

  const saved = registry.manuscripts.find((m) => m.id === "m-amend");
  assert(saved.overrides.deadline, "the correction was not pinned, so the next email would undo it");
  // Stored as the last moment of that day: a deadline is not missed at 00:01.
  assert(saved.deadline.startsWith(target) || saved.deadline.startsWith(nextDay(target)),
    `stored as ${saved.deadline}, expected the end of ${target}`);

  const chip = await page.textContent('#drawer-body .deadline-chip');
  assert(/9 days left/.test(chip), `the drawer now reads "${chip}", expected 9 days left`);
  assert(!/\*/.test(chip), "a date set by hand is still being called an estimate");
});

await check("the edit button appears once a manuscript is open", async (page) => {
  assert(await page.isHidden("#drawer-edit"), "the edit button showed before a drawer was open");
  await openFirst(page);
  assert(await page.isVisible("#drawer-edit"), "the edit button did not appear");
});

await check("a correction is saved and shown straight away", async (page) => {
  await startEditing(page);
  await page.fill('[name="title"]', "Original Title As It Should Read");
  await save(page);

  assert(
    (await page.textContent(".d-title")).includes("Original Title As It Should Read"),
    "the drawer still shows the old title"
  );
  const saved = registry.manuscripts.find((m) => m.id === "m-knees");
  assert(saved.title === "Original Title As It Should Read", `the file has ${saved.title}`);
  assert(saved.overrides.title, "the correction was not pinned, so the next sync would undo it");
  assert(
    (saved.titleAliases || []).includes("Origional Title As The Journal Typed It"),
    "the journal's own wording was not kept, so later emails would open a second record"
  );
  assert(
    (await page.textContent(".d-title")).includes("set by hand"),
    "nothing tells the reader this field no longer follows the sync"
  );
});

await check("moving to another section updates the counts and the filter", async (page) => {
  const before = Number(await page.textContent('[data-count="published"]'));
  await startEditing(page);
  await page.click('.section-chip[data-bucket="published"]');
  await save(page);

  assert(
    Number(await page.textContent('[data-count="published"]')) === before + 1,
    "the Published count did not go up"
  );
  assert(registry.manuscripts.find((m) => m.id === "m-knees").bucket === "published", "the file was not updated");

  await page.click("#drawer-close");
  await page.click('.bucket-btn[data-bucket="published"]');
  await page.waitForSelector('.card[data-id="m-knees"]');
});

await check("a move can be handed back to the sync", async (page) => {
  await startEditing(page);
  await page.click('.section-chip[data-bucket="needs_action"]');
  await save(page);
  assert(registry.manuscripts.find((m) => m.id === "m-knees").overrides.bucket, "the move was not pinned");

  await startEditing(page);
  await page.click('[data-release="bucket"]');
  await save(page);
  const saved = registry.manuscripts.find((m) => m.id === "m-knees");
  assert(!("bucket" in (saved.overrides || {})), "the pin was not released");
  assert(saved.bucket === "needs_action", "releasing the pin should leave the value, not undo it");
});

await check("notes can be added for what the email trail does not carry", async (page) => {
  await startEditing(page);
  await page.fill('[name="notes"]', "Editor rang on the 14th — decision due in a fortnight.");
  await save(page);
  assert(
    (await page.textContent(".d-notes")).includes("Editor rang on the 14th"),
    "the note is not shown in the drawer"
  );
});

await check("a second manuscript is untouched by editing the first", async (page) => {
  const other = registry.manuscripts.find((m) => m.id === "m-hips");
  const before = JSON.stringify(other);
  await startEditing(page);
  await page.fill('[name="currentStatus"]', "With the editor");
  await save(page);
  assert(
    JSON.stringify(registry.manuscripts.find((m) => m.id === "m-hips")) === before,
    "editing one manuscript changed another"
  );
});

await check("closing mid-edit asks before throwing the work away", async (page) => {
  await startEditing(page);
  await page.fill('[name="currentStatus"]', "Something typed but not saved");

  page.once("dialog", (d) => d.dismiss());
  await page.click("#drawer-close");
  assert(await page.isVisible("#edit-form"), "the form was closed despite the refusal");

  page.once("dialog", (d) => d.accept());
  await page.click("#drawer-close");
  await page.waitForSelector("#edit-form", { state: "detached" });
});

await check("a failure is reported in the form, not swallowed", async (page) => {
  await startEditing(page);
  // Route the save into a 500 the way an unconfigured Worker would answer.
  await page.route("**/manuscripts/**", (r) =>
    r.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify({ error: "GitHub is unavailable." }) })
  );
  await page.fill('[name="currentJournal"]', "Somewhere Else");
  await page.click("#edit-save");
  await page.waitForSelector("#edit-error:not([hidden])");
  assert(
    (await page.textContent("#edit-error")).includes("GitHub is unavailable"),
    "the reason was not passed on to the person"
  );
  assert(await page.isEnabled("#edit-save"), "the save button stayed disabled, so there is no way to retry");
}, { expectErrors: true });

await check("a resumed session is asked for the password before it can save", async (page) => {
  // What "stay signed in" leaves behind: the session flag is durable, the
  // password deliberately is not. Clearing it is what a new browser session
  // looks like the next morning.
  await page.evaluate(() => sessionStorage.removeItem("orgkarur.passphrase"));
  await startEditing(page);
  await page.fill('[name="currentStatus"]', "Accepted");
  await page.click("#edit-save");
  await page.waitForSelector("#token-modal:not([hidden])");

  await page.fill("#token-input", PASSWORD);
  await page.click(".token-save");
  await page.waitForSelector("#edit-form", { state: "detached" });
  assert(
    registry.manuscripts.find((m) => m.id === "m-knees").currentStatus === "Accepted",
    "the edit was lost after confirming the password"
  );
});

await check("nothing is offered when there is no sync service to save to", async (page) => {
  // A deployment with no Worker cannot write anywhere. An edit button that
  // always fails at the last step would be worse than not having one.
  await page.route("**/assets/config.json*", (r) =>
    r.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ syncProxyUrl: "" }) })
  );
  await page.reload();
  await unlock(page);
  await openFirst(page);
  assert(await page.isHidden("#drawer-edit"), "an edit button was offered with nowhere to save to");
});

await browser.close();
site.close();
proxy.close();

if (failures.length) {
  console.error(`\n${failures.length} of ${passed + failures.length} editing checks failed:\n`);
  for (const f of failures) console.error(`  ✗ ${f}\n`);
  process.exit(1);
}
console.log(`✓ all ${passed} editing checks passed`);
