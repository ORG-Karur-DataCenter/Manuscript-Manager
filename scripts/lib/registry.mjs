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

const MATCH_THRESHOLD = 0.82;

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

function findByTitle(registry, title) {
  let best = null;
  let bestScore = 0;
  for (const m of registry.manuscripts) {
    const score = titleSimilarity(m.title, title);
    if (score > bestScore) {
      bestScore = score;
      best = m;
    }
  }
  return bestScore >= MATCH_THRESHOLD ? best : null;
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
    case "under_review":
    case "revision_requested":
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
  let manuscript =
    findByManuscriptNumber(registry, event.journal, event.manuscriptNumber) ||
    findByTitle(registry, event.title);

  const now = event.timestamp;

  if (!manuscript) {
    manuscript = {
      id: uniqueId(registry, event.title),
      title: event.title,
      titleNormalized: normalizeTitle(event.title),
      bucket: "submissions",
      needsReview: false,
      needsActionReason: null,
      actionFlag: false,
      actionLabel: null,
      currentJournal: null,
      currentManuscriptNumber: null,
      currentStatus: null,
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
  if (!submission) {
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

  submission.manuscriptNumber = event.manuscriptNumber || submission.manuscriptNumber;
  submission.status = event.eventType;
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

  manuscript.timeline.push({
    timestamp: now,
    journal: event.journal,
    eventType: event.eventType,
    label: STATUS_LABELS[event.eventType] || event.eventType,
    revisionRound: event.revisionRound || null,
    note: event.summary || "",
    source: event.source,
    needsReview: event.needsReview || false,
  });

  // Sticky: once the two classifiers disagreed about this manuscript, it stays
  // flagged until a human clears it, even if later events land cleanly.
  if (event.needsReview) manuscript.needsReview = true;
  manuscript.timeline.sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp));

  // Title may be reformatted slightly journal to journal — keep the longest/most complete version.
  if (event.title && event.title.length > manuscript.title.length) {
    manuscript.title = event.title;
    manuscript.titleNormalized = normalizeTitle(event.title);
  }

  const derived = bucketForEvent(event.eventType);
  if (derived) {
    manuscript.bucket = derived.bucket;
    manuscript.needsActionReason = derived.needsActionReason;
  }
  manuscript.actionFlag = event.eventType === "revision_requested";
  manuscript.actionLabel =
    event.eventType === "revision_requested"
      ? `Revision ${event.revisionRound || ""} requested`.trim()
      : null;

  manuscript.currentJournal = submission.journal;
  manuscript.currentManuscriptNumber = submission.manuscriptNumber;
  manuscript.currentStatus = STATUS_LABELS[event.eventType] || event.eventType;
  if (event.doi) manuscript.doi = event.doi;
  if (event.publicationLink) manuscript.publicationLink = event.publicationLink;
  manuscript.updatedAt = now;

  return manuscript;
}
