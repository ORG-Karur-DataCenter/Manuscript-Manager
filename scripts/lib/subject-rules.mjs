/**
 * Reading the mail that does not need reading.
 *
 * WHY THIS EXISTS. Seventy-three per cent of this tracker's events come from
 * four senders -- ScholarOne, Editorial Manager, Springer Nature and wjgnet --
 * which do not write emails so much as fill in forms. Paying a language model
 * to read a form letter is what exhausted the free-tier quota, and an
 * exhausted quota is what made a seven-month backfill file nothing at all
 * while reporting success. The cheapest classification is the one never sent.
 *
 * WHAT MAY BE A RULE. Only a subject line that means exactly one thing. That
 * is not a judgement call: check-subject-rules.mjs replays every rule against
 * every classified email in the registry and rejects any rule whose matches
 * disagree with each other. A rule that has ever been two things is not a
 * rule.
 *
 * WHAT MAY NOT. Decisions. "Global Spine Journal - Decision on Manuscript ID
 * GSJ-26-1654" is a rejection; the identical subject at the same journal is
 * elsewhere a revision request, and "European Spine Journal: Decision on your
 * manuscript" is in this registry both a revision request and an acceptance.
 * The outcome lives in the body, in prose, and that is precisely what a
 * language model is for. Every decision email still goes to the classifier.
 *
 * So this never overrules the classifier. It answers the easy half and hands
 * over the rest, and returning null is always allowed.
 */

/** Journals reply to threads; the prefix is not part of what the journal said. */
export function bareSubject(subject) {
  let s = (subject || "").trim();
  let previous = null;
  while (s !== previous) {
    previous = s;
    s = s.replace(/^\s*(re|fwd|fw|aw|tr)\s*:\s*/i, "");
  }
  return s.trim();
}

/**
 * Each rule is a subject pattern that has meant one thing every time it has
 * appeared. `why` is shown in the sync log and stored on the event, so a
 * wrongly-filed paper can be traced to the rule that filed it rather than
 * leaving "the computer decided" as the only explanation.
 */
export const SUBJECT_RULES = [
  // --- arriving ------------------------------------------------------------
  {
    id: "springer-track-status",
    test: /^track the status of your (manuscript|submission)\b/i,
    eventType: "new_submission",
    why: "Springer's tracking link, sent once on receipt",
  },
  {
    id: "springer-receipt",
    test: /\breceipt of manuscript\b/i,
    eventType: "new_submission",
    why: "Springer acknowledges receipt",
  },
  {
    id: "author-submission-ack",
    test: /\bauthor (new submission|resubmission) acknowledgement letter\b/i,
    eventType: "new_submission",
    why: "Editorial-system acknowledgement letter",
  },
  {
    id: "submission-confirmation",
    test: /\bsubmission confirmation\b/i,
    eventType: "new_submission",
    why: "The journal confirms a submission arrived",
  },
  {
    id: "complete-submission",
    test: /\bcomplete submission\b/i,
    eventType: "new_submission",
    why: "Submission completed in the journal's system",
  },

  // --- handed back before review -------------------------------------------
  {
    id: "amendment-required",
    test: /-\s*amendment required\b/i,
    eventType: "sent_back",
    why: "The editorial office wants the file changed before review",
  },
  {
    id: "not-as-per-instructions",
    test: /\barticle not as per instructions\b/i,
    eventType: "sent_back",
    why: "Returned for not following the journal's format",
  },
  {
    id: "return-to-author",
    test: /\b(return to author|returned to author centre)\b/i,
    eventType: "sent_back",
    why: "Returned to the author's queue",
  },
  {
    id: "incomplete-submission",
    test: /^incomplete submission to\b/i,
    eventType: "sent_back",
    why: "The submission is missing something the journal needs",
  },

  // --- moved elsewhere -----------------------------------------------------
  {
    id: "transfer-confirmed",
    test: /^(transfer confirmed for|successful transfer of your manuscript)\b/i,
    eventType: "transferred",
    why: "The manuscript was transferred to another journal",
  },

  // --- in print ------------------------------------------------------------
  {
    id: "springer-sharing-information",
    test: /^sharing information for\b/i,
    eventType: "published",
    why: "Springer's share link, sent on publication",
  },
  {
    id: "published-in-issue",
    test: /\byour article is published\b/i,
    eventType: "published",
    why: "The article has appeared in an issue",
  },

  /*
   * wjgnet announces most stages by name, but not all of them reliably: its
   * "Manuscript Publication-Manuscript NO: ..." and "has passed the technical
   * ..." subjects are both recorded in this registry against two different
   * event types, so neither is a rule. So is "Confirm co-authorship of
   * submission to ...", which is sometimes filed as the submission it implies
   * and sometimes as housekeeping.
   *
   * They may simply have been classified inconsistently -- but deciding which
   * label is right by hand is exactly the judgement this file is not allowed to
   * make. An ambiguous subject goes to the model.
   */
  {
    id: "wjgnet-revision-required",
    test: /^revision required for manuscript\b/i,
    eventType: "revision_requested",
    why: "wjgnet asks for a revision by name",
  },
  {
    id: "wjgnet-acceptance",
    test: /^acceptance of manuscript no\b/i,
    eventType: "accepted",
    why: "wjgnet accepts by name",
  },

  // --- housekeeping that is not about this paper's progress ----------------
];

/**
 * The classification a subject line settles on its own, or null to ask the
 * model. Null is the default and the safe answer.
 */
export function classifyBySubject(subject) {
  const bare = bareSubject(subject);
  if (!bare) return null;
  for (const rule of SUBJECT_RULES) {
    if (rule.test.test(bare)) {
      return { eventType: rule.eventType, rule: rule.id, why: rule.why };
    }
  }
  return null;
}
