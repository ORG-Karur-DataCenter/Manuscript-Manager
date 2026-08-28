/**
 * Deciding which reminders are due.
 *
 * THE ONE THING THIS MUST GET RIGHT. The sync runs every three hours, which is
 * eight times a day. Anything that simply asked "is this manuscript overdue?"
 * and sent a message would send eight a day, per manuscript, forever — and the
 * fastest way to make someone ignore a deadline alert is to send them a
 * hundred. So every message is keyed and written to a ledger, and a key that
 * has been sent is never sent again.
 *
 * The key includes the deadline itself. That is deliberate: if the journal
 * sends a new letter with a later date, or someone corrects the date by hand,
 * the reminders re-arm against the new one. A changed deadline is a different
 * deadline, and deserves to be announced.
 *
 * Reminders go out when the amendment is first seen, then as the date closes
 * in, then once when it passes. Not more. Someone who has been told four times
 * and not acted has decided something; a fifth message is noise, not help.
 */
import { daysLeft, describeDeadline } from "./deadline.mjs";

export const DEFAULT_POLICY = {
  // Which events are worth a message. Amendments returned before peer review
  // are the sharp case -- five to fourteen days, and missing one usually
  // withdraws the submission. Add "revision_requested" here to be reminded
  // about post-review revisions too; they run on far longer windows.
  eventTypes: ["sent_back"],
  // Days remaining at which to send. `null` means "when first seen".
  remindAt: [null, 3, 1],
  // One message when it goes past, and then silence.
  remindWhenOverdue: true,
  // Never message about something that fell due long ago -- on a first run
  // against a year of history that would be a flood of dead news.
  ignoreOlderThanDays: 30,
};

/**
 * Which manuscripts are on a clock right now.
 *
 * A manuscript counts when its action flag is up and it carries a deadline.
 * Deliberately not filtered by section: a revision request sits in "in review"
 * and still needs doing, so a section test would silently exclude every one of
 * them the day someone turns revision reminders on. What marks a thing as
 * finished is applyEvent clearing the deadline when a later email arrives, so
 * it drops out of here on its own.
 */
export function pendingDeadlines(registry, { policy = DEFAULT_POLICY, now = Date.now() } = {}) {
  const wanted = new Set(policy.eventTypes || DEFAULT_POLICY.eventTypes);

  return (registry.manuscripts || [])
    .filter((m) => m.deadline && m.actionFlag)
    .filter((m) => {
      const last = lastEventOf(m);
      return last && wanted.has(last.eventType);
    })
    .map((m) => ({ manuscript: m, left: daysLeft(m.deadline, now) }))
    .filter(({ left }) => left !== null && left >= -(policy.ignoreOlderThanDays ?? 30))
    .sort((a, b) => a.left - b.left);
}

const lastEventOf = (m) =>
  (m.timeline || []).slice().sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp))[0];

/**
 * The reminders that are due but not yet sent.
 *
 * "Due" is deliberately `left <= threshold` rather than `left === threshold`:
 * a run that is skipped, or a sync that fails for a day, must not cause a
 * reminder to be silently stepped over. It fires late instead of never.
 */
export function dueReminders(registry, ledger, { policy = DEFAULT_POLICY, now = Date.now() } = {}) {
  const sent = new Set((ledger.sent || []).map((s) => s.key));
  const out = [];

  for (const { manuscript, left } of pendingDeadlines(registry, { policy, now })) {
    const due = manuscript.deadline;

    // "First seen" always goes first, so nobody's introduction to an amendment
    // is a message saying it is due tomorrow.
    const stages = [];
    if ((policy.remindAt || []).includes(null)) stages.push({ kind: "new", at: null });
    for (const threshold of (policy.remindAt || []).filter((d) => d !== null).sort((a, b) => b - a)) {
      if (left <= threshold) stages.push({ kind: `t-${threshold}`, at: threshold });
    }
    if (policy.remindWhenOverdue && left < 0) stages.push({ kind: "overdue", at: -1 });

    const unsent = stages
      .map((stage) => ({ ...stage, key: `${manuscript.id}|${due}|${stage.kind}` }))
      .filter((stage) => !sent.has(stage.key));
    if (!unsent.length) continue;

    // An amendment first seen when it is already three days out has both its
    // "new" and its "3 days left" stage owing at once. Two messages, seconds
    // apart, about the same paper is the noise this file exists to prevent, so
    // only the most urgent is sent -- and the ones it stands in for are carried
    // along on `supersedes` to be written to the ledger with it, or they would
    // simply fire on the next run instead.
    // "First seen" wins when it is among them: nobody's introduction to an
    // amendment should be a bare "due soon" for a paper they have not yet been
    // told about. The urgency still shows, because the wording below is driven
    // by the days remaining rather than by which stage fired.
    const chosen = unsent.find((s) => s.kind === "new") || unsent[unsent.length - 1];
    out.push({
      key: chosen.key,
      kind: chosen.kind,
      supersedes: unsent.filter((s) => s !== chosen).map((s) => s.key),
      manuscript,
      left,
      due,
    });
  }
  return out;
}

/**
 * One WhatsApp message.
 *
 * Written to be read on a phone, at a glance, probably between patients: what
 * has to happen, by when, and for which paper. An assumed date says so — the
 * reader has to be able to tell a date the journal gave from one this app
 * worked out on its behalf.
 */
export function composeMessage(reminder, { now = Date.now(), dashboardUrl = "" } = {}) {
  const m = reminder.manuscript;
  const when = describeDeadline(reminder.due, now);
  // Urgency comes from the clock, wording from the stage — so an amendment
  // first seen with two days left reads as urgent AND as news.
  const mark = reminder.left <= 1 ? "🔴" : reminder.left <= 3 ? "🟠" : "📄";
  const what =
    reminder.kind === "new" ? "Amendments requested"
    : reminder.left < 0 ? "Amendment overdue"
    : "Amendment due";
  const heading = `${mark} ${what}`;

  const dueDate = new Date(reminder.due).toLocaleDateString("en-GB", {
    weekday: "short", day: "numeric", month: "short", timeZone: "Asia/Kolkata",
  });
  const assumed = m.deadlineSource === "assumed";

  const lines = [
    `${heading} — ${when}`,
    "",
    `"${truncate(m.title, 110)}"`,
    [m.currentJournal, referenceOf(m)].filter(Boolean).join(" · "),
    "",
    assumed
      ? `Due ${dueDate} (estimated — the journal did not give a date)`
      : `Due ${dueDate}`,
  ];

  const note = lastEventOf(m)?.note;
  if (note) lines.push("", truncate(note, 180));
  if (dashboardUrl) lines.push("", dashboardUrl);

  return lines.join("\n").replace(/\n{3,}/g, "\n\n").trim();
}

/**
 * Some systems put a raw submission UUID where the manuscript number goes.
 * "INOR-D-26-00412" helps someone find the paper; a 36-character hex string
 * only takes up the screen.
 */
function referenceOf(m) {
  const ref = (m.currentManuscriptNumber || "").trim();
  if (!ref) return "";
  return /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i.test(ref) ? "" : ref;
}

const truncate = (s, n) => {
  const text = String(s || "").trim();
  return text.length > n ? `${text.slice(0, n - 1).trimEnd()}…` : text;
};

/** Write what went out, so it never goes out twice. */
export function recordSent(ledger, reminder, results, { now = new Date().toISOString() } = {}) {
  ledger.sent ||= [];
  // The stages this one message stood in for. Recorded as sent so they do not
  // arrive separately a few hours later saying much the same thing.
  for (const key of reminder.supersedes || []) {
    ledger.sent.push({ key, kind: "superseded", manuscriptId: reminder.manuscript.id, at: now });
  }
  ledger.sent.push({
    key: reminder.key,
    kind: reminder.kind,
    manuscriptId: reminder.manuscript.id,
    title: reminder.manuscript.title,
    due: reminder.due,
    at: now,
    to: results.filter((r) => r.ok).map((r) => r.name),
    failed: results.filter((r) => !r.ok).map((r) => ({ name: r.name, error: r.error })),
  });
  return ledger;
}

/**
 * A reminder that reached nobody must not be recorded as sent, or it is lost
 * for good — the key would suppress every future attempt. Recording a partial
 * success is right, though: the ones who got it should not get it twice, and
 * the failure is written down beside it.
 */
export const reachedSomeone = (results) => results.some((r) => r.ok);

/** Keep the ledger from growing without bound; it is only ever read by key. */
export function pruneLedger(ledger, { keep = 500 } = {}) {
  ledger.sent = (ledger.sent || []).slice(-keep);
  return ledger;
}
