import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { buildClient, fetchNewMessages, credentialsFor, providerOf } from "./lib/mailbox.mjs";
import { classifyEmail } from "./lib/classify.mjs";
import { applyEvent } from "./lib/registry.mjs";
import { PREFILTER } from "./lib/prefilter.mjs";

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const P = {
  accounts: path.join(ROOT, "config/accounts.json"),
  manuscripts: path.join(ROOT, "data/manuscripts.json"),
  state: path.join(ROOT, "data/sync-state.json"),
  excluded: path.join(ROOT, "data/excluded-log.json"),
  review: path.join(ROOT, "data/review-queue.json"),
};

const DEFAULT_LOOKBACK_DAYS = 30; // first run per account
const OVERLAP_DAYS = 2; // re-scan a small window each run so nothing is missed at the boundary
const MAX_SEEN_IDS_PER_ACCOUNT = 8000;
const MAX_EXCLUDED_LOG = 300;
const MAX_REVIEW_QUEUE = 200;
const MAX_MESSAGES_PER_RUN = 150; // Gmail fetches per account per run

// Free-tier daily quotas are finite, so cap LLM work per run. Anything left over
// is picked up by the next run rather than dropped — see the resumability logic
// around `oldestUnprocessed` below.
const MAX_CLASSIFICATIONS_PER_RUN = Number(
  process.env.MAX_CLASSIFICATIONS_PER_RUN || 100
);

// A message that fails classification every single time (a permanent safety block,
// an unparseable body) would otherwise pin the sync window to itself forever and
// stall the account. After this many attempts it is set aside for a human instead.
const MAX_CLASSIFY_ATTEMPTS = 3;

// After this many rate limits in a row, treat the daily quota as spent and defer
// the rest of the account's mail to the next run.
const RATE_LIMIT_GIVE_UP = Number(process.env.RATE_LIMIT_GIVE_UP || 5);


async function loadJson(file, fallback) {
  try {
    return JSON.parse(await readFile(file, "utf-8"));
  } catch {
    return fallback;
  }
}

async function saveJson(file, data) {
  await writeFile(file, JSON.stringify(data, null, 2) + "\n", "utf-8");
}

function hasClassifierKey() {
  return Boolean(
    process.env.GEMINI_API_KEY ||
      process.env.CEREBRAS_API_KEY ||
      process.env.GROQ_API_KEY
  );
}

async function main() {
  const { accounts } = await loadJson(P.accounts, { accounts: [] });
  const manuscriptsDb = await loadJson(P.manuscripts, { generatedAt: null, manuscripts: [] });
  const state = await loadJson(P.state, { accounts: {} });
  const excludedLog = await loadJson(P.excluded, { excluded: [] });
  const reviewQueue = await loadJson(P.review, { review: [] });

  // Credentials are checked per account rather than up front: a missing Gmail
  // secret should skip the Gmail inboxes, not abort a run that could still
  // have synced Outlook.
  if (!hasClassifierKey()) {
    throw new Error(
      "No classifier API key set. Provide at least one of GEMINI_API_KEY, CEREBRAS_API_KEY, GROQ_API_KEY."
    );
  }

  let totalFetched = 0;
  let totalRelevant = 0;
  let totalExcluded = 0;
  let totalReview = 0;
  let totalDeferred = 0;
  let totalClassified = 0;
  let rateLimitedThisRun = 0;
  const activeAccounts =
    accounts.filter((a) => credentialsFor(a).missing.length === 0).length || 1;

  for (const account of accounts) {
    const { missing } = credentialsFor(account);
    if (missing.length) {
      console.warn(
        `Skipping ${account.label} (${providerOf(account)}): ${missing.join(", ")} not set.`
      );
      continue;
    }

    state.accounts[account.email] ||= { lastSyncedAt: null, seenIds: [] };
    const acctState = state.accounts[account.email];
    acctState.failedAttempts ||= {};
    const seenIds = new Set(acctState.seenIds);

    // Share the run's LLM budget across inboxes so the first account in the list
    // can't starve the rest during a backlog.
    let accountBudget = Math.max(1, Math.floor(MAX_CLASSIFICATIONS_PER_RUN / activeAccounts));

    const since = acctState.lastSyncedAt
      ? new Date(new Date(acctState.lastSyncedAt).getTime() - OVERLAP_DAYS * 86400000)
      : new Date(Date.now() - DEFAULT_LOOKBACK_DAYS * 86400000);

    const mailbox = buildClient(account);

    console.log(
      `[${account.label}] fetching ${providerOf(account)} since ${since.toISOString()} ...`
    );
    const messages = await fetchNewMessages(mailbox, {
      since,
      seenIds,
      maxResults: MAX_MESSAGES_PER_RUN,
    });
    console.log(`[${account.label}] ${messages.length} new message(s) to inspect.`);
    totalFetched += messages.length;

    // More candidates may exist beyond the fetch cap; if so we must not let the
    // sync window move past them.
    const hitFetchCap = messages.length >= MAX_MESSAGES_PER_RUN;

    // Timestamp of the oldest message we did NOT reach a decision on this run.
    // The window is held back to it so the next run sees it again.
    let oldestUnprocessed = null;
    let consecutiveRateLimits = 0;
    const defer = (msg) => {
      totalDeferred++;
      // Delivery time, not event time: the window is a position in this
      // mailbox's delivery order.
      const received = msg.receivedAt || msg.internalDate;
      if (!oldestUnprocessed || received < oldestUnprocessed) {
        oldestUnprocessed = received;
      }
    };

    for (const msg of messages) {
      const candidateText = `${msg.subject} ${msg.from} ${msg.text}`;
      if (!PREFILTER.test(candidateText)) {
        seenIds.add(msg.id); // a decision: not journal correspondence, never revisit
        continue;
      }

      if (accountBudget <= 0) {
        defer(msg); // out of budget for this run; next run picks it up
        continue;
      }

      // Consecutive rate limits mean the daily window is spent. Burning the rest
      // of the run on calls that will also 429 just wastes the job's time.
      if (consecutiveRateLimits >= RATE_LIMIT_GIVE_UP) {
        defer(msg);
        continue;
      }

      let result;
      try {
        accountBudget--;
        totalClassified++;
        result = await classifyEmail({
          subject: msg.subject,
          from: msg.from,
          date: msg.date,
          text: msg.text,
        });
      } catch (err) {
        // Rate limit, outage, malformed response — usually transient. Leaving the
        // id out of seenIds is what makes the email retryable instead of lost.
        // A quota ceiling says nothing about this email — it will classify fine
        // once the window reopens. Defer it without spending an attempt, or a
        // day of 429s would push perfectly good mail into the review queue.
        if (err.rateLimited) {
          rateLimitedThisRun++;
          consecutiveRateLimits++;
          console.error(`Rate limited on message ${msg.id}; deferring without penalty.`);
          defer(msg);
          continue;
        }

        const attempts = (acctState.failedAttempts[msg.id] || 0) + 1;
        console.error(
          `Classification failed for message ${msg.id} (attempt ${attempts}): ${err.message}`
        );

        if (attempts >= MAX_CLASSIFY_ATTEMPTS) {
          // Stop retrying, but never drop it silently — hand it to a human.
          delete acctState.failedAttempts[msg.id];
          seenIds.add(msg.id);
          totalReview++;
          reviewQueue.review.unshift({
            timestamp: msg.internalDate,
            reason: `classification failed ${attempts} times — last error: ${err.message}`,
            relevant: null,
            eventType: null,
            title: null,
            journal: null,
            subject: msg.subject,
            from: msg.from,
            account: account.email,
            meta: null,
          });
        } else {
          acctState.failedAttempts[msg.id] = attempts;
          defer(msg);
        }
        continue;
      }

      // From here the email has an answer, so it is settled either way.
      consecutiveRateLimits = 0;
      seenIds.add(msg.id);
      delete acctState.failedAttempts[msg.id];

      const source = {
        threadId: msg.threadId,
        messageId: msg.id,
        subject: msg.subject,
        from: msg.from,
      };

      if (result.needsReview) {
        totalReview++;
        reviewQueue.review.unshift({
          timestamp: msg.internalDate,
          reason: result.reviewReason,
          relevant: result.relevant,
          eventType: result.event_type,
          title: result.title,
          journal: result.journal,
          subject: msg.subject,
          from: msg.from,
          account: account.email,
          meta: result.meta,
        });
      }

      if (!result.relevant) {
        totalExcluded++;
        excludedLog.excluded.unshift({
          timestamp: msg.internalDate,
          reason: result.exclude_reason,
          subject: msg.subject,
          from: msg.from,
          account: account.email,
        });
        continue;
      }

      if (!result.title || !result.journal) {
        continue; // not enough to file — err on the side of not creating junk records
      }

      totalRelevant++;
      applyEvent(manuscriptsDb, {
        title: result.title,
        journal: result.journal,
        manuscriptNumber: result.manuscript_number || null,
        eventType: result.event_type,
        revisionRound: result.revision_round || null,
        doi: result.doi || null,
        publicationLink: result.publication_link || null,
        summary: result.summary || "",
        timestamp: msg.internalDate,
        authorAccount: account.label,
        source,
        needsReview: result.needsReview || false,
      });
    }

    if (oldestUnprocessed) {
      // Rewind to just before the oldest email still awaiting a decision.
      acctState.lastSyncedAt = oldestUnprocessed;
      console.log(
        `[${account.label}] holding sync window at ${oldestUnprocessed} — work remains.`
      );
    } else if (hitFetchCap) {
      console.log(
        `[${account.label}] fetch cap reached; leaving sync window in place for the next run.`
      );
    } else {
      acctState.lastSyncedAt = new Date().toISOString();
    }

    acctState.seenIds = Array.from(seenIds).slice(-MAX_SEEN_IDS_PER_ACCOUNT);

    // Don't let the retry ledger grow without bound as ids age out of seenIds.
    for (const id of Object.keys(acctState.failedAttempts)) {
      if (seenIds.has(id)) delete acctState.failedAttempts[id];
    }
  }

  excludedLog.excluded = excludedLog.excluded.slice(0, MAX_EXCLUDED_LOG);
  reviewQueue.review = reviewQueue.review.slice(0, MAX_REVIEW_QUEUE);
  manuscriptsDb.generatedAt = new Date().toISOString();
  manuscriptsDb.manuscripts.sort(
    (a, b) => new Date(b.updatedAt) - new Date(a.updatedAt)
  );

  await saveJson(P.manuscripts, manuscriptsDb);
  await saveJson(P.state, state);
  await saveJson(P.excluded, excludedLog);
  await saveJson(P.review, reviewQueue);

  console.log(
    `Done. Inspected ${totalFetched}, classified ${totalClassified}, ` +
      `filed ${totalRelevant} manuscript event(s), excluded ${totalExcluded}, ` +
      `flagged ${totalReview} for review, deferred ${totalDeferred} to the next run` +
      (rateLimitedThisRun ? ` (${rateLimitedThisRun} of them rate limited).` : ".")
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
