/**
 * When the journal wants it back.
 *
 * An amendment — a manuscript returned to the author by the editorial office
 * before it ever reaches peer review — is the one event in this tracker with a
 * clock on it. Journals give somewhere between five and fourteen days, and a
 * missed one usually means the submission is withdrawn and the whole thing
 * starts again. Everything else here can wait for someone to notice; this
 * cannot.
 *
 * So the deadline is worked out here, from three sources in descending order of
 * trust:
 *
 *   1. A calendar date the email states outright.  ("by 12 September 2026")
 *   2. A period the email states.                  ("within 14 days")
 *   3. This journal's usual window, from config.   (an assumption, and marked)
 *
 * The third is a guess and is labelled one, everywhere it surfaces. A guessed
 * date that looks like a stated one is worse than no date at all: it invites
 * someone to trust a number the journal never gave.
 */

const DAY = 86400000;

/**
 * A deadline is a calendar day, not an instant, and the calendar that counts is
 * the one the people acting on it live in. "Due Friday" has to mean Friday
 * where they are: computing in UTC puts an Indian evening into the next day and
 * reports one fewer day left than there really is.
 *
 * Asia/Kolkata is UTC+5:30 and has no daylight saving, so a fixed offset is
 * exact here rather than an approximation. Change these two together if the
 * group ever works from somewhere that does observe it.
 */
export const ZONE_OFFSET_MINUTES = 330;
export const ZONE_LABEL = "Asia/Kolkata";
const ZONE_MS = ZONE_OFFSET_MINUTES * 60000;

/** Which calendar day an instant falls on, locally. */
const dayIndex = (ms) => Math.floor((ms + ZONE_MS) / DAY);

/**
 * Journals write dates for humans, in whatever order their office prefers.
 * Date.parse handles the ISO and US forms; these cover the rest without
 * pulling in a date library for six formats.
 */
const MONTHS = {
  jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5,
  jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11,
};

/**
 * Parse a date the way an email writes one. Returns a UTC timestamp at the end
 * of that day: a deadline of "12 September" is not missed at one minute past
 * midnight on the 12th.
 */
export function parseStatedDate(text, { relativeTo } = {}) {
  if (!text) return null;
  const s = String(text).trim();

  // 2026-09-12
  let m = s.match(/(\d{4})-(\d{2})-(\d{2})/);
  if (m) return endOfDay(Number(m[1]), Number(m[2]) - 1, Number(m[3]));

  // 12 September 2026 / 12 Sep 2026 / 12th September 2026
  m = s.match(/\b(\d{1,2})(?:st|nd|rd|th)?\s+([A-Za-z]{3,9})\.?,?\s*(\d{4})?/);
  if (m && MONTHS[m[2].slice(0, 3).toLowerCase()] !== undefined) {
    return endOfDay(year(m[3], relativeTo), MONTHS[m[2].slice(0, 3).toLowerCase()], Number(m[1]));
  }

  // September 12, 2026 / Sep 12 2026
  m = s.match(/\b([A-Za-z]{3,9})\.?\s+(\d{1,2})(?:st|nd|rd|th)?,?\s*(\d{4})?/);
  if (m && MONTHS[m[1].slice(0, 3).toLowerCase()] !== undefined) {
    return endOfDay(year(m[3], relativeTo), MONTHS[m[1].slice(0, 3).toLowerCase()], Number(m[2]));
  }

  // 12/09/2026 is 12 September to half the world and 9 December to the other
  // half, and nothing in the email says which. A deadline read a month wrong is
  // worse than one left unknown, so this is refused rather than guessed at --
  // including by Date.parse, which would quietly pick the American reading.
  if (/\b\d{1,4}[/.]\d{1,2}[/.]\d{1,4}\b/.test(s)) return null;

  const parsed = Date.parse(s);
  return Number.isFinite(parsed) ? parsed : null;
}

/** A year the email omitted is the one that makes the date fall after the email. */
function year(stated, relativeTo) {
  if (stated) return Number(stated);
  const base = relativeTo ? new Date(relativeTo) : new Date();
  return base.getUTCFullYear();
}

/** The last moment of a local calendar day, as a real instant. */
const endOfDay = (y, monthIndex, day) =>
  Date.UTC(y, monthIndex, day, 23, 59, 59, 999) - ZONE_MS;

/**
 * Work out one deadline for an event.
 *
 * `journalDefaults` maps a journal name to its usual number of days; `fallback`
 * is used when even the journal is unknown. Returns null when there is nothing
 * to go on and no fallback — the caller must be able to tell "no deadline" from
 * "a deadline I invented".
 */
export function resolveDeadline({
  eventTimestamp,
  statedDate = null,
  statedDays = null,
  journal = null,
  policy = {},
} = {}) {
  const at = new Date(eventTimestamp).getTime();
  if (!Number.isFinite(at)) return null;

  const stated = parseStatedDate(statedDate, { relativeTo: at });
  // A "deadline" already past when the email was sent is a misread — a date
  // quoted from an earlier letter, or a year the model filled in wrongly.
  if (stated && stated >= at - DAY) {
    return { due: new Date(stated).toISOString(), source: "stated", basis: String(statedDate) };
  }

  if (Number.isFinite(statedDays) && statedDays > 0) {
    return {
      due: new Date(endOfDayFrom(at + statedDays * DAY)).toISOString(),
      source: "stated",
      basis: `${statedDays} days from the email`,
    };
  }

  const days = defaultDaysFor(journal, policy);
  if (!days) return null;
  return {
    due: new Date(endOfDayFrom(at + days * DAY)).toISOString(),
    source: "assumed",
    basis: `${days} days — this journal's usual window, not stated in the email`,
  };
}

/** The end of whichever local day an instant falls in. */
function endOfDayFrom(ms) {
  const local = new Date(ms + ZONE_MS);
  return endOfDay(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate());
}

/**
 * Journals are matched loosely, because the same journal arrives written half a
 * dozen ways across a year of email — "Int Orthop", "International Orthopaedics
 * (SICOT)", and so on.
 */
export function defaultDaysFor(journal, policy = {}) {
  const table = policy.journalDays || {};
  const name = normalize(journal);
  if (name) {
    if (table[journal]) return table[journal];
    for (const [key, days] of Object.entries(table)) {
      const k = normalize(key);
      if (k && (name === k || name.includes(k) || k.includes(name))) return days;
    }
  }
  return policy.defaultDays || null;
}

const normalize = (s) =>
  (s || "").toLowerCase().replace(/[^a-z0-9 ]/g, " ").replace(/\s+/g, " ").trim();

/**
 * Calendar days from today until the day it is due; negative once past.
 *
 * Counted in whole local days rather than by subtracting instants, so a
 * deadline is "3 days left" all day on the day it becomes so, whatever the
 * hour. Subtracting instants would tick it over to 2 at teatime.
 */
export function daysLeft(due, now = Date.now()) {
  const at = new Date(due).getTime();
  if (!Number.isFinite(at)) return null;
  return dayIndex(at) - dayIndex(new Date(now).getTime());
}

/** How a deadline should read to a person, in a card or a WhatsApp message. */
export function describeDeadline(due, now = Date.now()) {
  const left = daysLeft(due, now);
  if (left === null) return "";
  if (left < 0) return left === -1 ? "1 day overdue" : `${-left} days overdue`;
  if (left === 0) return "due today";
  if (left === 1) return "due tomorrow";
  return `${left} days left`;
}
