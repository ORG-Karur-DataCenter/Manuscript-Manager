/**
 * Fetches a window of mail for one account and writes the prefiltered
 * candidates for offline classification. Makes NO classifier API calls, so it
 * is unaffected by free-tier quotas.
 *
 * Intended to run in CI where the refresh token already lives as a secret, so
 * the credential never has to be handled anywhere else.
 *
 *   ACCOUNT_EMAIL=someone@gmail.com DUMP_DAYS=30 node scripts/dump-candidates.mjs
 */
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildClient, fetchNewMessages, credentialsFor, providerOf } from "./lib/mailbox.mjs";
import { PREFILTER } from "./lib/prefilter.mjs";

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const DAYS = Number(process.env.DUMP_DAYS || 30);
const OUT = process.env.DUMP_OUT || path.join(ROOT, "data/import-candidates.json");
const TARGET = process.env.ACCOUNT_EMAIL;

const { accounts } = JSON.parse(
  await readFile(path.join(ROOT, "config/accounts.json"), "utf-8")
);
const account = accounts.find((a) => a.email === TARGET);
if (!account) {
  console.error(
    `ACCOUNT_EMAIL must name an account in config/accounts.json. Known: ${accounts
      .map((a) => a.email)
      .join(", ")}`
  );
  process.exit(1);
}

const { missing } = credentialsFor(account);
if (missing.length) {
  console.error(`${account.email} (${providerOf(account)}): ${missing.join(", ")} not set.`);
  process.exit(1);
}

// A long backfill is dumped in slices: DUMP_DAYS is the far edge of the window
// and DUMP_UNTIL_DAYS the near edge, so days=180 until_days=150 is one month of
// history six months back. Each slice stays small enough to classify in one go.
const UNTIL_DAYS = Number(process.env.DUMP_UNTIL_DAYS || 0);

const since = new Date(Date.now() - DAYS * 86400000);
const until = UNTIL_DAYS > 0 ? new Date(Date.now() - UNTIL_DAYS * 86400000) : null;
const y = since.getUTCFullYear();
const m = String(since.getUTCMonth() + 1).padStart(2, "0");
const d = String(since.getUTCDate()).padStart(2, "0");

function beforeClause(date) {
  if (!date) return "";
  const yy = date.getUTCFullYear();
  const mm = String(date.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(date.getUTCDate()).padStart(2, "0");
  return ` before:${yy}/${mm}/${dd}`;
}

const mailbox = buildClient(account);

console.log(
  `Fetching ${account.email} from ${y}-${m}-${d}` +
    (until ? ` to ${until.toISOString().slice(0, 10)}` : " to now") +
    " ..."
);
const messages = await fetchNewMessages(mailbox, {
  since,
  until,
  seenIds: new Set(),
  // A 30-day window fits in a few hundred; a six-month backfill does not.
  maxResults: Number(process.env.DUMP_MAX_RESULTS || 3000),
});

// Every id that was looked at, not just the ones worth classifying. The
// prefilter rejects most of an inbox, and those decisions are just as final --
// recording them stops the next sync re-fetching mail already ruled out, which
// would otherwise consume the per-run fetch cap before reaching new mail.
const inspectedIds = [];
const candidates = [];
for (const msg of messages) {
  inspectedIds.push(msg.id);
  if (!PREFILTER.test(`${msg.subject} ${msg.from} ${msg.text}`)) continue;
  candidates.push({
    id: msg.id,
    threadId: msg.threadId,
    subject: msg.subject,
    from: msg.from,
    date: msg.date,
    internalDate: msg.internalDate,
    account: account.label,
    text: msg.text.slice(0, 4000),
  });
}
candidates.sort((a, b) => new Date(a.internalDate) - new Date(b.internalDate));

await writeFile(
  OUT,
  JSON.stringify(
    {
      generatedAt: new Date().toISOString(),
      account: account.email,
      days: DAYS,
      untilDays: UNTIL_DAYS || null,
      inspectedIds,
      candidates,
    },
    null,
    2
  ) + "\n",
  "utf-8"
);

// Counts only — message bodies must not reach the job log, which is retained
// far longer than the artifact and is public on a public repository.
console.log(`Fetched ${messages.length}, ${candidates.length} need classifying.`);
console.log(`Wrote ${OUT}`);
