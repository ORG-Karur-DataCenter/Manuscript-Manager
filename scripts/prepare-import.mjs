/**
 * Stage one of the offline backfill.
 *
 * Reads one or more mbox exports, keeps only plausible journal correspondence,
 * and writes a compact candidate file. Makes ZERO API calls — the classification
 * happens in the next stage, by hand or by an assistant reading the candidates.
 *
 *   node scripts/prepare-import.mjs export1.mbox export2.mbox --account "Sathish Muthu"
 *   node scripts/prepare-import.mjs export.mbox --days 30 --out data/import-candidates.json
 */
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { readMbox } from "./lib/mbox.mjs";
import { PREFILTER } from "./lib/prefilter.mjs";

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

function parseArgs(argv) {
  const files = [];
  const opts = { days: 30, out: path.join(ROOT, "data/import-candidates.json"), account: null };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--days") opts.days = Number(argv[++i]);
    else if (arg === "--out") opts.out = argv[++i];
    else if (arg === "--account") opts.account = argv[++i];
    else files.push(arg);
  }
  return { files, opts };
}

const { files, opts } = parseArgs(process.argv.slice(2));
if (!files.length) {
  console.error(
    "Usage: node scripts/prepare-import.mjs <file.mbox...> [--days 30] [--account LABEL] [--out PATH]"
  );
  process.exit(1);
}

const cutoff = Date.now() - opts.days * 86400000;
const candidates = [];
let scanned = 0;
let tooOld = 0;
let filteredOut = 0;

for (const file of files) {
  console.log(`Reading ${file} ...`);
  for await (const msg of readMbox(file)) {
    scanned++;
    if (new Date(msg.internalDate).getTime() < cutoff) {
      tooOld++;
      continue;
    }
    if (!PREFILTER.test(`${msg.subject} ${msg.from} ${msg.text}`)) {
      filteredOut++;
      continue;
    }
    candidates.push({
      id: msg.id,
      subject: msg.subject,
      from: msg.from,
      date: msg.date,
      internalDate: msg.internalDate,
      account: opts.account,
      // Trimmed: the decision is always in the opening of a journal email, and
      // full bodies would make the candidate file unreadable.
      text: msg.text.slice(0, 4000),
    });
  }
}

candidates.sort((a, b) => new Date(a.internalDate) - new Date(b.internalDate));

await writeFile(
  opts.out,
  JSON.stringify({ generatedAt: new Date().toISOString(), days: opts.days, candidates }, null, 2) + "\n",
  "utf-8"
);

console.log(`
Scanned          ${scanned} message(s)
Older than ${String(opts.days).padStart(2)} days ${tooOld}
Not journal mail ${filteredOut}
--------------------------------
Needs classifying ${candidates.length}

Wrote ${opts.out}`);
