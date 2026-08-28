#!/usr/bin/env node
/**
 * Give the amendments already in the tracker a deadline.
 *
 * Deadlines are worked out when an email is classified, so without this the
 * feature only starts covering a manuscript the next time its journal writes —
 * and the ones outstanding today, which are exactly the ones that matter, would
 * be invisible. This walks what is already filed and fills them in from each
 * manuscript's own last event.
 *
 * These dates are all "assumed": the original emails were classified before the
 * deadline fields existed, so the journal's own words are no longer available
 * here. They are marked as assumptions and read as such everywhere.
 *
 *   node scripts/backfill/deadlines.mjs            # show what would change
 *   node scripts/backfill/deadlines.mjs --write    # write it
 */
import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { resolveDeadline, describeDeadline } from "../lib/deadline.mjs";

const ROOT = path.dirname(path.dirname(path.dirname(fileURLToPath(import.meta.url))));
const MANUSCRIPTS = path.join(ROOT, "data/manuscripts.json");
const POLICY = path.join(ROOT, "config/deadlines.json");
const write = process.argv.includes("--write");

const ON_A_CLOCK = { sent_back: true, revision_requested: true };
const LABELS = { revision_requested: "Revision requested", sent_back: "Amendments requested" };

const registry = JSON.parse(await readFile(MANUSCRIPTS, "utf8"));
const policy = JSON.parse(await readFile(POLICY, "utf8"));

let changed = 0;
for (const m of registry.manuscripts) {
  const last = (m.timeline || [])
    .slice()
    .sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp))[0];
  if (!last) continue;

  // The flag means "somebody has to do something", which does not depend on
  // which section the card sits in -- a revision request sits in "in review"
  // and still needs work. It was previously raised only for revisions, so
  // amendments, the ones with an actual clock on them, went unmarked.
  const flag = Boolean(ON_A_CLOCK[last.eventType]);
  const label = flag ? LABELS[last.eventType] : null;

  // Only amendments get a date filled in. A revision runs on a far longer
  // window -- sixty days is common -- so applying the amendment table to one
  // would invent an alarming deadline the journal never set.
  const resolved = last.eventType === "sent_back" && !m.deadline
    ? resolveDeadline({ eventTimestamp: last.timestamp, journal: last.journal || m.currentJournal, policy })
    : null;
  const deadline = m.deadline || (resolved ? resolved.due : null);
  const source = m.deadline ? m.deadlineSource || null : resolved ? resolved.source : null;

  if (m.actionFlag === flag && m.actionLabel === label && (m.deadline || null) === deadline) continue;

  changed++;
  const when = deadline ? describeDeadline(deadline) : "no deadline";
  console.log(
    `${flag ? "⚑" : " "} ${when.padEnd(16)} ${(m.currentJournal || "?").slice(0, 32).padEnd(32)} ${m.title.slice(0, 46)}`
  );

  m.actionFlag = flag;
  m.actionLabel = label;
  m.deadline = deadline;
  m.deadlineSource = source;
}

console.log(`\n${changed} manuscript(s) would change.`);
if (!write) {
  console.log("Nothing written. Re-run with --write to apply.");
} else {
  await writeFile(MANUSCRIPTS, `${JSON.stringify(registry, null, 2)}\n`);
  console.log(`Written to ${path.relative(ROOT, MANUSCRIPTS)}.`);
}
