// Bucketing that reads the body, not just the subject.
//
// Baishideng and several others title a peer-review invitation "…Manuscript
// peer review invitation…" and quote the full manuscript title inside. A
// subject-only rule files those as the recipient's own submission, which is the
// single worst error this tracker can make. The body is where the ask lives.
import { readFile } from "node:fs/promises";

const SYSTEM = /(editorialmanager|manuscriptcentral|springernature|wjgnet|frontiersin|mdpi|wiley|elsevier|sagepub|bmj|biomedcentral|tandfonline|lww|karger|thieme|researchsquare|jbjs)/i;

const INVITE_SUBJ = /reviewer.s code|peer review invitation|invitation to (?:peer )?review|invite[sd]? you to review|request to review|review request|referee|reminder:? invitation|overview of your assignments|review cancelled|peer review \(/i;
const INVITE_BODY = /invite you to review|agree to review|would you be willing to review|as a (?:potential )?reviewer|reviewer.s code|decline to review|invites you to review|your review of|complete your review/i;
const ADMIN = /account (created|modified|activated)|registration|welcome to|password|confirm your email|username|thank you for registering|survey|newsletter|table of contents|call for papers|special issue|webinar|policy document|sciprofiles|discount|voucher|invoice/i;
const DECISION = /decision|rejected|accepted|acceptance|revision|revise|unsubmitted|returned to author|not able to accept|desk reject|withdraw|transfer/i;
const SUBMISSION = /submitted|submission|receipt of|manuscript (id|no|number)|confirm co-authorship|verify your authorship|track the status|has been received|passed the technical|requires approval|proof|galley/i;

export function bucketOf(c) {
  const s = c.subject || "";
  const b = c.text || "";
  if (INVITE_SUBJ.test(s) || INVITE_BODY.test(b)) return "review_invite";
  if (ADMIN.test(s)) return "admin_noise";
  if (DECISION.test(s)) return "DECISION";
  if (SUBMISSION.test(s)) return "SUBMISSION";
  return "unclear";
}

if ((process.argv[1] || "").endsWith("triage.mjs")) {
  const data = JSON.parse(await readFile(process.argv[2], "utf-8"));
  const rows = data.candidates.filter((c) => SYSTEM.test(c.from || ""));
  const nonSystem = data.candidates.filter((c) => !SYSTEM.test(c.from || ""));
  const by = {};
  for (const c of rows) (by[bucketOf(c)] ||= []).push(c);
  console.log("journal-system emails:", rows.length);
  for (const k of ["DECISION", "SUBMISSION", "unclear", "review_invite", "admin_noise"]) {
    console.log(`  ${k}: ${(by[k] || []).length}`);
  }
  console.log("non-system emails:", nonSystem.length);

  const show = process.argv[3];
  if (show && by[show]) {
    console.log(`\n--- ${show} ---`);
    (by[show] || []).slice(Number(process.argv[4] || 0), Number(process.argv[5] || 9999))
      .forEach((c) => console.log(c.id, c.internalDate.slice(0, 10), "|", (c.subject || "").slice(0, 88)));
  }
}
