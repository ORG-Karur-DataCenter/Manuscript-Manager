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
const { classified } = await loadJson(file, { classified: [] });

if (!Array.isArray(classified) || !classified.length) {
  console.error(`No classifications found in ${file} (expected { "classified": [ ... ] }).`);
  process.exit(1);
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

  if (item.needsReview) {
    review++;
    reviewQueue.review.unshift({
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
    excluded++;
    excludedLog.excluded.unshift({
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

for (const account of targets) {
  state.accounts[account.email] ||= { lastSyncedAt: null, seenIds: [] };
  state.accounts[account.email].lastSyncedAt = handover;
  state.accounts[account.email].importedAt = new Date().toISOString();
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
Handed over: ${targets.map((a) => a.email).join(", ") || "(none)"}
  window set to ${handover} (${OVERLAP_DAYS}-day overlap) — only NEW mail from here.
${
  untouched.length
    ? `Still to backfill: ${untouched
        .map((a) => a.email)
        .join(", ")}\n  left untouched, so the scheduled sync will still cover its full history.`
    : "Every configured account was imported."
}`);
