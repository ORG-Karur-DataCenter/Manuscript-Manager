/**
 * The single source of truth for the classifier's output shape.
 *
 * Declared once in JSON Schema, then translated per provider: OpenAI-compatible
 * endpoints (Groq, Cerebras) take it almost verbatim in strict mode, Gemini takes
 * an OpenAPI-flavoured dialect that spells nullability differently.
 */

export const EXCLUDE_REASONS = [
  "predatory_solicitation",
  "peer_review_invitation_for_other_manuscript",
  "editorial_role_for_other_manuscript",
  "newsletter_or_cfp",
  "unrelated",
  "none",
];

export const EVENT_TYPES = [
  "new_submission",
  "under_review",
  "revision_requested",
  "sent_back",
  "accepted",
  "rejected",
  "published",
  "transferred",
  "other",
];

export const CONFIDENCE_LEVELS = ["high", "medium", "low"];

/** Property order matters for Gemini, which emits fields in declaration order. */
const PROPERTIES = {
  relevant: {
    type: "boolean",
    description:
      "True only if this email reports on the status of a manuscript the recipient themselves submitted.",
  },
  exclude_reason: {
    type: "string",
    enum: EXCLUDE_REASONS,
    description: 'Why the email was excluded. Exactly "none" when relevant is true.',
  },
  confidence: {
    type: "string",
    enum: CONFIDENCE_LEVELS,
    description:
      "How certain you are of the relevant/exclude_reason decision. Use low or medium whenever the email is ambiguous — a second model will double-check anything that is not high.",
  },
  reasoning: {
    type: "string",
    description:
      "One short sentence naming the specific evidence in the email that drove the decision (e.g. the phrase that marks it as a reviewer invitation).",
  },
  title: { type: ["string", "null"], description: "Exact manuscript title, or null." },
  journal: { type: ["string", "null"], description: "Journal or publisher name, or null." },
  manuscript_number: {
    type: ["string", "null"],
    description: "The ID the journal assigned this submission, or null.",
  },
  event_type: { type: "string", enum: EVENT_TYPES },
  revision_round: {
    type: ["integer", "null"],
    description: "Revision number if explicitly numbered, else null.",
  },
  doi: { type: ["string", "null"] },
  publication_link: { type: ["string", "null"] },
  deadline_days: {
    type: ["integer", "null"],
    description:
      'Number of days the email gives the author to act, when it states a period ("within 14 days", "in 5 working days") — the number only. Null if no period is stated.',
  },
  deadline_date: {
    type: ["string", "null"],
    description:
      'An explicit calendar due date, copied exactly as the email writes it (e.g. "12 September 2026", "2026-09-12"). Null if the email gives no calendar date.',
  },
  summary: { type: "string", description: "One plain-language sentence on what happened." },
};

const REQUIRED = Object.keys(PROPERTIES);

/** Strict JSON Schema, for OpenAI-compatible `response_format.json_schema`. */
export const STRICT_JSON_SCHEMA = {
  type: "object",
  properties: PROPERTIES,
  required: REQUIRED,
  additionalProperties: false,
};

/**
 * Gemini's responseSchema is an OpenAPI 3.0 subset: it has no union types, so
 * `["string", "null"]` becomes `{ type: "string", nullable: true }`. It also has
 * no additionalProperties, and honours propertyOrdering.
 */
export function toGeminiSchema(schema = STRICT_JSON_SCHEMA) {
  const properties = {};
  for (const [key, prop] of Object.entries(schema.properties)) {
    const converted = { ...prop };
    if (Array.isArray(prop.type)) {
      const [primary] = prop.type.filter((t) => t !== "null");
      converted.type = primary;
      if (prop.type.includes("null")) converted.nullable = true;
    }
    properties[key] = converted;
  }
  return {
    type: "object",
    properties,
    required: schema.required,
    propertyOrdering: schema.required,
  };
}

/**
 * Coerce a provider's raw JSON into the shape the rest of the app expects.
 * Providers occasionally return the right values with the wrong types (a
 * stringified integer, "null" as text), so normalise rather than trust.
 */
export function normalizeResult(raw) {
  if (!raw || typeof raw !== "object") return null;

  const str = (v) => {
    if (v === null || v === undefined) return null;
    const s = String(v).trim();
    if (!s || s.toLowerCase() === "null" || s.toLowerCase() === "n/a") return null;
    return s;
  };
  const oneOf = (v, allowed, fallback) =>
    allowed.includes(v) ? v : fallback;

  const relevant = raw.relevant === true || raw.relevant === "true";
  const round = Number.parseInt(raw.revision_round, 10);
  const days = Number.parseInt(raw.deadline_days, 10);

  return {
    relevant,
    exclude_reason: oneOf(
      raw.exclude_reason,
      EXCLUDE_REASONS,
      relevant ? "none" : "unrelated"
    ),
    confidence: oneOf(raw.confidence, CONFIDENCE_LEVELS, "low"),
    reasoning: str(raw.reasoning) || "",
    title: str(raw.title),
    journal: str(raw.journal),
    manuscript_number: str(raw.manuscript_number),
    event_type: oneOf(raw.event_type, EVENT_TYPES, "other"),
    revision_round: Number.isFinite(round) ? round : null,
    doi: str(raw.doi),
    publication_link: str(raw.publication_link),
    // A journal's own words about when it wants the work back. Kept raw here;
    // turning the two into one real date is lib/deadline.mjs's job, because it
    // needs the email's own timestamp to resolve "within 14 days".
    deadline_days: Number.isFinite(days) && days > 0 && days <= 365 ? days : null,
    deadline_date: str(raw.deadline_date),
    summary: str(raw.summary) || "",
  };
}
