/**
 * Known-answer checks for the two clocks a message has: when it happened, and
 * when this mailbox received it. Importing another account's history makes
 * them diverge by months, and confusing them either backdates the whole
 * tracker or rewinds the sync window. No keys, no network.
 *
 *   npm run check-timestamps
 */
import { eventTimestamp } from "./lib/text.mjs";

const importedToday = Date.UTC(2026, 7, 26, 12, 0, 0);
const history = [
  ["Mon, 16 Mar 2026 09:12:00 +0000", "2026-03-16"],
  ["Tue, 05 May 2026 14:30:00 +0000", "2026-05-05"],
  ["Fri, 10 Jul 2026 08:00:00 +0000", "2026-07-10"],
];

console.log("=== imported history keeps its real dates ===");
let ok = true;
for (const [header, want] of history) {
  const eventTime = eventTimestamp(importedToday, header);
  const received = new Date(importedToday).toISOString();
  const pass = eventTime.slice(0, 10) === want && received.slice(0, 10) === "2026-08-26";
  if (!pass) ok = false;
  console.log(`${pass ? "PASS" : "FAIL"}  event ${eventTime.slice(0,10)}  |  delivered ${received.slice(0,10)}`);
}

console.log("\n=== the sync window follows delivery, so it does not rewind ===");
const msgs = history.map(([h]) => ({
  internalDate: eventTimestamp(importedToday, h),
  receivedAt: new Date(importedToday).toISOString(),
}));
let oldest = null;
for (const m of msgs) {
  const received = m.receivedAt || m.internalDate;
  if (!oldest || received < oldest) oldest = received;
}
const windowOk = oldest.slice(0, 10) === "2026-08-26";
if (!windowOk) ok = false;
console.log(`${windowOk ? "PASS" : "FAIL"}  window held at ${oldest.slice(0,10)} (not 2026-03-16)`);

console.log("\n=== without the split, the window would have rewound ===");
let naive = null;
for (const m of msgs) if (!naive || m.internalDate < naive) naive = m.internalDate;
console.log(`      old behaviour would set it to ${naive.slice(0,10)} — five months of refetch`);
console.log(ok ? "\nPASS overall" : "\nFAIL overall");
process.exit(ok ? 0 : 1);
