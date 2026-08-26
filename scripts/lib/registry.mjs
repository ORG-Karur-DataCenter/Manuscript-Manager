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
    if (derived) {
      manuscript.bucket = derived.bucket;
      manuscript.needsActionReason = derived.needsActionReason;
    }
    manuscript.actionFlag = event.eventType === "revision_requested";
    manuscript.actionLabel =
      event.eventType === "revision_requested"
        ? `Revision ${event.revisionRound || ""} requested`.trim()
        : null;

    // "other" means the classifier could not place the email. bucketForEvent
    // already refuses to move the bucket for it; current status follows the
    // same principle, or a real "Rejected" gets overwritten with "Update".
    if (submission && event.eventType !== "other") {
      manuscript.currentJournal = submission.journal;
      manuscript.currentManuscriptNumber = submission.manuscriptNumber;
      manuscript.currentStatus = STATUS_LABELS[event.eventType] || event.eventType;
    }
  }

  // A DOI or article link is a fact about the manuscript, not a status, so it
  // is worth keeping whenever it turns up.
  if (event.doi) manuscript.doi = event.doi;
  if (event.publicationLink) manuscript.publicationLink = event.publicationLink;
  manuscript.updatedAt = newest.timestamp;

  return manuscript;
}
