/**
 * Stage two of the offline backfill.
 *
 * Takes classifications produced offline (same shape classifyEmail returns),
 * files them into the registry, then hands over to the scheduled sync by moving
 * the sync window forward — so the 3-hourly job only ever sees NEW mail and
 * never re-classifies the backfill through a rate-limited API.
 *
 *   node scripts/apply-import.mjs data/import-classified.json --overlap-days 3
 */
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { applyEvent } from "./lib/registry.mjs";

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const P = {
  accounts: path.join(ROOT, "config/accounts.json"),
  manuscripts: path.join(ROOT, "data/manuscripts.json"),
  state: path.join(ROOT, "data/sync-state.json"),
  excluded: path.join(ROOT, "data/excluded-log.json"),
  review: path.join(ROOT, "data/review-queue.json"),
};

const args = process.argv.slice(2);
const file = args.find((a) => !a.startsWith("--"));
const overlapIdx = args.indexOf("--overlap-days");
const OVERLAP_DAYS = overlapIdx !== -1 ? Number(args[overlapIdx + 1]) : 3;

// Only the inboxes actually covered by this import may have their sync window
// moved forward. Handing over an account that was NOT imported would silently
// skip its backfill entirely.
const handoverEmails = args
  .map((a, i) => (a === "--handover" ? args[i + 1] : null))
  .filter(Boolean);

// Importing a historical window must not touch the forward sync window: those
// emails are older than where the sync already is, and moving lastSyncedAt back
// would make the next run re-fetch mail it has long since settled. Seen ids are
// still recorded, since those decisions are final either way.
const seenOnly = args.includes("--seen-only");

if (!file) {
  console.error("Usage: node scripts/apply-import.mjs <classified.json> [--overlap-days 3]");
  process.exit(1);
}

async function loadJson(f, fallback) {
  try {
    return JSON.parse(await readFile(f, "utf-8"));
  } catch {
    return fallback;
  }
}
const saveJson = (f, d) => writeFile(f, JSON.stringify(d, null, 2) + "\n", "utf-8");

const { accounts } = await loadJson(P.accounts, { accounts: [] });
const db = await loadJson(P.manuscripts, { generatedAt: null, manuscripts: [] });
const state = await loadJson(P.state, { accounts: {} });
const excludedLog = await loadJson(P.excluded, { excluded: [] });
const reviewQueue = await loadJson(P.review, { review: [] });
const imported = await loadJson(file, { classified: [] });
const { classified } = imported;

if (!Array.isArray(classified) || !classified.length) {
  console.error(`No classifications found in ${file} (expected { "classified": [ ... ] }).`);
  process.exit(1);
}

/**
 * Every identity a logged email may be stored under. Rows written before the
 * message id was recorded only carry the natural key, so an entry has to be
 * matched on both forms or the same email is logged twice.
 */
function logKeys(e) {
  const keys = [[e.timestamp, e.subject, e.from].join(" ")];
  if (e.messageId) keys.push(e.messageId);
  return keys;
}

function logHas(list, item) {
  const wanted = new Set(logKeys(item));
  return list.some((e) => logKeys(e).some((k) => wanted.has(k)));
}

let filed = 0;
let excluded = 0;
let review = 0;
let skipped = 0;

for (const item of classified) {
  const source = {
    threadId: item.id || null,
    messageId: item.id || null,
    subject: item.subject || "",
    from: item.from || "",
    via: "offline-import",
  };

  // The registry dedupes events by message id; these logs must too, or a
  // replayed import inflates their counts without changing anything real.
  // Entries written before the id was recorded fall back to the natural key
  // (timestamp + subject + sender), which identifies one email just as well.
  const asLogged = {
    messageId: item.id,
    timestamp: item.internalDate,
    subject: item.subject,
    from: item.from,
  };
  const alreadyReviewed = logHas(reviewQueue.review, asLogged);
  const alreadyExcluded = logHas(excludedLog.excluded, asLogged);

  if (item.needsReview && !alreadyReviewed) {
    review++;
    reviewQueue.review.unshift({
      messageId: item.id || null,
      timestamp: item.internalDate,
      reason: item.reviewReason || "flagged during offline import",
      relevant: item.relevant,
      eventType: item.event_type || null,
      title: item.title || null,
      journal: item.journal || null,
      subject: item.subject,
      from: item.from,
      account: item.account || null,
      meta: { via: "offline-import" },
    });
  }

  if (!item.relevant) {
    if (alreadyExcluded) continue;
    excluded++;
    excludedLog.excluded.unshift({
      messageId: item.id || null,
      timestamp: item.internalDate,
      reason: item.exclude_reason || "unrelated",
      subject: item.subject,
      from: item.from,
      account: item.account || null,
    });
    continue;
  }

  if (!item.title || !item.journal) {
    skipped++;
    continue;
  }

  filed++;
  applyEvent(db, {
    title: item.title,
    journal: item.journal,
    manuscriptNumber: item.manuscript_number || null,
    eventType: item.event_type,
    revisionRound: item.revision_round || null,
    doi: item.doi || null,
    publicationLink: item.publication_link || null,
    summary: item.summary || "",
    timestamp: item.internalDate,
    authorAccount: item.account || null,
    source,
    needsReview: item.needsReview || false,
  });
}

// Hand over to the scheduled sync. Setting lastSyncedAt to now minus a small
// overlap means the Gmail query starts from roughly today: the imported month is
// never re-fetched, so the backfill costs the API nothing.
const handover = new Date(Date.now() - OVERLAP_DAYS * 86400000).toISOString();
const targets = handoverEmails.length
  ? accounts.filter((a) => handoverEmails.includes(a.email))
  : accounts;

if (handoverEmails.length && targets.length !== handoverEmails.length) {
  console.error(
    `--handover named an address not in config/accounts.json: ${handoverEmails.join(", ")}`
  );
  process.exit(1);
}

// The sync window overlaps by design, so the handover date alone would let the
// scheduled run re-fetch and re-classify everything this import already decided.
// Recording the message ids keeps them out of the classifier entirely.
// Prefer every id the dump inspected: the prefilter's rejections are decisions
// too, and re-fetching them wastes the next run's fetch cap. Fall back to the
// classified ids for a hand-written import that carries no inspection list.
const importedIds = (
  imported.inspectedIds?.length ? imported.inspectedIds : classified.map((c) => c.id)
).filter(Boolean);

for (const account of targets) {
  state.accounts[account.email] ||= { lastSyncedAt: null, seenIds: [] };
  const acct = state.accounts[account.email];
  if (!seenOnly) {
    acct.lastSyncedAt = handover;
    acct.importedAt = new Date().toISOString();
  }
  acct.seenIds = Array.from(new Set([...(acct.seenIds || []), ...importedIds]));
}
const untouched = accounts.filter((a) => !targets.includes(a));

db.generatedAt = new Date().toISOString();
db.manuscripts.sort((a, b) => new Date(b.updatedAt) - new Date(a.updatedAt));
excludedLog.excluded = excludedLog.excluded.slice(0, 300);
reviewQueue.review = reviewQueue.review.slice(0, 200);

await saveJson(P.manuscripts, db);
await saveJson(P.state, state);
await saveJson(P.excluded, excludedLog);
await saveJson(P.review, reviewQueue);

console.log(`Imported ${classified.length} classification(s):
  filed        ${filed} manuscript event(s)
  excluded     ${excluded}
  flagged      ${review} for review
  skipped      ${skipped} (relevant but missing title/journal)

Registry now holds ${db.manuscripts.length} manuscript(s).
${
  seenOnly
    ? `Historical import: sync window left untouched for ${targets
        .map((a) => a.email)
        .join(", ")}; ${importedIds.length} message id(s) recorded as seen.`
    : `Handed over: ${targets.map((a) => a.email).join(", ") || "(none)"}
  window set to ${handover} (${OVERLAP_DAYS}-day overlap) — only NEW mail from here.`
}
${
  untouched.length
    ? `Still to backfill: ${untouched
        .map((a) => a.email)
        .join(", ")}\n  left untouched, so the scheduled sync will still cover its full history.`
    : "Every configured account was imported."
}`);
