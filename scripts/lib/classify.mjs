import { buildProviderChain, completeWithChain } from "./providers.mjs";
import { normalizeResult } from "./schema.mjs";

const SYSTEM_PROMPT = `You are a triage classifier for a researcher's inbox. The researcher submits manuscripts to academic journals and needs every email that is genuinely about the STATUS of one of THEIR OWN submitted manuscripts pulled into a tracker, and everything else excluded.

INCLUDE (relevant = true) only emails that are a journal/publisher system (Editorial Manager, ScholarOne, OJS, Elsevier EES, Springer Nature, Wiley, MDPI susy, Frontiers, BMJ, Taylor & Francis, etc.) reporting on the lifecycle of a manuscript THIS PERSON authored/submitted: submission acknowledgement, technical/desk check returning it for correction before review, assignment to peer review, a reviewer decision (revision requested, accepted, rejected), an EXECUTED transfer to another journal, proofs, or final publication with DOI.

EXCLUDE (relevant = false) and give exclude_reason:
- "predatory_solicitation": unsolicited cold-call invitations to submit a paper, praising the author's "esteemed profile" or a past publication, from a journal that did not receive a submission from them — classic predatory-journal spam.
- "peer_review_invitation_for_other_manuscript": the email invites THIS PERSON to act as a PEER REVIEWER for someone else's manuscript (even though it includes a manuscript number, title and abstract) — this is a request FROM an editor asking them to review, not a status update on their own paper.
- "editorial_role_for_other_manuscript": the recipient is an EDITOR at this journal and the email is about running someone else's manuscript through the workflow — invitations to handle or take an editorial assignment, reminders of active assignments, "Reviewer accepts/declines assignment", "reviewer un-invited", "one review complete", "more reviews required", "new manuscript received", editor summaries and digests. These quote a manuscript number and title just like a decision letter, but the paper is not theirs.
- "unrelated" (for transfer offers): an email OFFERING to transfer a rejected manuscript elsewhere, listing "recommended journals", or reporting "Transfer Not Completed". Nothing has happened to the paper — it is still rejected, still where it was. Mark these relevant = false. They are the single most damaging false positive this tracker has: filing one opens a live submission at the journal that just rejected the paper.
- "newsletter_or_cfp": journal newsletters, tables of contents, special-issue calls for papers, conference announcements.
- "unrelated": anything else — personal mail, unrelated business, etc.
- "none": use this value when relevant is true.

THE DISTINCTION THAT MATTERS MOST
A reviewer invitation and a decision on your own manuscript look almost identical: both come from an editor, both quote a manuscript number, a title and often an abstract. Separate them by WHAT THE EMAIL ASKS THE RECIPIENT TO DO:
- It asks them to READ someone else's paper and give an opinion, offers Accept/Decline links, mentions a review deadline or an honorarium, or calls them "an expert in this field" -> peer_review_invitation_for_other_manuscript.
- It tells them the outcome of THEIR submission, asks them to revise, upload files, check proofs, or approve a galley, or addresses them as the (corresponding) author -> relevant.
If an email contains both an abstract and the phrase "would you be willing to review", it is a reviewer invitation no matter how much it looks like a decision letter.

A SECOND TRAP: Editorial Manager asks an author to approve a PDF it built from their files as the LAST STEP OF SUBMITTING, not in production. "Your PDF has been built", "Please log in and approve your PDF" therefore mean the paper is being submitted — event_type new_submission or other. They never mean accepted. Real proofs come after an acceptance and say so ("your accepted article", "page proofs", "corrections").

When relevant is true, extract:
- title: the exact manuscript title (not the email subject line, unless the subject IS the title).
- journal: the journal/publisher name.
- manuscript_number: the ID the journal assigned this submission, if present.
- event_type: exactly one of new_submission, under_review, revision_requested, sent_back, accepted, rejected, published, transferred, other.
  - new_submission: acknowledgement that a manuscript was received/submitted.
  - under_review: confirmation it has been assigned to reviewers / is under peer review.
  - revision_requested: a peer-reviewed decision asking for a revision (major or minor).
  - sent_back: returned to the author before/without peer review for correction, or an editor unsubmission/withdrawal that requires the author to act — NOT a post-review rejection.
  - accepted: accepted for publication but not yet published/DOI'd.
  - rejected: rejected after review (or desk-rejected) with no path to revise at this journal — the author must resubmit elsewhere.
  - published: final publication, typically with a DOI or article link.
  - transferred: the manuscript has ACTUALLY MOVED to another journal — the author accepted a transfer and the receiving journal now has it. An email merely OFFERING a transfer, recommending alternative journals, or reporting "transfer not completed" is NOT a transfer: it changes nothing about where the paper is. Use "other" for an offer, and never "transferred", because filing an offer opens a phantom live submission at a journal that rejected the paper.
  - other: a genuine manuscript-status email that doesn't fit above (e.g. plain acknowledgement of a query).
- revision_round: integer (1, 2, 3...) if this is specifically a numbered revision request or a resubmission of a specific revision, else null.
- doi: the DOI string if present (e.g. 10.1000/xyz123), else null.
- publication_link: a direct URL to the published article, if present, else null.
- summary: one sentence, plain language, of what happened.
- reasoning: one short sentence naming the specific evidence that drove your decision.
- confidence: "high" only when the evidence is unambiguous. Use "medium" or "low" whenever you are unsure — a second model double-checks anything below high, so an honest "low" costs nothing and a wrong "high" corrupts the tracker.

Be conservative: if you are not confident this concerns the recipient's own manuscript, mark relevant = false.`;

/**
 * Worked examples of the cases that are genuinely hard to tell apart. These do
 * far more for accuracy on a small model than any amount of extra instruction.
 */
const FEW_SHOT = [
  {
    email: `Subject: Invitation to Review Manuscript JOR-2026-0417
From: Journal of Orthopaedic Research <onbehalfof@manuscriptcentral.com>
Manuscript ID JOR-2026-0417 entitled "Platelet-Rich Plasma versus Corticosteroid Injection in Rotator Cuff Tendinopathy" has been submitted to the Journal of Orthopaedic Research. As an expert in this field, I would be grateful if you would agree to review it. Abstract: This randomised trial compared PRP with corticosteroid injection in 120 patients... Please click here to Agree or Decline. Reviews are due within 21 days.`,
    answer: {
      relevant: false,
      exclude_reason: "peer_review_invitation_for_other_manuscript",
      confidence: "high",
      reasoning:
        'Asks the recipient to agree or decline to review someone else\'s submission, with a 21-day review deadline.',
      title: null,
      journal: null,
      manuscript_number: null,
      event_type: "other",
      revision_round: null,
      doi: null,
      publication_link: null,
      summary: "An editor invited the recipient to peer review another author's manuscript.",
    },
  },
  {
    email: `Subject: Decision on JOR-2026-0388
From: Journal of Orthopaedic Research <onbehalfof@manuscriptcentral.com>
Manuscript ID JOR-2026-0388 entitled "Outcomes of Arthroscopic Repair in Massive Rotator Cuff Tears: A Meta-Analysis" which you submitted to the Journal of Orthopaedic Research has been reviewed. The reviewers recommend major revision. Please submit your revised manuscript within 60 days.`,
    answer: {
      relevant: true,
      exclude_reason: "none",
      confidence: "high",
      reasoning:
        'Says "which you submitted" and asks the recipient to submit a revised manuscript, so it is a decision on their own paper.',
      title:
        "Outcomes of Arthroscopic Repair in Massive Rotator Cuff Tears: A Meta-Analysis",
      journal: "Journal of Orthopaedic Research",
      manuscript_number: "JOR-2026-0388",
      event_type: "revision_requested",
      revision_round: 1,
      doi: null,
      publication_link: null,
      summary:
        "Reviewers recommended major revision; a revised manuscript is due within 60 days.",
    },
  },
  {
    email: `Subject: Transfer recommendations for your submission
From: Springer Nature <notifications@springernature.com>
Based on an analysis of your recent submission "Orthobiologics in Regenerative Orthopedics: A Scoping Review" to International Orthopaedics, we have identified alternative journals that may be a good fit. Review the recommended journals and, if you wish, transfer your manuscript with one click. No further action is required if you would rather not.`,
    answer: {
      relevant: false,
      exclude_reason: "unrelated",
      confidence: "high",
      reasoning:
        'Offers a list of alternative journals after a rejection; the manuscript has not moved and no action is required, so nothing about its status changed.',
      title: null,
      journal: null,
      manuscript_number: null,
      event_type: "other",
      revision_round: null,
      doi: null,
      publication_link: null,
      summary: "A publisher offered to transfer a rejected manuscript to other journals.",
    },
  },
  {
    email: `Subject: Reviewer Accepts Assignment for JOIO-D-25-00892R1
From: Indian Journal of Orthopaedics <em@editorialmanager.com>
Dear Dr Muthu, As Handling Editor for manuscript JOIO-D-25-00892R1, "Vertebral Augmentation in Osteoporotic Compression Fractures", you may wish to know that Dr A. Kumar has agreed to review it. You can monitor progress in the Editorial Manager system.`,
    answer: {
      relevant: false,
      exclude_reason: "editorial_role_for_other_manuscript",
      confidence: "high",
      reasoning:
        'Addresses the recipient as Handling Editor tracking a reviewer assignment, so the manuscript belongs to another author.',
      title: null,
      journal: null,
      manuscript_number: null,
      event_type: "other",
      revision_round: null,
      doi: null,
      publication_link: null,
      summary: "An editorial-workflow notice about a manuscript the recipient handles as editor.",
    },
  },
  {
    email: `Subject: Invitation to submit your esteemed research
From: Global Journal of Medical Sciences <editor@gjms-publications.org>
Greetings of the day! Having read your reputed article on rotator cuff repair, we are highly impressed by your esteemed profile. We cordially invite you to contribute any type of article to our upcoming issue. Nominal processing charges apply. Rapid publication within 72 hours guaranteed.`,
    answer: {
      relevant: false,
      exclude_reason: "predatory_solicitation",
      confidence: "high",
      reasoning:
        'Unsolicited cold-call flattery ("esteemed profile") with guaranteed 72-hour publication and processing charges, for no existing submission.',
      title: null,
      journal: null,
      manuscript_number: null,
      event_type: "other",
      revision_round: null,
      doi: null,
      publication_link: null,
      summary: "A predatory journal solicited a submission.",
    },
  },
];

// Journal systems put the decision, title, manuscript number and any DOI in the
// opening of the message; the rest is reviewer comments, legal boilerplate and
// unsubscribe footers. Sending 10k characters tripled the request size for no
// accuracy gain and put a single classification over Groq's 8k tokens/minute.
const MAX_EMAIL_CHARS = Number(process.env.MAX_EMAIL_CHARS || 3500);

function buildUserPrompt({ subject, from, date, text }) {
  const body = (text || "").slice(0, MAX_EMAIL_CHARS);
  return `Subject: ${subject}\nFrom: ${from}\nDate: ${date}\n\n${body}`;
}

/** Few-shot pairs are folded into the system prompt so every provider gets them. */
function buildSystemPrompt() {
  // Compact JSON: the indentation cost tokens without teaching the model anything.
  const examples = FEW_SHOT.map(
    (ex, i) => `### Example ${i + 1}\n${ex.email}\nCorrect output:\n${JSON.stringify(ex.answer)}`
  ).join("\n\n");

  return `${SYSTEM_PROMPT}\n\n---\n\nWORKED EXAMPLES\n\n${examples}`;
}

const SYSTEM = buildSystemPrompt();

let cachedChain;
function getChain() {
  if (!cachedChain) {
    cachedChain = buildProviderChain();
    if (!cachedChain.length) {
      throw new Error(
        "No classifier API key found. Set at least one of GEMINI_API_KEY, CEREBRAS_API_KEY, GROQ_API_KEY."
      );
    }
  }
  return cachedChain;
}

/** Prefer the primary's value, but let the cross-check fill in what it missed. */
function mergeExtraction(primary, secondary) {
  const merged = { ...primary };
  for (const field of [
    "title",
    "journal",
    "manuscript_number",
    "revision_round",
    "doi",
    "publication_link",
  ]) {
    if (merged[field] === null && secondary[field] !== null) {
      merged[field] = secondary[field];
    }
  }
  return merged;
}

/**
 * Classify one email.
 *
 * Two passes, both on free models. The first pass answers; anything it calls
 * relevant, or answers with less than high confidence, is re-run on a DIFFERENT
 * model. Agreement is filed. Disagreement is never guessed at — it comes back
 * with needsReview set so the email surfaces for a human instead of silently
 * entering or missing the dashboard.
 */
export async function classifyEmail({ subject, from, date, text }) {
  const chain = getChain();
  const user = buildUserPrompt({ subject, from, date, text });

  const first = await completeWithChain(chain, { system: SYSTEM, user });
  const primary = normalizeResult(first.raw);
  if (!primary) {
    throw new Error(`${first.providerId} returned an unusable object`);
  }

  const meta = {
    primaryProvider: first.providerId,
    primaryModel: first.model,
    primaryConfidence: primary.confidence,
    verifiedBy: null,
    agreement: null,
  };

  // Verify the consequential answers: anything that would create a dashboard
  // entry, and anything the model itself was unsure about.
  const needsVerification = primary.relevant || primary.confidence !== "high";
  if (!needsVerification) {
    return { ...primary, needsReview: false, reviewReason: null, meta };
  }

  let second;
  try {
    second = await completeWithChain(chain, {
      system: SYSTEM,
      user,
      skipIds: [first.providerId],
    });
  } catch (err) {
    // Only one provider configured, or the rest are down. Trust a high-confidence
    // answer; flag anything shakier rather than filing it unchecked.
    meta.verificationError = err.message;
    return {
      ...primary,
      needsReview: primary.confidence !== "high",
      reviewReason:
        primary.confidence !== "high"
          ? `unverified ${primary.confidence}-confidence call (no second model available)`
          : null,
      meta,
    };
  }

  const check = normalizeResult(second.raw);
  meta.verifiedBy = second.providerId;
  meta.verifiedModel = second.model;

  if (!check) {
    meta.agreement = "unusable_verification";
    return {
      ...primary,
      needsReview: true,
      reviewReason: `cross-check by ${second.providerId} returned an unusable object`,
      meta,
    };
  }

  // Disagreement on relevance is the expensive one: filing junk, or losing a
  // paper. Never resolve it by picking a side.
  if (check.relevant !== primary.relevant) {
    meta.agreement = "relevance_conflict";
    return {
      ...primary,
      needsReview: true,
      reviewReason: `${first.providerId} said relevant=${primary.relevant}, ${second.providerId} said relevant=${check.relevant}`,
      meta,
    };
  }

  if (!primary.relevant) {
    meta.agreement = "agreed_excluded";
    return { ...primary, needsReview: false, reviewReason: null, meta };
  }

  const merged = mergeExtraction(primary, check);

  // Both agree it is the author's own manuscript but disagree on what happened.
  // File it — losing the paper would be worse — but flag the bucket as unsure.
  if (check.event_type !== primary.event_type) {
    meta.agreement = "event_type_conflict";
    return {
      ...merged,
      needsReview: true,
      reviewReason: `event type disputed: ${first.providerId} said ${primary.event_type}, ${second.providerId} said ${check.event_type}`,
      meta,
    };
  }

  meta.agreement = "agreed";
  return { ...merged, needsReview: false, reviewReason: null, meta };
}
