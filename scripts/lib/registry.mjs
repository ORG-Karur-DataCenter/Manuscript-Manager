const STATUS_LABELS = {
  new_submission: "Submitted",
  under_review: "Under review",
  revision_requested: "Revision requested",
  sent_back: "Sent back for edits",
  accepted: "Accepted (awaiting publication)",
  rejected: "Rejected",
  published: "Published",
  transferred: "Transferred to another journal",
  other: "Update",
};

export function normalizeTitle(title) {
  return (title || "")
    .toLowerCase()
    // "&" and "and" are the same word, and journals use both for one title.
    // Stripping the ampersand as punctuation left "Incidence & Recovery" and
    // "Incidence and Recovery" as different keys -- which now means a second
    // record, since an exact title is what identifies a paper.
    .replace(/&/g, " and ")
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9 ]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function slugify(title) {
  const norm = normalizeTitle(title).replace(/ /g, "-");
  return (norm || "untitled").slice(0, 70);
}

function bigrams(str) {
  const set = new Set();
  for (let i = 0; i < str.length - 1; i++) set.add(str.slice(i, i + 2));
  return set;
}

/** Dice coefficient over character bigrams — tolerant of small wording/case differences between journals. */
export function titleSimilarity(a, b) {
  const na = normalizeTitle(a);
  const nb = normalizeTitle(b);
  if (!na || !nb) return 0;
  if (na === nb) return 1;
  const ba = bigrams(na);
  const bb = bigrams(nb);
  if (ba.size === 0 || bb.size === 0) return 0;
  let overlap = 0;
  for (const g of ba) if (bb.has(g)) overlap++;
  return (2 * overlap) / (ba.size + bb.size);
}


/**
 * Fields a person may set by hand, overriding whatever the classifier reads
 * from the email. Each is mirrored onto the manuscript so the rest of the app
 * and the dashboard need no special case -- the override is the record of
 * WHY the value is what it is, and the guarantee that a later email will not
 * quietly undo it.
 *
 * This list is duplicated in worker/src/index.js, which applies edits without
 * being able to import from here. Keep the two in step.
 */
export const OVERRIDABLE = [
  "bucket",
  "title",
  "currentJournal",
  "currentStatus",
  "currentManuscriptNumber",
  "deadline",
  "doi",
  "publicationLink",
  "notes",
];

/** True when a person has pinned this field, so an event must leave it alone. */
export function isPinned(manuscript, field) {
  const o = manuscript && manuscript.overrides;
  return Boolean(o && Object.prototype.hasOwnProperty.call(o, field));
}

function findByManuscriptNumber(registry, journal, manuscriptNumber) {
  if (!manuscriptNumber || !journal) return null;
  const j = journal.trim().toLowerCase();
  const mn = manuscriptNumber.trim().toLowerCase();
  for (const m of registry.manuscripts) {
    for (const s of m.submissions) {
      if (
        s.manuscriptNumber &&
        s.manuscriptNumber.trim().toLowerCase() === mn &&
        s.journal.trim().toLowerCase() === j
      ) {
        return m;
      }
    }
  }
  return null;
}

/**
 * The score that used to merge two records. It now only raises a question.
 *
 * Accepting a Dice score of 0.82 merged two real papers: "How Does Pelvic
 * Fixation Fail in Adult Spinal Deformity? A Construct-Stratified Systematic
 * Review and Meta-Analysis" scores 0.835 against "How Often Does Pelvic
 * Fixation Fail After Adult Spinal Deformity Surgery? A Systematic Review and
 * Proportional Meta-Analysis". They are separate studies; one record absorbed
 * the other's rejection, and the rejected paper looked like it had never been
 * submitted at all.
 *
 * No threshold fixes that. Scored across every title in this registry, the
 * closest pair of genuinely different papers reaches 0.815 -- two hundredths
 * below the pair that must not merge. Titles in one speciality share too much
 * vocabulary for character bigrams to carry identity, and word overlap
 * separates them no better: unrelated papers reach 0.667 where the wrongly
 * merged pair scored 0.545.
 *
 * So identity now comes only from a manuscript number, an exact title, or a
 * title someone recorded by hand as an alias. A near miss opens its own record
 * and asks, which is the one thing a machine can do here without guessing.
 */
const NEAR_MISS_THRESHOLD = 0.82;

/**
 * Matches on every title a manuscript has been known by, not just its current
 * one. Journals keep sending the title they were given, so once someone
 * corrects a title by hand the old wording has to keep matching -- otherwise
 * the next email opens a second record and the history splits in two.
 *
 * Returns the exact match if there is one, and otherwise the nearest title
 * that a human should look at, so the caller can flag the new record rather
 * than file it under the wrong paper.
 */
function findByTitle(registry, title) {
  const target = normalizeTitle(title);
  if (!target) return { manuscript: null, nearMiss: null };

  let near = null;
  let nearScore = 0;
  for (const m of registry.manuscripts) {
    for (const known of [m.title, ...(m.titleAliases || [])]) {
      if (normalizeTitle(known) === target) return { manuscript: m, nearMiss: null };
      const score = titleSimilarity(known, title);
      if (score > nearScore) {
        nearScore = score;
        near = m;
      }
    }
  }

  const nearMiss =
    near && nearScore >= NEAR_MISS_THRESHOLD ? { manuscript: near, score: nearScore } : null;
  return { manuscript: null, nearMiss };
}

function uniqueId(registry, title) {
  const base = slugify(title);
  let id = base;
  let n = 2;
  const existing = new Set(registry.manuscripts.map((m) => m.id));
  while (existing.has(id)) {
    id = `${base}-${n++}`;
  }
  return id;
}

function findActiveSubmission(manuscript, journal) {
  const j = journal.trim().toLowerCase();
  return manuscript.submissions.find(
    (s) => s.journal.trim().toLowerCase() === j && s.outcome === "active"
  );
}

function bucketForEvent(eventType) {
  switch (eventType) {
    case "published":
      return { bucket: "published", needsActionReason: null };
    case "rejected":
      return { bucket: "needs_action", needsActionReason: "rejected_needs_resubmission" };
    case "sent_back":
      return { bucket: "needs_action", needsActionReason: "pre_review_edits" };
    case "new_submission":
      return { bucket: "submissions", needsActionReason: null };
    case "revision_requested":
      // Its own section. "In review" means the journal is working; a revision
      // request means YOU are, and the two were sitting in one pile.
      return { bucket: "revisions_pending", needsActionReason: null };
    case "under_review":
    case "accepted":
    case "transferred":
      return { bucket: "in_review", needsActionReason: null };
    default:
      return null; // "other" — don't move the bucket
  }
}

/**
 * Applies one classified email event to the registry in place.
 * event: { title, journal, manuscriptNumber, eventType, revisionRound, doi,
 *          publicationLink, summary, timestamp, authorAccount, source, needsReview }
 */
export function applyEvent(registry, event) {
  const byNumber = findByManuscriptNumber(registry, event.journal, event.manuscriptNumber);
  const byTitle = byNumber ? null : findByTitle(registry, event.title);
  let manuscript = byNumber || byTitle?.manuscript || null;

  // One email describes one event. The sync window deliberately overlaps and a
  // re-import or a replayed run can present the same message twice, so filing
  // by message id keeps the timeline honest instead of accumulating duplicates.
  const messageId = event.source?.messageId;
  if (manuscript && messageId) {
    const seen = (manuscript.timeline || []).some((t) => t.source?.messageId === messageId);
    if (seen) return manuscript;
  }

  const now = event.timestamp;

  // The same notice can arrive twice with different message ids -- forwarded
  // from another mailbox, or sent by the journal to two co-authors who both
  // have inboxes here. The id check above cannot see that, so fall back to
  // what the event says: the same outcome, at the same journal, on the same
  // day is one event reported twice.
  //
  // Two exceptions keep this from losing real information. Differing
  // manuscript numbers mean two different papers, however alike the notices
  // look -- that alone would have merged World Journal of Orthopedics 116723
  // with 119301. And a duplicate still carries facts worth keeping: the
  // second copy is often the one bearing the DOI.
  if (manuscript) {
    const day = new Date(now).toISOString().slice(0, 10);
    const j = (event.journal || "").trim().toLowerCase();
    const num = (event.manuscriptNumber || "").trim().toLowerCase();
    const twin = (manuscript.timeline || []).find((t) => {
      if (t.eventType !== event.eventType) return false;
      if ((t.journal || "").trim().toLowerCase() !== j) return false;
      return new Date(t.timestamp).toISOString().slice(0, 10) === day;
    });
    if (twin) {
      const twinNum = (twin.manuscriptNumber || "").trim().toLowerCase();
      const differentPapers = num && twinNum && num !== twinNum;
      if (!differentPapers) {
        if (event.doi) manuscript.doi = event.doi;
        if (event.publicationLink) manuscript.publicationLink = event.publicationLink;
        for (const sub of manuscript.submissions) {
          if (sub.journal.trim().toLowerCase() !== j) continue;
          if (event.doi) sub.doi = event.doi;
          if (event.publicationLink) sub.publicationLink = event.publicationLink;
          if (!sub.manuscriptNumber && event.manuscriptNumber) {
            sub.manuscriptNumber = event.manuscriptNumber;
          }
        }
        return manuscript;
      }
    }
  }

  if (!manuscript) {
    manuscript = {
      id: uniqueId(registry, event.title),
      title: event.title,
      titleNormalized: normalizeTitle(event.title),
      bucket: "submissions",
      // A title close enough that the old matcher would have merged this into
      // an existing paper. It may be a rename; it may be a second study on the
      // same question. Only a person can tell, so the record stands on its own
      // and says who to compare it against -- adding the other title as an
      // alias merges them for good, and doing nothing leaves them apart.
      needsReview: Boolean(byTitle?.nearMiss),
      reviewReason: byTitle?.nearMiss
        ? `Title closely resembles "${byTitle.nearMiss.manuscript.title}" ` +
          `(${byTitle.nearMiss.score.toFixed(2)}). Confirm these are different papers.`
        : null,
      needsActionReason: null,
      actionFlag: false,
      actionLabel: null,
      currentJournal: null,
      currentManuscriptNumber: null,
      currentStatus: null,
      deadline: null,
      deadlineSource: null,
      doi: null,
      publicationLink: null,
      authorAccounts: [],
      submissions: [],
      timeline: [],
      createdAt: now,
      updatedAt: now,
    };
    registry.manuscripts.push(manuscript);
  }

  if (event.authorAccount && !manuscript.authorAccounts.includes(event.authorAccount)) {
    manuscript.authorAccounts.push(event.authorAccount);
  }

  // Mark any other active submission "transferred" out when a transfer event lands.
  if (event.eventType === "transferred") {
    for (const s of manuscript.submissions) {
      if (s.outcome === "active" && s.journal.trim().toLowerCase() !== event.journal.trim().toLowerCase()) {
        s.outcome = "transferred";
      }
    }
  }

  let submission = findActiveSubmission(manuscript, event.journal);

  // "other" is the classifier's shrug: a manuscript-status mail it could not
  // place. Opening a fresh live submission from one is how a transfer OFFER
  // from a journal that already rejected the paper becomes a phantom active
  // submission there, lifting a dead paper out of needs_action. Attach it to
  // the last submission at that journal instead, or to the timeline alone.
  if (!submission && event.eventType === "other") {
    const j = event.journal.trim().toLowerCase();
    const prior = manuscript.submissions.filter((s) => s.journal.trim().toLowerCase() === j);
    submission = prior[prior.length - 1] || null;
  }

  if (!submission && event.eventType !== "other") {
    submission = {
      journal: event.journal,
      manuscriptNumber: event.manuscriptNumber || null,
      submittedDate: now,
      outcome: "active",
      status: event.eventType,
      doi: null,
      publicationLink: null,
      statusHistory: [],
    };
    manuscript.submissions.push(submission);
  }

  if (submission) {
    submission.manuscriptNumber = event.manuscriptNumber || submission.manuscriptNumber;
    if (event.eventType !== "other") submission.status = event.eventType;
    if (event.doi) submission.doi = event.doi;
    if (event.publicationLink) submission.publicationLink = event.publicationLink;
    if (event.eventType === "rejected") submission.outcome = "rejected";
    if (event.eventType === "published") submission.outcome = "published";

    submission.statusHistory.push({
      timestamp: now,
      eventType: event.eventType,
      revisionRound: event.revisionRound || null,
      note: event.summary || "",
      manuscriptNumber: event.manuscriptNumber || null,
      source: event.source,
    });
  }

  manuscript.timeline.push({
    timestamp: now,
    journal: event.journal,
    eventType: event.eventType,
    manuscriptNumber: event.manuscriptNumber || null,
    label: STATUS_LABELS[event.eventType] || event.eventType,
    revisionRound: event.revisionRound || null,
    deadline: event.deadline || null,
    note: event.summary || "",
    source: event.source,
    needsReview: event.needsReview || false,
  });

  // Sticky: once the two classifiers disagreed about this manuscript, it stays
  // flagged until a human clears it, even if later events land cleanly.
  if (event.needsReview) manuscript.needsReview = true;
  manuscript.timeline.sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp));

  // Title may be reformatted slightly journal to journal — keep the longest/most complete version.
  // Unless someone has corrected it by hand, in which case theirs stands.
  //
  // An event only reaches an existing record now if its title matched exactly
  // once normalised, so the difference here is punctuation or capitalisation,
  // never a rename. Recording the old wording as an alias would add a key that
  // already matches. Renames are recorded by applyEdit, where a person says so.
  if (!isPinned(manuscript, "title") && event.title && event.title.length > manuscript.title.length) {
    manuscript.title = event.title;
    manuscript.titleNormalized = normalizeTitle(event.title);
  }

  // A backfilled event can land after later ones were already recorded, so
  // sort here too rather than relying on arrival order.
  if (submission) {
    submission.statusHistory.sort(
      (a, b) => new Date(a.timestamp) - new Date(b.timestamp)
    );
  }

  // Submissions read as a chain, so keep them in the order they were made
  // rather than the order the emails happened to be processed.
  manuscript.submissions.sort(
    (a, b) => new Date(a.submittedDate) - new Date(b.submittedDate)
  );

  // Where the manuscript stands *today* may only be set by its newest event.
  // Events do arrive out of order — a historical backfill, an email deferred by
  // a rate limit, a forwarded copy carrying the original date — and letting a
  // stale one write current status is how a rejected paper ends up filed as
  // "in review". Older events still join the timeline; they just don't get to
  // speak for the present. The timeline is sorted, so the last entry is newest.
  const newest = manuscript.timeline[manuscript.timeline.length - 1];
  const isNewest = new Date(now).getTime() >= new Date(newest.timestamp).getTime();

  if (isNewest) {
    const derived = bucketForEvent(event.eventType);
    // A section chosen by hand outranks the one inferred from the email. The
    // event still joins the timeline; it just does not get to move the card.
    if (derived && !isPinned(manuscript, "bucket")) {
      manuscript.bucket = derived.bucket;
      manuscript.needsActionReason = derived.needsActionReason;
    }
    // What the person actually has to do something about. Amendments belong
    // here as much as revisions do -- more, in fact, since they run on a clock
    // of five to fourteen days and a missed one withdraws the submission. They
    // were previously left unflagged, which is why some sat unnoticed.
    const ACTION_NEEDED = { revision_requested: true, sent_back: true };
    manuscript.actionFlag = Boolean(ACTION_NEEDED[event.eventType]);
    manuscript.actionLabel =
      event.eventType === "revision_requested"
        ? `Revision ${event.revisionRound || ""} requested`.trim()
        : event.eventType === "sent_back"
        ? "Amendments requested"
        : null;

    // The deadline follows the event that set it, and is cleared by any event
    // that ends the obligation -- the author has resubmitted, or the journal
    // has moved on. Leaving a stale date behind would go on raising alarms
    // about work that is already done.
    // Held flat -- an ISO date and, separately, where it came from -- so that
    // correcting one by hand is an ordinary text edit like any other field.
    // A hand-set date is pinned, and a pinned date outranks anything an email
    // says, so provenance is left alone as well.
    if (!isPinned(manuscript, "deadline")) {
      const set = ACTION_NEEDED[event.eventType] ? event.deadline : null;
      manuscript.deadline = set ? set.due : null;
      manuscript.deadlineSource = set ? set.source : null;
    }

    // "other" means the classifier could not place the email. bucketForEvent
    // already refuses to move the bucket for it; current status follows the
    // same principle, or a real "Rejected" gets overwritten with "Update".
    if (submission && event.eventType !== "other") {
      if (!isPinned(manuscript, "currentJournal")) manuscript.currentJournal = submission.journal;
      if (!isPinned(manuscript, "currentManuscriptNumber")) {
        manuscript.currentManuscriptNumber = submission.manuscriptNumber;
      }
      if (!isPinned(manuscript, "currentStatus")) {
        manuscript.currentStatus = STATUS_LABELS[event.eventType] || event.eventType;
      }
    }
  }

  // A DOI or article link is a fact about the manuscript, not a status, so it
  // is worth keeping whenever it turns up.
  if (event.doi && !isPinned(manuscript, "doi")) manuscript.doi = event.doi;
  if (event.publicationLink && !isPinned(manuscript, "publicationLink")) {
    manuscript.publicationLink = event.publicationLink;
  }
  manuscript.updatedAt = newest.timestamp;

  return manuscript;
}

/**
 * Applies a hand edit to one manuscript, in place.
 *
 * Setting a field pins it: applyEvent will leave it alone from then on, so an
 * email arriving later cannot quietly revert a correction. Passing null for a
 * field unpins it and hands the field back to the classifier -- which is the
 * only way out, since otherwise a single mistaken edit would be permanent.
 *
 * Every change is recorded with its previous value. A tracker two people rely
 * on needs to be able to answer "who changed this and to what" months later,
 * and the timeline is reserved for what the journals said.
 *
 * This logic is mirrored in worker/src/index.js, which cannot import from
 * here. Keep the two in step.
 */
export function applyEdit(manuscript, patch, { at = new Date().toISOString(), by = "dashboard" } = {}) {
  if (!manuscript) throw new Error("No manuscript to edit.");
  manuscript.overrides ||= {};
  manuscript.edits ||= [];
  const changed = [];

  for (const [field, raw] of Object.entries(patch || {})) {
    if (!OVERRIDABLE.includes(field)) {
      throw new Error(`"${field}" is not an editable field.`);
    }
    const value = typeof raw === "string" ? raw.trim() : raw;
    const before = manuscript[field] ?? null;

    // Null, or an emptied text box, releases the field back to automation.
    if (value === null || value === "") {
      if (!Object.prototype.hasOwnProperty.call(manuscript.overrides, field)) continue;
      delete manuscript.overrides[field];
      changed.push({ field, from: before, to: null, released: true });
      continue;
    }

    if (before === value && isPinned(manuscript, field)) continue;
    manuscript.overrides[field] = value;
    manuscript[field] = value;
    changed.push({ field, from: before, to: value });
  }

  if (!changed.length) return { manuscript, changed };

  // Renaming a manuscript must keep it findable, or the next email about it
  // opens a second record alongside the first. Journals go on sending the
  // title they were given, so every previous title stays a matching key.
  const renamed = changed.find((c) => c.field === "title");
  if (renamed) {
    manuscript.titleNormalized = normalizeTitle(manuscript.title);
    manuscript.titleAliases ||= [];
    const previous = renamed.from;
    if (previous && !manuscript.titleAliases.includes(previous) && previous !== manuscript.title) {
      manuscript.titleAliases.push(previous);
    }
  }
  // A section chosen by hand carries no automated reason for being there.
  if (changed.some((c) => c.field === "bucket" && !c.released)) {
    manuscript.needsActionReason = null;
    manuscript.actionFlag = false;
    manuscript.actionLabel = null;
    // A deadline outlives its purpose the moment the work stops being
    // outstanding. Without this, someone who knows an amendment is done can
    // move the card and still be left with a date counting up at them, and no
    // way to switch it off: an emptied date box only releases a pin, so on a
    // deadline the sync set it does nothing at all.
    if (!isPinned(manuscript, "deadline") && manuscript.deadline) {
      manuscript.deadline = null;
      manuscript.deadlineSource = null;
      changed.push({ field: "deadline", from: manuscript.deadline, to: null, clearedByMove: true });
    }
  }

  manuscript.edits.push({ at, by, changes: changed });
  manuscript.editedAt = at;
  return { manuscript, changed };
}
