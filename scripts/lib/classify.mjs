import Anthropic from "@anthropic-ai/sdk";

const MODEL = "claude-haiku-4-5-20251001";

const SYSTEM_PROMPT = `You are a triage classifier for a researcher's inbox. The researcher submits manuscripts to academic journals and needs every email that is genuinely about the STATUS of one of THEIR OWN submitted manuscripts pulled into a tracker, and everything else excluded.

INCLUDE (relevant = true) only emails that are a journal/publisher system (Editorial Manager, ScholarOne, OJS, Elsevier EES, Springer Nature, Wiley, MDPI susy, Frontiers, BMJ, Taylor & Francis, etc.) reporting on the lifecycle of a manuscript THIS PERSON authored/submitted: submission acknowledgement, technical/desk check returning it for correction before review, assignment to peer review, a reviewer decision (revision requested, accepted, rejected), transfer to a sister journal, proofs, or final publication with DOI.

EXCLUDE (relevant = false) and give exclude_reason:
- "predatory_solicitation": unsolicited cold-call invitations to submit a paper, praising the author's "esteemed profile" or a past publication, from a journal that did not receive a submission from them — classic predatory-journal spam.
- "peer_review_invitation_for_other_manuscript": the email invites THIS PERSON to act as a PEER REVIEWER for someone else's manuscript (even though it includes a manuscript number, title and abstract) — this is a request FROM an editor asking them to review, not a status update on their own paper.
- "newsletter_or_cfp": journal newsletters, tables of contents, special-issue calls for papers, conference announcements.
- "unrelated": anything else — personal mail, unrelated business, etc.
- "none": use this value when relevant is true.

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
  - transferred: journal offered/executed a transfer of the manuscript to a sister journal.
  - other: a genuine manuscript-status email that doesn't fit above (e.g. plain acknowledgement of a query).
- revision_round: integer (1, 2, 3...) if this is specifically a numbered revision request or a resubmission of a specific revision, else null.
- doi: the DOI string if present (e.g. 10.1000/xyz123), else null.
- publication_link: a direct URL to the published article, if present, else null.
- summary: one sentence, plain language, of what happened.

Be conservative: if you are not confident this concerns the recipient's own manuscript, mark relevant = false.`;

let client;
function getClient() {
  if (!client) {
    client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  }
  return client;
}

const TOOL = {
  name: "extract_manuscript_event",
  description: "Record the triage classification and, if relevant, the manuscript event details.",
  input_schema: {
    type: "object",
    properties: {
      relevant: { type: "boolean" },
      exclude_reason: {
        type: "string",
        enum: [
          "predatory_solicitation",
          "peer_review_invitation_for_other_manuscript",
          "newsletter_or_cfp",
          "unrelated",
          "none",
        ],
      },
      title: { type: "string" },
      journal: { type: "string" },
      manuscript_number: { type: "string" },
      event_type: {
        type: "string",
        enum: [
          "new_submission",
          "under_review",
          "revision_requested",
          "sent_back",
          "accepted",
          "rejected",
          "published",
          "transferred",
          "other",
        ],
      },
      revision_round: { type: ["integer", "null"] },
      doi: { type: ["string", "null"] },
      publication_link: { type: ["string", "null"] },
      summary: { type: "string" },
    },
    required: ["relevant", "exclude_reason", "event_type", "summary"],
  },
};

export async function classifyEmail({ subject, from, date, text }) {
  const userContent = `Subject: ${subject}\nFrom: ${from}\nDate: ${date}\n\n${text}`.slice(
    0,
    10000
  );

  const response = await getClient().messages.create({
    model: MODEL,
    max_tokens: 1024,
    system: SYSTEM_PROMPT,
    tools: [TOOL],
    tool_choice: { type: "tool", name: "extract_manuscript_event" },
    messages: [{ role: "user", content: userContent }],
  });

  const toolUse = response.content.find((c) => c.type === "tool_use");
  if (!toolUse) {
    return { relevant: false, exclude_reason: "unrelated", event_type: "other", summary: "" };
  }
  return toolUse.input;
}
