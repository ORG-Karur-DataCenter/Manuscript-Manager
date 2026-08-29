/**
 * Amendment deadlines into a Google Chat space.
 *
 * WHY THIS IS THE GOOD ONE. WhatsApp has cost two evenings: every free route
 * into it is either a hobbyist relay on a number that keeps moving, or Meta's
 * own API behind business verification and template approval. Google Chat asks
 * for none of that. A space has an incoming webhook, the webhook is a URL, and
 * posting to it is one HTTPS request. Nothing to verify, nothing to approve,
 * no per-person key — and both people are in the same space, so one post
 * reaches everyone rather than needing a fan-out with its own failure modes.
 *
 * THE URL IS THE CREDENTIAL. Anyone holding it can post into that space, so it
 * lives in a GitHub secret and never in this repository, which is public.
 * There is no way to scope or revoke it other than deleting the webhook and
 * making a new one, so treat it exactly like a password.
 *
 * ON THREADING. Each manuscript posts under its own thread key, so the first
 * word about an amendment and every reminder that follows sit in one thread
 * rather than scattering down the space. That is the difference between a
 * space you keep and one you mute after a fortnight.
 */
import { describeDeadline } from "./deadline.mjs";

const truncate = (s, n) => {
  const t = String(s || "").trim();
  return t.length > n ? `${t.slice(0, n - 1).trimEnd()}…` : t;
};

/** Google Chat reads a small markdown subset: *bold*, _italic_, <url|label>. */
const escapeAngles = (s) => String(s || "").replace(/[<>]/g, "");

/**
 * The journal's list of corrections as bullets. Same splitting as the GitHub
 * issue checklist; the two channels should say the same thing.
 */
function bullets(note) {
  const text = String(note || "").trim();
  if (!text) return "";
  const parts = text
    .split(/(?:^|[;.]\s+)(?=\d[.)]\s)|(?:;\s+)/)
    .map((p) => p.replace(/^\d[.)]\s*/, "").trim())
    .filter((p) => p.length > 3);
  const items = parts.length >= 2 ? parts : [text];
  return items.map((p) => `• ${escapeAngles(p.replace(/\.$/, ""))}`).join("\n");
}

/** One amendment, written to be read on a phone at a glance. */
export function composeChat(reminder, { now = Date.now(), dashboardUrl = "" } = {}) {
  const m = reminder.manuscript;
  const when = describeDeadline(reminder.due, now);
  const mark = reminder.left <= 1 ? "🔴" : reminder.left <= 3 ? "🟠" : "📄";
  const what =
    reminder.kind === "new" ? "Amendments requested"
    : reminder.left < 0 ? "Amendment overdue"
    : "Amendment due";

  const dueDate = new Date(reminder.due).toLocaleDateString("en-GB", {
    weekday: "short", day: "numeric", month: "short", timeZone: "Asia/Kolkata",
  });
  const estimated = m.deadlineSource === "assumed";

  const lines = [
    `${mark} *${what} — ${when}*`,
    "",
    `_${escapeAngles(truncate(m.title, 130))}_`,
    escapeAngles([m.currentJournal, m.currentManuscriptNumber].filter(Boolean).join(" · ")),
    "",
    estimated
      ? `Due ${dueDate}  _(estimated — the journal gave no date)_`
      : `Due ${dueDate}`,
  ];

  const note = lastEventOf(m)?.note;
  if (note) lines.push("", bullets(note));
  if (dashboardUrl) lines.push("", `<${dashboardUrl}|Open the tracker>`);

  return lines.join("\n").replace(/\n{3,}/g, "\n\n").trim();
}

const lastEventOf = (m) =>
  (m.timeline || []).slice().sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp))[0];

/**
 * Post one message.
 *
 * Everything about a manuscript goes under one thread key so the space reads as
 * a conversation per paper. FALLBACK_TO_NEW_THREAD means the first message
 * opens the thread and later ones reply into it, without having to remember a
 * thread id anywhere.
 */
export async function postToChat(text, {
  webhook,
  threadKey = "",
  fetchImpl = globalThis.fetch,
} = {}) {
  if (!webhook) return { skipped: "no GCHAT_WEBHOOK_URL — Google Chat not posted to" };

  const url = new URL(webhook);
  if (threadKey) {
    url.searchParams.set("messageReplyOption", "REPLY_MESSAGE_FALLBACK_TO_NEW_THREAD");
  }
  const body = threadKey
    ? { text, thread: { threadKey } }
    : { text };

  let res;
  try {
    res = await fetchImpl(url.toString(), {
      method: "POST",
      headers: { "Content-Type": "application/json; charset=UTF-8" },
      body: JSON.stringify(body),
    });
  } catch (err) {
    throw new Error(`Could not reach Google Chat: ${err.message}`);
  }

  const answer = await res.text();
  if (!res.ok) {
    // The two that actually happen, translated. Both read as opaque JSON
    // otherwise, and both are configuration rather than faults.
    const hint =
      res.status === 404 ? " — the webhook no longer exists. Recreate it in the space and replace the secret."
      : res.status === 403 ? " — the webhook was rejected. It may have been deleted, or the space removed."
      : "";
    throw new Error(`Google Chat returned ${res.status}: ${answer.slice(0, 160)}${hint}`);
  }
  return { ok: true };
}

/** True when a webhook is configured at all. */
export const chatConfigured = (env = process.env) => Boolean((env.GCHAT_WEBHOOK_URL || "").trim());
