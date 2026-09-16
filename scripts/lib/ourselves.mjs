/**
 * Mail the group sent to itself.
 *
 * WHY THIS IS NOT JOURNAL CORRESPONDENCE. When one author forwards a journal's
 * letter to another, the forward arrives with TODAY's date, not the date the
 * journal wrote. The registry reads the newest event as the current state, so
 * a rejection forwarded weeks later becomes the newest thing known about the
 * paper and drags it back to "rejected" -- even when it has since been
 * submitted somewhere else and the tracker already knew.
 *
 * That is not hypothetical. "Is Three-Level Hybrid Cervical Surgery as Safe as
 * Three-Level ACDF" was rejected by Archives of Orthopaedic and Trauma Surgery,
 * resubmitted to JBJS Open Access, and then read as needing a new home because
 * the old rejection was forwarded in afterwards.
 *
 * The forward also carries nothing new: if the journal wrote to anyone whose
 * mailbox is polled, the original is already filed, with its real date. So a
 * forward is at best a duplicate and at worst a time machine.
 *
 * NARROW ON PURPOSE. This suppresses mail from the tracked people themselves,
 * not mail from every personal address. Editors, co-authors and even whole
 * journals write from gmail -- this registry has events from
 * journalofarthroplasty@gmail.com and from editors at their own addresses, and
 * every one of them is real correspondence that must keep filing.
 */

/** The addresses whose own mail is internal chatter rather than news. */
export function ourAddresses(accounts = [], extra = []) {
  const out = new Set();
  for (const a of accounts) {
    if (a && a.email) out.add(a.email.trim().toLowerCase());
    // Addresses that forward INTO a polled mailbox are ours too: a person
    // writing from one of them is still the group talking to itself.
    for (const alias of a?.aliases || []) out.add(String(alias).trim().toLowerCase());
  }
  for (const e of extra) if (e) out.add(String(e).trim().toLowerCase());
  return out;
}

/** The bare address out of a From header, or "" when there is not one. */
export function addressOf(from) {
  const m = String(from || "").match(/<\s*([^<>\s]+@[^<>\s]+?)\s*>/) ||
            String(from || "").match(/([^\s<>,;]+@[^\s<>,;]+)/);
  return m ? m[1].trim().toLowerCase().replace(/[.,;]+$/, "") : "";
}

/**
 * True when this message is one of us writing to another of us.
 *
 * Only the sender is tested. A journal writing TO the group is the whole point
 * of the tracker; the group writing to anyone is the thing that has no date
 * worth trusting.
 */
export function isFromOurselves(from, ours) {
  const address = addressOf(from);
  return Boolean(address) && ours.has(address);
}
