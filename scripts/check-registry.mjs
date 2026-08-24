/**
 * Known-answer checks for the registry rules that were learned the hard way.
 * Needs no API keys and no network: run it before touching registry.mjs.
 *
 *   node scripts/check-registry.mjs
 */
import { applyEvent } from "./lib/registry.mjs";

const reg = { manuscripts: [] };
const ev = (o) => ({ revisionRound: null, doi: null, publicationLink: null, summary: "", needsReview: false, ...o });

// A paper submitted to International Orthopaedics, then rejected there.
applyEvent(reg, ev({ title: "Orthobiologics in Regenerative Orthopedics: A Scoping Review", journal: "International Orthopaedics", manuscriptNumber: "INOR-1", eventType: "new_submission", timestamp: "2026-03-01T00:00:00Z", source: { messageId: "m1" } }));
applyEvent(reg, ev({ title: "Orthobiologics in Regenerative Orthopedics: A Scoping Review", journal: "International Orthopaedics", manuscriptNumber: "INOR-1", eventType: "rejected", timestamp: "2026-03-20T00:00:00Z", source: { messageId: "m2" } }));

const m = reg.manuscripts[0];
console.log("after rejection  -> bucket:", m.bucket, "| submissions:", m.submissions.length, "| outcomes:", m.submissions.map(s => s.outcome).join(","));

// The transfer OFFER that leaks through as relevant: an "other" event at the
// journal that just rejected it.
applyEvent(reg, ev({ title: "Orthobiologics in Regenerative Orthopedics: A Scoping Review", journal: "International Orthopaedics", manuscriptNumber: null, eventType: "other", timestamp: "2026-03-21T00:00:00Z", source: { messageId: "m3" } }));

console.log("after the offer  -> bucket:", m.bucket, "| submissions:", m.submissions.length, "| outcomes:", m.submissions.map(s => s.outcome).join(","));
console.log("timeline:", m.timeline.map(t => t.eventType).join(" -> "));

// And an "other" at a journal the paper was never at: timeline only, no submission.
applyEvent(reg, ev({ title: "Orthobiologics in Regenerative Orthopedics: A Scoping Review", journal: "Some Other Journal", manuscriptNumber: null, eventType: "other", timestamp: "2026-03-22T00:00:00Z", source: { messageId: "m4" } }));
console.log("after stray other-> submissions:", m.submissions.length, "| journals:", m.submissions.map(s => s.journal).join(","));

let failures = 0;
const check = (name, ok) => { console.log(`${ok ? "PASS" : "FAIL"}  ${name}`); if (!ok) failures++; };

console.log("");
check("a transfer offer opens no phantom live submission",
  m.submissions.length === 1 && m.submissions[0].outcome === "rejected" && m.bucket === "needs_action");
check('an ambiguous "other" event does not overwrite a real status',
  m.currentStatus === "Rejected");

// A backfilled event landing after later ones must not speak for the present.
const reg2 = { manuscripts: [] };
applyEvent(reg2, ev({ title: "Late Arrival", journal: "Journal A", eventType: "rejected", timestamp: "2026-08-01T00:00:00Z", source: { messageId: "a1" } }));
applyEvent(reg2, ev({ title: "Late Arrival", journal: "Journal A", eventType: "under_review", timestamp: "2026-04-01T00:00:00Z", source: { messageId: "a2" } }));
const m2 = reg2.manuscripts[0];
check("a stale event joins the timeline without rewriting current status",
  m2.currentStatus === "Rejected" && m2.bucket === "needs_action" && m2.timeline.length === 2);
check("statusHistory is sorted however events arrive",
  m2.submissions[0].statusHistory.map((h) => h.timestamp).join() ===
    [...m2.submissions[0].statusHistory].map((h) => h.timestamp).sort().join());

// The sync window overlaps deliberately, so the same message will arrive twice.
const before = m2.timeline.length;
applyEvent(reg2, ev({ title: "Late Arrival", journal: "Journal A", eventType: "rejected", timestamp: "2026-08-01T00:00:00Z", source: { messageId: "a1" } }));
check("a replayed message is filed once", m2.timeline.length === before);

console.log(failures ? `\n${failures} registry check(s) failed.` : "\nAll registry checks passed.");
process.exit(failures ? 1 : 0);
