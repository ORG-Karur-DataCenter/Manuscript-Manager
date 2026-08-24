// Sathish, SUBMISSION bucket. A single submission generates many notifications
// -- author confirmation, co-author notice, tracking link, editor assignment --
// so filing every one would bury the timeline in near-identical rows. File the
// earliest per (manuscript, journal) and record the rest as duplicates.
import { readFile, writeFile } from "node:fs/promises";
import { bucketOf } from "./triage.mjs";
import { journalFromBody, journalFromSubject, canonicalJournal, decode } from "./extract.mjs";

const data = JSON.parse(await readFile(process.argv[2], "utf-8"));
const OUT = process.argv[3];
const REGISTRY = process.argv[4];
const ACCOUNT = "Sathish Muthu";
const SYSTEM = /(editorialmanager|manuscriptcentral|springernature|wjgnet|frontiersin|mdpi|wiley|elsevier|sagepub|bmj|biomedcentral|tandfonline|lww|karger|thieme|researchsquare|jbjs)/i;

// Billing, metrics and marketing ride the same submission-shaped subject lines.
const NOT_SUBMISSION = /article processing charge|invoice|payment|receipt of payment|article metrics|update on your article|citation|altmetric|reviewer voucher|discount|newsletter|table of contents|call for papers/i;
// Proofs and galleys sit after acceptance, so they say nothing about when a
// paper entered a journal -- and filing them as a submission would backdate
// the wrong event. The acceptance itself came through the decision import.
const PRODUCTION = /proofs? (?:for|of) your|pdf (?:of your article )?has been built|requires approval|galley|page proof|e-?proof/i;

const known = REGISTRY
  ? [...new Set(JSON.parse(await readFile(REGISTRY, "utf-8")).manuscripts.map((m) => m.currentJournal).filter(Boolean))]
  : [];

// Label patterns run against text that still has its line breaks -- the title
// sits alone on its line, and collapsing newlines is what let the lazy match
// run past it into the next paragraph.
// A long title wraps, so run to the next "Label:" line rather than the next
// newline; fall back to one line when no label follows.
const TITLE_LABELLED = [
  /^[ \t]*(?:Manuscript |Article |Paper )?Title[ \t]*:[ \t]*([\s\S]{15,400}?)[ \t]*\n[ \t]*(?=[A-Z][A-Za-z ]{2,28}:)/im,
  /^[ \t]*(?:Manuscript |Article )?Title of (?:the )?(?:manuscript|article|paper)[ \t]*:[ \t]*([\s\S]{15,400}?)[ \t]*\n[ \t]*(?=[A-Z][A-Za-z ]{2,28}:)/im,
  /^[ \t]*(?:Manuscript |Article |Paper )?Title[ \t]*:[ \t]*(.{15,300})$/im,
  /^[ \t]*(?:Manuscript |Article )?Title of (?:the )?(?:manuscript|article|paper)[ \t]*:[ \t]*(.{15,300})$/im,
];
const TITLE = [
  /(?:submission|manuscript|article) entitled[:,]?\s*["“']?([^"“”'\n]{15,300}?)["”']?(?:\s+has been|\s+which you|\s+to\s+the\b|$)/i,
  /entitled[:,]?\s*["“']([^"“”'\n]{15,300})["”']/i,
  /Your manuscript[:,]?\s+["“']?([^"“”'\n]{15,300}?)["”']?\s+(?:has been|was)/i,
  /Re:\s*["“']([^"“”'\n]{15,300})["”']/i,
  /manuscript[,]?\s+["“']([^"“”'\n]{15,300})["”']/i,
  /titled\s+["“']([^"“”'\n]{15,300})["”']/i,
];
// "you may be entitled to a discount", "your manuscript submitted to X has
// been accepted", "Title: Original Article" and friends.
const TITLE_JUNK = /^(?:to\b|a\b|an\b|the following|original article|research article|review article|systematic review$|yes\b|no\b|n\/a|submitted\b|for consideration\b|will be given\b|has been\b|was\b|received\b|is\b|are\b)/i;

// "Submission Confirmation for <title>" makes the title look like a journal.
// A name that simply repeats the manuscript title is never the journal.
const sameText = (a, b) => {
  if (!a || !b) return false;
  const n = (x) => x.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
  return n(b).startsWith(n(a)) && n(a).length > 8;
};

const dedupeLeadingWord = (t) => t.replace(/^(\S+)\s+\1(\s)/i, "$1$2");

const norm = (s) =>
  s.toLowerCase().replace(/[^a-z0-9]+/g, " ").replace(/\s+/g, " ").trim().slice(0, 90);

const rows = data.candidates
  .filter((c) => SYSTEM.test(c.from || "") && bucketOf(c) === "SUBMISSION")
  .sort((a, b) => new Date(a.internalDate) - new Date(b.internalDate));

// Resolve every title to a journal first: the same paper often arrives as one
// email that names its journal and another that does not, and flagging the
// second for review would ask the user to identify something already known.
const resolved = new Map();

const classified = [];
const firstSeen = new Map();
let filed = 0, dupes = 0, flagged = 0, noTitle = 0, admin = 0;

const parsed = rows.map((c) => {
  const lined = decode(c.text || "").replace(/[ \t\r\u00a0]+/g, " ").replace(/\n[ ]?/g, "\n");
  const flat = lined.replace(/\s+/g, " ");

  let title = null;
  for (const p of [...TITLE_LABELLED, ...TITLE]) {
    const m = p.exec(TITLE_LABELLED.includes(p) ? lined : flat);
    if (!m || !m[1]) continue;
    const t = m[1].replace(/\s+/g, " ").trim().replace(/^["“']|["”'.,\s]+$/g, "").trim();
    if (t.length < 15 || TITLE_JUNK.test(t)) continue;
    if (!/\s/.test(t)) continue;
    title = dedupeLeadingWord(t);
    break;
  }

  let journal = canonicalJournal(
    journalFromBody(c.text || "") || journalFromSubject(c.subject),
    known
  );
  if (sameText(journal, title)) journal = null;
  const noise = NOT_SUBMISSION.test(c.subject || "") || PRODUCTION.test(c.subject || "");
  if (title && journal && !noise) resolved.set(norm(title), journal);
  return { c, title, journal, noise };
});

for (const { c, title, journal, noise } of parsed) {
  const base = {
    id: c.id, subject: c.subject, from: c.from,
    internalDate: c.internalDate, account: ACCOUNT,
  };
  const drop = () => classified.push({ ...base, relevant: false, exclude_reason: "unrelated", needsReview: false });

  if (noise) { admin++; drop(); continue; }
  if (!title) { noTitle++; drop(); continue; }

  // Another email already placed this paper, so a second notice that omits the
  // journal adds nothing -- it is not something the user needs to resolve.
  if (!journal && resolved.has(norm(title))) { dupes++; drop(); continue; }

  const key = `${norm(title)}::${journal ? norm(journal) : "?"}`;
  if (firstSeen.has(key)) { dupes++; drop(); continue; }
  firstSeen.set(key, { id: c.id, title, journal });

  if (!journal) {
    flagged++;
    classified.push({
      ...base, relevant: false, exclude_reason: "unrelated", needsReview: true,
      title,
      reviewReason: `Submission notice for "${title.slice(0, 90)}" but the email never names the journal, so it cannot be filed. Identify the journal and add it.`,
    });
    continue;
  }

  filed++;
  classified.push({
    ...base, relevant: true, exclude_reason: "none",
    title, journal, manuscript_number: null,
    event_type: "new_submission", revision_round: null, doi: null, publication_link: null,
    summary: "Submission acknowledged.", needsReview: false,
  });
}

await writeFile(OUT, JSON.stringify({ classified }, null, 2) + "\n", "utf-8");
console.log(`${rows.length} submission emails`);
console.log(`  filed as new_submission : ${filed}`);
console.log(`  duplicate notifications : ${dupes}`);
console.log(`  billing / metrics noise : ${admin}`);
console.log(`  title but no journal    : ${flagged} (flagged for review)`);
console.log(`  no extractable title    : ${noTitle}`);
console.log("\nfiled:");
for (const v of firstSeen.values()) {
  if (v.journal) console.log("  ", v.journal.slice(0, 40).padEnd(42), v.title.slice(0, 76));
}
