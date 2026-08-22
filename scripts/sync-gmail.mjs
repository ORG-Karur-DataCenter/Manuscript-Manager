import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { buildGmailClient, fetchNewMessages } from "./lib/gmail.mjs";
import { classifyEmail } from "./lib/classify.mjs";
import { applyEvent } from "./lib/registry.mjs";

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const P = {
  accounts: path.join(ROOT, "config/accounts.json"),
  manuscripts: path.join(ROOT, "data/manuscripts.json"),
  state: path.join(ROOT, "data/sync-state.json"),
  excluded: path.join(ROOT, "data/excluded-log.json"),
};

const DEFAULT_LOOKBACK_DAYS = 30; // first run per account
const OVERLAP_DAYS = 2; // re-scan a small window each run so nothing is missed at the boundary
const MAX_SEEN_IDS_PER_ACCOUNT = 8000;
const MAX_EXCLUDED_LOG = 300;

// Cheap keyword prefilter so we don't spend an LLM call on obvious non-candidates
// (receipts, calendar invites, mailing lists, etc). Deliberately broad/generous.
const PREFILTER = new RegExp(
  [
    "manuscript",
    "submission",
    "submitted",
    "editorial manager",
    "scholarone",
    "journal",
    "peer.?review",
    "reviewer",
    "revis(e|ion)",
    "accept(ed|ance)",
    "reject(ed|ion)",
    "decision on your",
    "under review",
    "proof(s)?\\b",
    "galley",
    "copyedit",
    "editor.?in.?chief",
    "corresponding author",
    "doi\\.org",
    "publish(ed|ing)?",
    "transfer(red)? to",
    "desk reject",
    "invite you to submit",
    "invited to review",
  ].join("|"),
  "i"
);

function gmailDateQuery(sinceDate) {
  const y = sinceDate.getUTCFullYear();
  const m = String(sinceDate.getUTCMonth() + 1).padStart(2, "0");
  const d = String(sinceDate.getUTCDate()).padStart(2, "0");
  return `after:${y}/${m}/${d}`;
}

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

async function main() {
  const { accounts } = await loadJson(P.accounts, { accounts: [] });
  const manuscriptsDb = await loadJson(P.manuscripts, { generatedAt: null, manuscripts: [] });
  const state = await loadJson(P.state, { accounts: {} });
  const excludedLog = await loadJson(P.excluded, { excluded: [] });

  const clientId = process.env.GMAIL_CLIENT_ID;
  const clientSecret = process.env.GMAIL_CLIENT_SECRET;
  if (!clientId || !clientSecret) {
    throw new Error("GMAIL_CLIENT_ID / GMAIL_CLIENT_SECRET are not set.");
  }
  if (!process.env.ANTHROPIC_API_KEY) {
    throw new Error("ANTHROPIC_API_KEY is not set.");
  }

  let totalFetched = 0;
  let totalRelevant = 0;
  let totalExcluded = 0;

  for (const account of accounts) {
    const refreshToken = process.env[account.refreshTokenEnv];
    if (!refreshToken) {
      console.warn(`Skipping ${account.label}: env ${account.refreshTokenEnv} not set.`);
      continue;
    }

    state.accounts[account.email] ||= { lastSyncedAt: null, seenIds: [] };
    const acctState = state.accounts[account.email];
    const seenIds = new Set(acctState.seenIds);

    const since = acctState.lastSyncedAt
      ? new Date(new Date(acctState.lastSyncedAt).getTime() - OVERLAP_DAYS * 86400000)
      : new Date(Date.now() - DEFAULT_LOOKBACK_DAYS * 86400000);

    const gmail = buildGmailClient({ clientId, clientSecret, refreshToken });
    const query = `-in:chats -in:drafts -in:spam -in:trash ${gmailDateQuery(since)}`;

    console.log(`[${account.label}] fetching since ${since.toISOString()} ...`);
    const messages = await fetchNewMessages(gmail, { query, seenIds });
    console.log(`[${account.label}] ${messages.length} new message(s) to inspect.`);
    totalFetched += messages.length;

    for (const msg of messages) {
      seenIds.add(msg.id);

      const candidateText = `${msg.subject} ${msg.from} ${msg.text}`;
      if (!PREFILTER.test(candidateText)) {
        continue; // clearly not journal correspondence — skip without an LLM call
      }

      let result;
      try {
        result = await classifyEmail({
          subject: msg.subject,
          from: msg.from,
          date: msg.date,
          text: msg.text,
        });
      } catch (err) {
        console.error(`Classification failed for message ${msg.id}:`, err.message);
        continue;
      }

      const source = {
        threadId: msg.threadId,
        messageId: msg.id,
        subject: msg.subject,
        from: msg.from,
      };

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
      });
    }

    acctState.lastSyncedAt = new Date().toISOString();
    acctState.seenIds = Array.from(seenIds).slice(-MAX_SEEN_IDS_PER_ACCOUNT);
  }

  excludedLog.excluded = excludedLog.excluded.slice(0, MAX_EXCLUDED_LOG);
  manuscriptsDb.generatedAt = new Date().toISOString();
  manuscriptsDb.manuscripts.sort(
    (a, b) => new Date(b.updatedAt) - new Date(a.updatedAt)
  );

  await saveJson(P.manuscripts, manuscriptsDb);
  await saveJson(P.state, state);
  await saveJson(P.excluded, excludedLog);

  console.log(
    `Done. Inspected ${totalFetched}, filed ${totalRelevant} manuscript event(s), excluded ${totalExcluded}.`
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
