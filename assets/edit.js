/**
 * Editing a manuscript by hand, and moving it between sections.
 *
 * WHY AN EDIT IS NOT JUST A FORM. Everything on this dashboard is derived from
 * email: a classifier reads each message and the registry folds it into the
 * record. That process runs every three hours and it recomputes the same
 * fields a person would want to correct — the title, the section, the journal,
 * the status. So a plain form would appear to work and then be quietly undone
 * by the next incoming email, which is worse than not offering it at all.
 *
 * The fix is that a manual value is *pinned*: it is written to
 * `manuscript.overrides`, and the sync is required to leave any pinned field
 * alone. A person's judgement outranks the classifier's, permanently, until
 * they say otherwise. Clearing a field releases the pin and hands it back to
 * automation. Both directions matter — pinning with no way out would turn one
 * hasty correction into a permanent lie.
 *
 * WHERE THE WRITING HAPPENS. The page is static and the data lives in a public
 * git repository, so there is no token here that could commit anything. The
 * Worker holds that token and does the write, guarding against the sync
 * committing at the same moment. Editing therefore needs the proxy configured;
 * with no proxy there is nowhere to save to, and this module says so plainly
 * instead of letting a form fail at the last step.
 */
import { callProxy, usingProxy, hasPassphrase } from "./sync.js";

/** Mirrors OVERRIDABLE in scripts/lib/registry.mjs and the Worker. */
export const FIELDS = [
  {
    field: "title",
    label: "Title",
    type: "textarea",
    help: "Journals often send a truncated or mistyped title. The original wording is kept as an alias, so later emails still match this record.",
  },
  { field: "currentJournal", label: "Current journal", type: "text" },
  { field: "currentStatus", label: "Current status", type: "text" },
  { field: "currentManuscriptNumber", label: "Manuscript number", type: "text" },
  {
    field: "deadline",
    label: "Due back by",
    type: "date",
    help: "When the journal wants the amended manuscript back. WhatsApp reminders follow this date, so correcting an estimated one here corrects the reminders too.",
  },
  { field: "doi", label: "DOI", type: "text", placeholder: "10.1234/example" },
  { field: "publicationLink", label: "Article link", type: "url", placeholder: "https://…" },
  {
    field: "notes",
    label: "Notes",
    type: "textarea",
    help: "For anything the email trail does not carry — a phone call with the editor, a decision taken in a meeting.",
  },
];

export const SECTIONS = [
  { bucket: "submissions", label: "Submissions" },
  { bucket: "needs_action", label: "Needs action" },
  { bucket: "revisions_pending", label: "Revisions pending" },
  { bucket: "in_review", label: "In review" },
  { bucket: "published", label: "Published" },
];

/** True when a person has fixed this field, so the sync must not touch it. */
export const isPinned = (m, field) =>
  Boolean(m && m.overrides && Object.prototype.hasOwnProperty.call(m.overrides, field));

/** Whether this browser can save an edit at all, and if not, why not. */
export function editingAvailable() {
  if (!usingProxy()) {
    return {
      ok: false,
      reason:
        "Editing needs the sync service, which holds the only credential allowed to write to the repository. " +
        "It is not configured for this page, so there is nowhere to save a change to.",
    };
  }
  return { ok: true };
}

/**
 * Save one edit. `patch` is the fields to change; `""` releases a field back to
 * automatic. Returns the manuscript as it now stands on the server, so the
 * page can show the result immediately rather than waiting for the commit to
 * be served — GitHub Pages can be a minute or two behind a push.
 */
export async function saveEdit(id, patch) {
  const available = editingAvailable();
  if (!available.ok) {
    const err = new Error(available.reason);
    err.code = "unavailable";
    throw err;
  }
  // A resumed "stay signed in" session never typed the password this visit,
  // and the password is deliberately not kept in durable storage. Ask again
  // rather than sending an empty one and reporting the 401 as a failure.
  if (!hasPassphrase()) {
    const err = new Error("Confirm the dashboard password to save a change.");
    err.code = "auth";
    throw err;
  }
  const body = await callProxy(`/manuscripts/${encodeURIComponent(id)}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(patch),
  });
  return body;
}

/**
 * What actually changed between the record and what was typed. Sending only
 * the differences keeps the edit history honest: it should record what a
 * person changed, not every field that happened to be on screen.
 *
 * `released` names fields the person explicitly handed back to automation.
 * That is not the same as leaving a field empty — a manuscript with no DOI has
 * an empty DOI box, and saving that should not be read as an instruction.
 */
export function diff(manuscript, values, released = new Set()) {
  const patch = {};
  for (const { field } of FIELDS) {
    if (released.has(field)) {
      if (isPinned(manuscript, field)) patch[field] = "";
      continue;
    }
    if (!(field in values)) continue;
    const next = (values[field] || "").trim();
    const current = (manuscript[field] || "").trim();
    // Re-saving an unchanged value is still meaningful the first time: it is
    // how someone confirms that what the classifier guessed is in fact right
    // and should stop changing.
    if (next === current && (isPinned(manuscript, field) || !next)) continue;
    if (next) patch[field] = next;
  }

  if (released.has("bucket")) {
    if (isPinned(manuscript, "bucket")) patch.bucket = "";
  } else if (values.bucket && (values.bucket !== manuscript.bucket || !isPinned(manuscript, "bucket"))) {
    patch.bucket = values.bucket;
  }

  return patch;
}
