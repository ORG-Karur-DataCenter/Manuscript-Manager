// Journal-name extraction that stops at the end of the name.
//
// The earlier regex used a lazy [A-Za-z ]+? run, which happily swallowed the
// words that follow the name ("World Journal of Orthopedics manus...").
// Journal names are title case with a small set of lowercase joiners, so walk
// the tokens and stop at the first one that cannot belong to a name.

const ENTITIES = [
  [/&ndash;|&#8211;/gi, "–"], [/&mdash;|&#8212;/gi, "—"],
  [/&amp;/gi, "&"], [/&nbsp;/gi, " "], [/&quot;/gi, '"'], [/&#39;|&rsquo;/gi, "'"],
];
export function decode(s) {
  let out = s;
  for (const [re, to] of ENTITIES) out = out.replace(re, to);
  return out;
}

const JOINER = /^(?:of|and|in|for|the|on|&|-|–|—)$/i;
const WORD = /^[A-Z][A-Za-z'’.]*$/;
// A handful of journals are styled lower-case by their own publisher: Nature
// Portfolio's whole npj family, eLife, the preprint servers. The capital-first
// rule is what stops an ordinary sentence word being read as a name, so widen
// it by naming the exceptions rather than relaxing it for everything.
const LOWERCASE_BRAND = /^(?:npj|eLife|medRxiv|bioRxiv|arXiv)$/i;
const isNameWord = (tok) => WORD.test(tok) || LOWERCASE_BRAND.test(tok);
const STOP_AT = /[.,;:()\[\]"“”!?]/;
// Single-word journals the tracker actually sees; a lone capitalised word is
// otherwise far more likely to be a person or a sentence start.
const SOLO = new Set(["cells", "cartilage", "cureus", "biomedicines", "diagnostics", "medicina", "bioengineering", "life", "gels", "biology"]);
const JOURNALISH = /journal|spine|health|medicine|orthopa?ed|surgery|cells?|cartilage|research|reviews|lancet|bmj|annals|frontiers|cureus|arthroplasty|epidemiolog|geriatric|gastroenterolog|oncolog|radiolog|cases|science|reports|nature|plos|ssm|jbjs|osteoporosis|tissue|biomaterials|methodology|biolog|rheumat|neuro|paediatr|pediatr|clinical|therapy|materials|bone|joint|trauma|sports/i;
const NOT_A_JOURNAL = /^(?:Dr|Dear|Mr|Ms|Mrs|Prof|Professor|Sincerely|Regards|Best|Thank|Please|Your|Our|This|That|These|Those|We|You|It|If|As|An|A|The Editor|Editorial|Manuscript|Submission|Author|Corresponding)$/i;

function takeName(rest) {
  let s = rest.replace(/^\s+/, "");
  // Skip the words that introduce a name rather than belong to it:
  // "Editors of the World Journal of…", "Confirmation Journal of Arthroplasty".
  for (let i = 0; i < 6; i++) {
    const lead = /^(?:Editors?|Editorial|Office|Confirmation|Confirm(?:ing)?|Re|Fwd|FW|the|of)\s+(?=[A-Za-z])/i.exec(s);
    if (!lead) break;
    s = s.slice(lead[0].length);
  }
  const tokens = [];
  while (s.length) {
    const m = /^([^\s.,;:()\[\]"“”!?]+)([\s.,;:()\[\]"“”!?]|$)/.exec(s);
    if (!m) break;
    const tok = m[1];
    const isFirst = tokens.length === 0;
    const ok = isFirst ? isNameWord(tok) : isNameWord(tok) || JOINER.test(tok);
    if (!ok) break;
    if (isFirst && NOT_A_JOURNAL.test(tok)) return null;
    tokens.push(tok);
    s = s.slice(m[1].length);
    if (STOP_AT.test(s[0] || "")) break;                 // name ended at punctuation
    s = s.replace(/^\s+/, "");
    if (tokens.length > 9) break;
  }
  // Cut at the first word that belongs to the surrounding sentence rather
  // than the name ("Indian Journal of Orthopaedics - Submission Confirmation
  // Evaluation of allelic variants…").
  const TRAILING = /^(?:Reply|Manuscript|Ms|No|ID|Submission|Submitted|Confirmation|Confirming|Confirmed|Notification|Notifications|Notice|Decision|Received|Receipt|Assigned|Number|Letter|Instructions|Update|Status|Publication|Proof|Proofs|Decline|Declined|Accepted|Acceptance|Rejected|Revision|Review|Editorial|Office|Team|Article|Paper|Author|Authors|Reviewer|Reviewers|Thank|Sincerely|Regards|Dear|Has|Have|Been|Your|You|Next|Steps|Pending|Complete|Corrections|Production|Tables|Information|Regarding|Copyright|License|Please|Login|Approve|Re|Fwd|Based|Confirmation|Confirm|Confirming|Successfully|Sincerely|You're|Youre|We're|It's)$/i;
  const cut = tokens.findIndex((t, i) => i > 0 && TRAILING.test(t));
  if (cut > 0) tokens.length = cut;
  while (tokens.length && JOINER.test(tokens[tokens.length - 1])) tokens.pop();
  if (!tokens.length) return null;
  const name = tokens.join(" ");
  // A lone word is usually a sentence start, unless it names a journal
  // outright ("Cells") or reads like one ("ClinSpineSurgery").
  if (tokens.length === 1 && !SOLO.has(name.toLowerCase()) && !(name.length >= 8 && JOURNALISH.test(name))) return null;
  if (name.length < 4) return null;
  return name;
}

// MDPI states the journal outright; trust that over anything inferred.
const NAMED = /Journal name:\s*([^\n]{3,70}?)(?:\s+Manuscript ID|\s*[\n]|$)/i;

const CONTEXTS = [
  /submitted (?:to|for publication in)\s/gi,
  /consideration (?:of|for) publication in\s/gi,
  /(?:for|your) publication in\s/gi,
  /under consideration (?:at|by|in)\s/gi,
  /status of your (?:manuscript|submission|paper) (?:to|at|in)\s/gi,
  /received by journal\s/gi,
  /\bby journal\s/gi,
  /submission to\s/gi,
  /manuscript(?: title)? to\s/gi,
  /["”’']\s*,?\s*to\s/g,
  /\bDesk Editor(?: Team)?\s/gi,
  /on behalf of\s/gi,
];

export function journalFromBody(rawBody) {
  const body = decode(rawBody).replace(/\s+/g, " ");
  const named = NAMED.exec(body);
  if (named) {
    const n = named[1].trim().replace(/[.,;:]+$/, "");
    if (n.length >= 4) return n;
  }
  for (const re of CONTEXTS) {
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(body))) {
      const name = takeName(body.slice(m.index + m[0].length));
      if (name && JOURNALISH.test(name)) return name;
    }
  }
  return null;
}

// Subject lines are usually "[Cells] …", "Journal Name - something",
// "Journal Name Manuscript …" or "… submitted to Journal Name".
export function journalFromSubject(rawSubject) {
  // The quoted span in a subject is the manuscript title, never the journal,
  // and leaving it in lets a preposition inside the title start a match.
  const s = decode(rawSubject || "")
    .replace(/["“][^"“”]{15,300}["”]/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  // "Re: European Spine Journal-Amendment required" -- no space around the dash,
  // so the name and the next word read as one token.
  const suffix = /^(?:Re:\s*|Fwd:\s*)?(.+?)\s*[-–]\s*(?:Amendment required|Next steps|Submission Confirmation|ToC Alert)/i.exec(s);
  if (suffix) {
    const n = takeName(suffix[1]);
    if (n && JOURNALISH.test(n)) return n;
  }

  const br = /^\[([^\]]{3,60})\]/.exec(s);
  if (br && !/^\d/.test(br[1])) {
    const n = br[1].trim();
    if (!/manuscript|submission|decision|review/i.test(n)) return n;
  }

  // "… in European Spine Journal", "submitted to Journal of Evaluation in …"
  const PREP = /\b(?:submi(?:tted|ssion)|article|manuscript|co-authorship|proofs?|publication)\b[^\n]{0,30}?\b(?:in|to|at|for)\s+/gi;
  let p;
  while ((p = PREP.exec(s))) {
    const n = takeName(s.slice(p.index + p[0].length));
    if (n && JOURNALISH.test(n)) return n;
  }

  // "World Journal of Stem Cells Notification that …" -- the name leads.
  const lead = takeName(s.replace(/^(?:Re|Fwd|FW)\s*:\s*/i, ""));
  if (lead && JOURNALISH.test(lead)) return lead;

  // "Please make changes to your Clinical Spine Surgery submission"
  const poss = /\b(?:your|the)\s+(.+?)\s+(?:submission|manuscript|article|paper)\b/i.exec(s);
  if (poss) {
    const n = takeName(poss[1]);
    if (n && JOURNALISH.test(n)) return n;
  }

  const dash = /^([A-Z][^\-–:|]{3,60}?)\s*[-–:|]\s/.exec(s);
  if (dash) {
    const n = takeName(dash[1]);
    if (n && JOURNALISH.test(n)) return n;
  }

  // Last resort: the name can sit anywhere ("Number ID: 05395420 World
  // Journal of Orthopedics decline letter"). Scan capitalised runs.
  const START = /(?:^|[\s:>\]])([A-Z])/g;
  let a;
  while ((a = START.exec(s))) {
    const n = takeName(s.slice(a.index + a[0].length - 1));
    if (n && JOURNALISH.test(n) && n.split(" ").length > 1) return n;
  }
  return null;
}

// Fold spelling variants onto the name the registry already uses, so a journal
// does not appear twice in the dashboard under near-identical labels.
const ALIASES = new Map(Object.entries({
  "the lancet regional health": "The Lancet Regional Health – Southeast Asia",
  "world journal of orthopaedics": "World Journal of Orthopedics",
  "int orthopaedics": "International Orthopaedics",
  "j arthroplasty": "The Journal of Arthroplasty",
  "journal of arthroplasty": "The Journal of Arthroplasty",
  "ssm population health": "SSM - Population Health",
  "clinspinesurgery": "Clinical Spine Surgery",
  "spine journal": "The Spine Journal",
  "experimental orthopaedics": "Journal of Experimental Orthopaedics",
  // Names that contain a comma; token walking stops at punctuation, so the
  // tail has to be restored by hand.
  "artificial cells": "Artificial Cells, Nanomedicine and Biotechnology",
  "bmc sports science": "BMC Sports Science, Medicine and Rehabilitation",
  "musculoskeletal surgery": "Musculoskeletal Surgery",
  "clinical spine surgery a spine publication": "Clinical Spine Surgery",
}));

export function canonicalJournal(name, known = []) {
  if (!name) return null;
  const clean = name.replace(/\s+/g, " ").trim().replace(/[.,;:]+$/, "");
  const key = clean.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
  for (const k of known) {
    if (k.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim() === key) return k;
  }
  return ALIASES.get(key) || clean;
}
