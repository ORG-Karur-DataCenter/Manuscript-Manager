/**
 * Amendment deadlines as GitHub issues.
 *
 * WHY THIS EXISTS ALONGSIDE WHATSAPP. Every free route into WhatsApp is either
 * somebody's side project on a number that keeps moving, or Meta's official one
 * behind template paperwork. That fragility is not something this repository
 * can engineer away, and a deadline reminder that silently stops arriving is
 * worse than none — you stop checking, because you believe you would be told.
 *
 * GitHub is already here. It needs no signup, no key, no third party, and it
 * pushes to the GitHub app on a phone and to email. So each amendment also gets
 * an issue: opened when the deadline appears, commented on as it closes in,
 * closed when the work is done. The issue body is the journal's actual list of
 * corrections, as a checklist, so it doubles as somewhere to work rather than
 * just an alarm.
 *
 * It covers whoever watches the repository, which is not everyone WhatsApp
 * reaches — so this is a floor under the reminders, not a replacement.
 */
import { daysLeft, describeDeadline } from "./deadline.mjs";

const API = "https://api.github.com";
export const LABEL = "amendment";

async function gh(path, { token, repo, method = "GET", body, fetchImpl = globalThis.fetch }) {
  const res = await fetchImpl(`${API}/repos/${repo}${path}`, {
    method,
    headers: {
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      Authorization: `Bearer ${token}`,
      "User-Agent": "orgkarur-comms",
      ...(body ? { "Content-Type": "application/json" } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const text = await res.text();
  if (!res.ok) {
    const err = new Error(`GitHub ${res.status}: ${text.slice(0, 200)}`);
    err.status = res.status;
    throw err;
  }
  return text ? JSON.parse(text) : null;
}

const truncate = (s, n) => {
  const t = String(s || "").trim();
  return t.length > n ? `${t.slice(0, n - 1).trimEnd()}…` : t;
};

/**
 * Short enough to read in a notification, specific enough to tell apart.
 *
 * `now` is threaded through rather than read from the wall clock, so a caller
 * working to a fixed moment -- a test, or a run reasoning about a whole batch
 * at one instant -- gets a title consistent with everything else it computes.
 */
export function issueTitle(m, { now = Date.now() } = {}) {
  return `Amendment ${describeDeadline(m.deadline, now)} — ${truncate(m.title, 70)}`;
}

/**
 * The journal's own list of corrections, turned into something tickable.
 *
 * The summary is one paragraph of prose written by the classifier; splitting it
 * on the numbering the journal used gives back the individual asks. Where there
 * is no numbering it stays one line, which is still better than nothing.
 */
function checklist(note) {
  const text = String(note || "").trim();
  if (!text) return "";
  const parts = text
    .split(/(?:^|[;.]\s+)(?=\d[.)]\s)|(?:;\s+)/)
    .map((p) => p.replace(/^\d[.)]\s*/, "").trim())
    .filter((p) => p.length > 3);
  if (parts.length < 2) return `- [ ] ${text}`;
  return parts.map((p) => `- [ ] ${p.replace(/\.$/, "")}`).join("\n");
}

export function issueBody(m, { dashboardUrl = "", now = Date.now() } = {}) {
  const due = new Date(m.deadline).toLocaleDateString("en-GB", {
    weekday: "long", day: "numeric", month: "long", year: "numeric", timeZone: "Asia/Kolkata",
  });
  const estimated = m.deadlineSource === "assumed";
  const last = (m.timeline || []).slice().sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp))[0];

  return [
    `**${m.title}**`,
    "",
    `| | |`,
    `| --- | --- |`,
    `| Journal | ${m.currentJournal || "—"} |`,
    `| Manuscript | ${m.currentManuscriptNumber || "—"} |`,
    `| Due | ${due} — **${describeDeadline(m.deadline, now)}** |`,
    `| Date from | ${estimated
      ? "estimated from this journal's usual window — the email gave no date"
      : "stated by the journal"} |`,
    "",
    "### What the journal asked for",
    "",
    checklist(last?.note) || "_The email gave no itemised list; open it in the mailbox._",
    "",
    ...(estimated
      ? ["> The due date above is an estimate, not the journal's own. Correct it in the",
         "> tracker with **Edit** if you know the real one, and the reminders follow it.",
         ""]
      : []),
    dashboardUrl ? `[Open in the tracker](${dashboardUrl})` : "",
    "",
    "<!-- orgkarur-comms: opened automatically; closes when the tracker sees this dealt with -->",
  ].filter((l) => l !== null).join("\n");
}

/**
 * Bring the issues into line with what is actually outstanding.
 *
 * `pending` is the list from notify.mjs. `ledger.issues` maps a manuscript id to
 * its issue number, so an existing issue is updated rather than a second one
 * opened every three hours — the same duplicate-suppression problem the WhatsApp
 * reminders have, and the same answer.
 */
export async function syncIssues(pending, ledger, {
  token,
  repo,
  dashboardUrl = "",
  fetchImpl = globalThis.fetch,
  now = Date.now(),
} = {}) {
  if (!token || !repo) {
    return { skipped: "no GITHUB_TOKEN or repository — issues not touched", opened: [], updated: [], closed: [] };
  }
  ledger.issues ||= {};
  const opened = [];
  const updated = [];
  const closed = [];
  const outstanding = new Set(pending.map((p) => p.manuscript.id));

  for (const { manuscript } of pending) {
    const existing = ledger.issues[manuscript.id];
    const title = issueTitle(manuscript, { now });
    const body = issueBody(manuscript, { dashboardUrl, now });

    if (!existing) {
      const issue = await gh("/issues", {
        token, repo, fetchImpl, method: "POST",
        body: { title, body, labels: [LABEL] },
      });
      ledger.issues[manuscript.id] = { number: issue.number, title, due: manuscript.deadline };
      opened.push({ number: issue.number, title });
      continue;
    }

    // Only touch it when something a reader would notice has changed. A silent
    // rewrite every three hours generates no notification but does churn the
    // issue's history, and burns API calls for nothing.
    if (existing.title === title && existing.due === manuscript.deadline) continue;

    await gh(`/issues/${existing.number}`, {
      token, repo, fetchImpl, method: "PATCH",
      body: { title, body, state: "open" },
    });
    // A moved deadline is worth saying out loud; a title that merely re-counted
    // the days is not.
    if (existing.due !== manuscript.deadline) {
      await gh(`/issues/${existing.number}/comments`, {
        token, repo, fetchImpl, method: "POST",
        body: { body: `The deadline moved to **${describeDeadline(manuscript.deadline, now)}** (${new Date(manuscript.deadline).toDateString()}).` },
      });
    }
    existing.title = title;
    existing.due = manuscript.deadline;
    updated.push({ number: existing.number, title });
  }

  // Anything with an open issue that is no longer outstanding has been dealt
  // with -- the author resubmitted and the journal acknowledged it, so the
  // registry cleared the deadline. Close it and say why.
  for (const [id, record] of Object.entries(ledger.issues)) {
    if (outstanding.has(id) || record.closed) continue;
    await gh(`/issues/${record.number}/comments`, {
      token, repo, fetchImpl, method: "POST",
      body: { body: "The tracker no longer shows this as outstanding — the journal has moved it on. Closing." },
    });
    await gh(`/issues/${record.number}`, {
      token, repo, fetchImpl, method: "PATCH", body: { state: "closed" },
    });
    record.closed = true;
    closed.push({ number: record.number, title: record.title });
  }

  return { opened, updated, closed };
}

/** A stage reminder, as a comment, so it reaches the phone like the first one. */
export async function commentReminder(reminder, ledger, { token, repo, fetchImpl = globalThis.fetch, now = Date.now() } = {}) {
  const record = (ledger.issues || {})[reminder.manuscript.id];
  if (!token || !repo || !record || record.closed) return null;
  const when = describeDeadline(reminder.due, now);
  const urgency = reminder.left < 0 ? "🔴" : reminder.left <= 1 ? "🔴" : "🟠";
  await gh(`/issues/${record.number}/comments`, {
    token, repo, fetchImpl, method: "POST",
    body: { body: `${urgency} **${when}.** ${reminder.left < 0
      ? "This is past the date the journal gave. Check whether the submission is still in the system."
      : "Still outstanding."}` },
  });
  return record.number;
}
