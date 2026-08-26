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
