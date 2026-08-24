// Sathish, "unclear" bucket -- the 283 subjects that matched none of the
// submission/decision/invitation shapes. Most are noise, but the production
// and publication trail lives here: Springer, Sage and Wiley announce a paper
// is in production or published with subjects that never say "manuscript".
// Those are the events that tell the tracker a paper is finished.
import { readFile, writeFile } from "node:fs/promises";
import { bucketOf } from "./triage.mjs";
import { journalFromBody, journalFromSubject, canonicalJournal, decode } from "./extract.mjs";

const data = JSON.parse(await readFile(process.argv[2], "utf-8"));
const OUT = process.argv[3];
const REGISTRY = process.argv[4];
const ACCOUNT = "Sathish Muthu";
const SYSTEM = /(editorialmanager|manuscriptcentral|springernature|wjgnet|frontiersin|mdpi|wiley|elsevier|sagepub|bmj|biomedcentral|tandfonline|lww|karger|thieme|researchsquare|jbjs)/i;

const known = REGISTRY
  ? [...new Set(JSON.parse(await readFile(REGISTRY, "utf-8")).manuscripts.map((m) => m.currentJournal).filter(Boolean))]
  : [];

// Sathish edits for JOIO, PLOS ONE and JCOT and reviews widely, so a large
// share of this bucket is other people's papers passing through his hands.
// Filing any of it would put strangers' manuscripts in the group's tracker.
const EDITORIAL = /invitation to handle|request to handle|reminder of active assignments|regarding reviewer invitation|reviewer (accepts|declines|un-invited)|assignment for|has been undone|new manuscript received|for review\s*$|more reviews required|one review complete|editor summary|editor handles|review invitation|edit invitation|editing invitation|ad hoc from author|reminder to review|reviewer.s code/i;

const MARKETING = /reference citation analysis|rca id|highlight articles|toc alert|read the latest|new issue live|issue alert|is this article of interest|call for paper|consider publishing|invites? you to (contribute|submit)|invitation to submit|impact metrics|citation alert|monsoon sale|research topic|upcoming discussion|just published:|new ways to boost|discover how|waive open access|publishing experience|author support|free preview|monthly breakdown|trending articles|journal recommendations|a recommendation for|deadline extension|your case is on hold|login instructions|best practice|focus on gut|sincerely invites|celebrating our impact|support you with oa|plagiarism index|survey|webinar|newsletter/i;

// Editorial Manager builds a PDF at SUBMISSION time for the author to approve,
// so "PDF has been built" is not a production step -- the submission import
// already covers those papers.
const EM_PDF = /approve your pdf|pdf has been built|thank you\b/i;

const PUB_JOURNAL = /(?:published (?:online )?in|available (?:to view )?(?:online )?in|your article in)\s+(?:the\s+)?([A-Z][A-Za-z&'’ -]{3,60}?)(?=[.,;:!?]|\s+(?:as|and|on|you|we|is|has|to)\b|$)/;

const PUBLISHED = /article is ready to view and share|published in an issue|sharing information for|has been published online/i;
const PRODUCTION = /next steps for (your|publishing)|signed publishing agreement|license (chosen|required) for your article|complete the open access process|copyright license agreement|confirmation mail for article|pending tasks to complete publication|corrections received|production query|tables query|information regarding your article/i;
const AMENDMENT = /amendment required|reminder to provide amendments/i;

const DOI = /\b(10\.\d{4,9}\/[^\s<>"')\]]+)/;
// Springer puts the value on the line after the label, Sage on the same line.
const LABEL_TITLE = /^[ \t]*(?:Manuscript |Article |Paper )?Title[ \t]*:[ \t]*\n[ \t]*(.{15,400})$/im;
const LABEL_TITLE1 = /^[ \t]*(?:Manuscript |Article |Paper )?Title[ \t]*:[ \t]*([\s\S]{15,400}?)[ \t]*\n[ \t]*(?=[A-Z][A-Za-z ]{2,28}:)/im;
const LABEL_TITLE2 = /^[ \t]*(?:Manuscript |Article |Paper )?Title[ \t]*:[ \t]*(.{15,300})$/im;
const LABEL_JOURNAL = /^[ \t]*Journal(?: name)?[ \t]*:[ \t]*\n?[ \t]*(.{3,70})$/im;
const ENTITLED = /entitled[,:]?\s*["“]([^"“”\n]{15,300})["”]/i;
const QUOTED = /(?:your (?:article|manuscript|paper)|Sharing Information for)[^\n]{0,20}?["“]([^"“”\n]{15,300})["”]/i;
const MSNO_TITLE = /\b[A-Z]{2,8}-\d{2}-\d{3,6}(?:\.R\d)?\s*[-–]\s*(.{15,300})$/m;
const FLAT_LABEL = /(?:^|[.,;:]\s+)(?:Manuscript|Article|Paper) Title:\s*(.{15,300}?)(?=\s+(?:Manuscript|Article|Paper) ID:|\s+Journal:|$)/i;
const WILEY = /Your article\s+(.{15,300}?)\s+in\s+([A-Z][A-Za-z&'’ -]{3,60}?)\s+has the following publication status/i;
const UNQUOTED = /your article\s+(?!in\b|at\b|is\b|has\b|was\b)([^\n]{15,300}?)\s+in\s+[A-Z]/i;
// Prepositions and auxiliaries mean the match started mid-sentence.
const TITLE_JUNK = /^(?:in|at|to|for|on|of|been|the following|and|but|has been|was)\b/i;
const MSNO = /\b([A-Z]{2,8}-D?-?\d{2}-\d{3,6}(?:\.?R\d)?|[a-z]{3,10}-\d{4}-\d{4,6})\b/;

// "Submission Confirmation for <title>" makes the title look like a journal.
// A name that simply repeats the manuscript title is never the journal.
const sameText = (a, b) => {
  if (!a || !b) return false;
  const n = (x) => x.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
  return n(b).startsWith(n(a)) && n(a).length > 8;
};

const dedupeLeadingWord = (t) => t.replace(/^(\S+)\s+\1(\s)/i, "$1$2");

const norm = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, " ").replace(/\s+/g, " ").trim().slice(0, 90);

const rows = data.candidates
  .filter((c) => SYSTEM.test(c.from || "") && bucketOf(c) === "unclear")
  .sort((a, b) => new Date(a.internalDate) - new Date(b.internalDate));

const SUBJ_TITLE = /(?:amendments on|regarding|Sharing Information for)[:\s]+["“]?(.{15,300}?)["”]?$/i;

function titleOf(lined, flat, subject = "") {
  const LINED = [LABEL_TITLE, LABEL_TITLE1, LABEL_TITLE2, MSNO_TITLE];
  for (const p of [...LINED, FLAT_LABEL, WILEY, ENTITLED, QUOTED, UNQUOTED]) {
    const m = p.exec(LINED.includes(p) ? lined : flat);
    if (!m || !m[1]) continue;
    const t = m[1].replace(/\s+/g, " ").trim().replace(/^["“']|["”'.,\s]+$/g, "").trim();
    if (t.length >= 15 && /\s/.test(t) && !TITLE_JUNK.test(t)) return dedupeLeadingWord(t);
  }
  const sm = SUBJ_TITLE.exec(subject);
  if (sm && sm[1] && sm[1].trim().length >= 15 && !TITLE_JUNK.test(sm[1].trim())) {
    return sm[1].replace(/\s+/g, " ").trim().replace(/^["“']|["”'.,\s]+$/g, "");
  }
  return null;
}

const classified = [];
const seenKey = new Map();
const tally = {};
const bump = (k) => (tally[k] = (tally[k] || 0) + 1);

for (const c of rows) {
  const subject = c.subject || "";
  const lined = decode(c.text || "")
    .replace(/<[^>]{0,120}>/g, "")
    .replace(/\r/g, "")
    .replace(/[ \t\u00a0]+/g, " ")
    .replace(/ *\n[ \n]*/g, "\n");
  const flat = lined.replace(/\s+/g, " ");
  const base = { id: c.id, subject, from: c.from, internalDate: c.internalDate, account: ACCOUNT };
  const drop = (why) => { bump(why); classified.push({ ...base, relevant: false, exclude_reason: "unrelated", needsReview: false }); };

  if (EDITORIAL.test(subject)) { drop("editorial role"); continue; }
  if (MARKETING.test(subject)) { drop("marketing"); continue; }
  if (EM_PDF.test(subject)) { drop("submission-stage PDF"); continue; }

  let event = null;
  if (PUBLISHED.test(subject) || PUBLISHED.test(flat.slice(0, 400))) event = "published";
  else if (PRODUCTION.test(subject)) event = "accepted";
  else if (AMENDMENT.test(subject)) event = "sent_back";
  else if (/has been successfully submitted online|successfully submitted to/i.test(flat)) {
    event = /revised manuscript|your revision/i.test(flat) ? "under_review" : "new_submission";
  }

  if (!event) { drop("no event"); continue; }

  const title = titleOf(lined, flat, subject);
  let journal = canonicalJournal(
    (LABEL_JOURNAL.exec(lined) || [])[1]?.trim() ||
      journalFromSubject(subject) ||
      journalFromBody(c.text || "") ||
      (WILEY.exec(flat) || [])[2]?.trim() ||
      (PUB_JOURNAL.exec(flat) || [])[1]?.trim(),
    known
  );
  if (sameText(journal, title)) journal = null;
  const doi = (DOI.exec(flat) || [])[1]?.replace(/[.,;)]+$/, "") || null;
  const number = (MSNO.exec(subject) || MSNO.exec(flat) || [])[1] || null;

  if ((!title || !journal) && event === "accepted") { drop("production chatter, unidentifiable"); continue; }
  if (!title || !journal) {
    bump(`${event}: needs review`);
    classified.push({
      ...base, relevant: false, exclude_reason: "unrelated", needsReview: true,
      title: title || null,
      reviewReason: `${event === "published" ? "Publication" : event === "accepted" ? "Production" : "Amendment"} notice that could not be filed: ${title ? "the journal is not named" : "no manuscript title in the email"}. Subject: ${subject.slice(0, 80)}`,
    });
    continue;
  }

  const key = `${norm(title)}::${norm(journal)}::${event}`;
  if (seenKey.has(key)) {
    // The same milestone arrives twice; the copy that carries the DOI is the
    // more useful one, so fold it into the record already filed.
    const kept = seenKey.get(key);
    if (doi && !kept.doi) kept.doi = doi;
    if (number && !kept.manuscript_number) kept.manuscript_number = number;
    drop("duplicate notice");
    continue;
  }

  bump(event);
  const row = {
    ...base, relevant: true, exclude_reason: "none",
    title, journal, manuscript_number: number,
    event_type: event, revision_round: null, doi,
    publication_link: null,
    summary:
      event === "published" ? "Published online." :
      event === "accepted" ? "In production after acceptance." :
      event === "sent_back" ? "Returned to the author for amendments before the submission can progress." :
      event === "under_review" ? "Revised manuscript submitted." :
      "Submission acknowledged.",
    needsReview: false,
  };
  seenKey.set(key, row);
  classified.push(row);
}

await writeFile(OUT, JSON.stringify({ classified }, null, 2) + "\n", "utf-8");
console.log(`${rows.length} unclear emails`);
Object.entries(tally).sort((a, b) => b[1] - a[1]).forEach(([k, v]) => console.log(`  ${String(v).padStart(4)}  ${k}`));
console.log("\nfiled:");
classified.filter((c) => c.relevant).forEach((c) =>
  console.log(`  ${c.internalDate.slice(0, 10)} ${c.event_type.padEnd(18)} ${(c.journal || "").slice(0, 34).padEnd(36)} ${c.title.slice(0, 62)}`));
