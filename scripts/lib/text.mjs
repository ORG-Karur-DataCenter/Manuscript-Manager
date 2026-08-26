/**
 * Turning a mail body into something a classifier can read. Shared because
 * both Gmail and Microsoft Graph hand back HTML for most journal mail, and the
 * two were otherwise going to carry identical copies of this.
 */
export function stripHtml(html) {
  return html
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/p>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/[ \t]+/g, " ")
    // An inline tag becomes a space, so "<i>accepted</i>." lands as
    // "accepted ." -- which reads oddly to a classifier and leaves a stray
    // space on the end of any title extracted from the sentence.
    .replace(/ +([.,;:!?)\]])/g, "$1")
    .replace(/([(\[]) +/g, "$1")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/**
 * When an event actually happened, as opposed to when this mailbox saw it.
 *
 * Normally the two agree to within seconds. They diverge sharply when history
 * is imported from another account: the message is months old, but the
 * receiving mailbox stamps it with today. Dating events by delivery would put
 * an entire imported history on the day of the import and flatten every
 * timeline built from it.
 *
 * The message's own Date header is preferred only when it is meaningfully
 * EARLIER. A header later than delivery is either a clock error or spam
 * backdating the future, and a gap of hours is ordinary delivery lag.
 */
export function eventTimestamp(receivedMs, dateHeader) {
  const received = receivedMs ? new Date(Number(receivedMs)) : new Date();
  const sent = dateHeader ? new Date(dateHeader) : null;
  if (!sent || Number.isNaN(sent.getTime())) return received.toISOString();
  const daysEarlier = (received.getTime() - sent.getTime()) / 86400000;
  if (daysEarlier > 2 && sent.getUTCFullYear() > 2000) return sent.toISOString();
  return received.toISOString();
}
