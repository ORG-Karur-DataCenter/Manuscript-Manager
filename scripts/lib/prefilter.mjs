/**
 * Cheap keyword prefilter so we don't spend a classification on obvious
 * non-candidates (receipts, calendar invites, mailing lists, etc).
 * Deliberately broad/generous — it decides what reaches the classifier, so it
 * errs towards letting things through.
 */
export const PREFILTER = new RegExp(
  [
    "manuscript",
    "submission",
    "submitted",
    "editorial manager",
    "scholarone",
    "journal",
    "peer.?review",
    "reviewer",
    "revis(e|ion)",
    "accept(ed|ance)",
    "reject(ed|ion)",
    "decision on your",
    "under review",
    "proof(s)?\\b",
    "galley",
    "copyedit",
    "editor.?in.?chief",
    "corresponding author",
    "doi\\.org",
    "publish(ed|ing)?",
    "transfer(red)? to",
    "desk reject",
    "invite you to submit",
    "invited to review",
  ].join("|"),
  "i"
);
