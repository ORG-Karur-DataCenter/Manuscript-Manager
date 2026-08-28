#!/usr/bin/env node
/**
 * Checks the deadline reminders.
 *
 * Two failures matter here and they pull in opposite directions. Sending too
 * often is the likelier one — the sync runs eight times a day, so anything that
 * merely asks "is this overdue?" sends eight messages a day forever, and the
 * quickest way to make someone ignore a deadline alert is to send a hundred of
 * them. Sending too rarely is the worse one: the whole point is a five-day
 * window that must not pass unnoticed.
 *
 * So most of what follows is about exactly when a message goes out, and how
 * many times.
 *
 *   node scripts/check-notify.mjs
 */
import {
  DEFAULT_POLICY, pendingDeadlines, dueReminders, composeMessage, composeFor,
  composeTemplateParams, recordSent, reachedSomeone, pruneLedger,
} from "./lib/notify.mjs";
import {
  resolveDeadline, parseStatedDate, daysLeft, describeDeadline, defaultDaysFor,
  ZONE_OFFSET_MINUTES,
} from "./lib/deadline.mjs";
import { readRecipients, normalizePhone, sendToAll } from "./lib/whatsapp.mjs";
import { syncIssues, commentReminder, issueTitle, issueBody } from "./lib/issues.mjs";

let passed = 0;
const failures = [];
const assert = (cond, msg) => { if (!cond) throw new Error(msg); };

async function check(name, fn) {
  try { await fn(); passed++; }
  catch (err) { failures.push(`${name}\n    ${err.message}`); }
}

const DAY = 86400000;
const NOW = Date.parse("2026-09-01T09:00:00Z");
const ago = (days) => new Date(NOW - days * DAY).toISOString();
const ahead = (days) => new Date(NOW + days * DAY).toISOString();

/** An amendment sitting in needs_action with a clock on it. */
function amendment({ id = "m1", due, source = "stated", eventType = "sent_back", ...rest } = {}) {
  return {
    id,
    title: "Does Anatomy Outweigh Biology in Cervical Spine Giant Cell Tumour Recurrence",
    bucket: "needs_action",
    needsActionReason: "pre_review_edits",
    actionFlag: true,
    actionLabel: "Amendments requested",
    currentJournal: "International Orthopaedics",
    currentManuscriptNumber: "INOR-D-26-00412",
    deadline: due,
    deadlineSource: source,
    timeline: [{ eventType, timestamp: ago(2), journal: "International Orthopaedics", note: "Returned after technical check." }],
    ...rest,
  };
}
const registryOf = (...manuscripts) => ({ manuscripts });

// --- reading a journal's own words -----------------------------------------

await check("an explicit date is read whichever way the journal writes it", () => {
  const forms = ["12 September 2026", "12th September 2026", "September 12, 2026", "Sep 12 2026", "2026-09-12"];
  for (const form of forms) {
    const at = parseStatedDate(form, { relativeTo: NOW });
    assert(at !== null, `could not read "${form}"`);
    const d = new Date(at);
    assert(
      d.getUTCFullYear() === 2026 && d.getUTCMonth() === 8 && d.getUTCDate() === 12,
      `"${form}" was read as ${d.toISOString()}`
    );
  }
});

await check("a deadline falls at the end of its local day, not the start", () => {
  // Read back through the group's own offset: the last minute of 12 September
  // where they are, not the last minute of it in UTC.
  const local = new Date(parseStatedDate("12 September 2026") + ZONE_OFFSET_MINUTES * 60000);
  assert(local.getUTCDate() === 12, `it landed on the ${local.getUTCDate()}th`);
  assert(local.getUTCHours() === 23, "a deadline would be missed at one minute past midnight");
});

await check("an ambiguous all-numeric date is refused rather than guessed", () => {
  // 12/09/2026 is 12 September to half the world and 9 December to the other
  // half. A deadline read a month wrong is worse than one left unknown.
  const resolved = resolveDeadline({
    eventTimestamp: ago(1), statedDate: "12/09/2026", journal: "Nowhere", policy: {},
  });
  assert(resolved === null, `it guessed: ${JSON.stringify(resolved)}`);
});

await check('"within 14 days" is counted from the email', () => {
  const r = resolveDeadline({ eventTimestamp: ago(0), statedDays: 14, policy: {} });
  assert(r.source === "stated", `source is ${r.source}`);
  assert(daysLeft(r.due, NOW) === 14, `got ${daysLeft(r.due, NOW)} days`);
});

await check("a stated date beats a stated period", () => {
  const r = resolveDeadline({
    eventTimestamp: ago(0), statedDate: ahead(5), statedDays: 14, policy: {},
  });
  assert(daysLeft(r.due, NOW) === 5, `the period won: ${daysLeft(r.due, NOW)} days`);
});

await check("a date already past when the email was sent is not believed", () => {
  // Usually a date quoted from an earlier letter, or a year filled in wrongly.
  const r = resolveDeadline({
    eventTimestamp: ago(1), statedDate: "12 September 2019", statedDays: 7, policy: {},
  });
  assert(r.source === "stated" && daysLeft(r.due, NOW) === 6, `fell back badly: ${JSON.stringify(r)}`);
});

await check("a journal's usual window is used when the email says nothing, and marked as a guess", () => {
  const policy = { defaultDays: 7, journalDays: { "Global Spine Journal": 14 } };
  const r = resolveDeadline({ eventTimestamp: ago(0), journal: "Global Spine Journal", policy });
  assert(r.source === "assumed", `source is ${r.source}`);
  assert(daysLeft(r.due, NOW) === 14, `got ${daysLeft(r.due, NOW)} days`);
  assert(/not stated/i.test(r.basis), `the basis does not admit it is a guess: ${r.basis}`);
});

await check("a journal is matched despite the name it arrives under", () => {
  const policy = { journalDays: { "International Orthopaedics": 7 } };
  assert(defaultDaysFor("International Orthopaedics (SICOT)", policy) === 7, "the suffixed form missed");
  assert(defaultDaysFor("international orthopaedics", policy) === 7, "lower case missed");
});

await check("with nothing to go on and no default, there is no deadline", () => {
  const r = resolveDeadline({ eventTimestamp: ago(0), journal: "Somewhere New", policy: { journalDays: {} } });
  assert(r === null, "it invented a deadline out of nothing");
});

// --- who is on a clock ------------------------------------------------------

await check("a manuscript that has moved on is no longer chased", () => {
  const done = amendment({ due: ahead(3), bucket: "in_review", actionFlag: false });
  assert(pendingDeadlines(registryOf(done), { now: NOW }).length === 0, "it is still being chased");
});

await check("a revision is left alone unless the policy asks for it", () => {
  const revision = amendment({ due: ahead(3), eventType: "revision_requested" });
  assert(pendingDeadlines(registryOf(revision), { now: NOW }).length === 0, "revisions were chased by default");

  const policy = { ...DEFAULT_POLICY, eventTypes: ["sent_back", "revision_requested"] };
  assert(pendingDeadlines(registryOf(revision), { policy, now: NOW }).length === 1, "the policy was ignored");
});

await check("a deadline from long ago is not resurrected", () => {
  const ancient = amendment({ due: ago(200) });
  assert(pendingDeadlines(registryOf(ancient), { now: NOW }).length === 0, "old news would have been sent");
});

// --- when a message goes out, and how often ---------------------------------

await check("a newly seen amendment is announced once", () => {
  const registry = registryOf(amendment({ due: ahead(6) }));
  const ledger = { sent: [] };

  const first = dueReminders(registry, ledger, { now: NOW });
  assert(first.length === 1 && first[0].kind === "new", `got ${JSON.stringify(first.map((r) => r.kind))}`);

  recordSent(ledger, first[0], [{ name: "Dhibin", ok: true }]);
  assert(dueReminders(registry, ledger, { now: NOW }).length === 0, "it would have been announced twice");
});

await check("eight runs a day produce one message, not eight", () => {
  // The failure this whole file exists to prevent.
  const registry = registryOf(amendment({ due: ahead(2) }));
  const ledger = { sent: [] };
  let messages = 0;
  for (let hour = 0; hour < 24 * 4; hour += 3) {
    const now = NOW + hour * 3600000;
    for (const reminder of dueReminders(registry, ledger, { now })) {
      messages++;
      recordSent(ledger, reminder, [{ name: "Dhibin", ok: true }]);
    }
  }
  // Over four days: one on first sight (standing in for the 3-day warning,
  // which was already owing), one at a day out, one when it passed.
  assert(messages === 3, `sent ${messages} messages over four days`);
});

await check("stages owing at the same moment become one message, not two", () => {
  // An amendment first seen when it is already inside the warning window has
  // both "new" and "3 days left" owing. Two messages seconds apart about the
  // same paper is the noise this whole file guards against.
  const registry = registryOf(amendment({ due: ahead(2) }));
  const ledger = { sent: [] };
  const due = dueReminders(registry, ledger, { now: NOW });

  assert(due.length === 1, `${due.length} messages would have gone out at once`);
  assert(due[0].kind === "new", `the first word about it was "${due[0].kind}", not the news`);
  assert(due[0].supersedes.includes(`m1|${ahead(2)}|t-3`), "the warning it stood in for was not carried along");

  recordSent(ledger, due[0], [{ name: "Dhibin", ok: true }]);
  assert(
    dueReminders(registry, ledger, { now: NOW }).length === 0,
    "the superseded warning would arrive separately a few hours later"
  );
});

await check("a first message still reads as urgent when the window is nearly gone", () => {
  const registry = registryOf(amendment({ due: ahead(1) }));
  const [reminder] = dueReminders(registry, { sent: [] }, { now: NOW });
  const text = composeMessage(reminder, { now: NOW });
  assert(/Amendments requested/.test(text), "it lost the news framing");
  assert(text.startsWith("🔴"), `it does not read as urgent: ${text.split("\n")[0]}`);
  assert(/due tomorrow/.test(text), `no urgency in the timing: ${text.split("\n")[0]}`);
});

await check("a skipped run makes a reminder late, never missing", () => {
  // If the workflow is down for two days, what was owing must still fire when
  // it comes back rather than being stepped over in silence.
  const registry = registryOf(amendment({ due: ahead(3) }));
  const ledger = { sent: [] };
  const due = dueReminders(registry, ledger, { now: NOW + 3 * DAY });

  assert(due.length === 1, `${due.length} messages after an outage`);
  assert(
    due[0].supersedes.length === 2,
    `the warnings missed during the outage were dropped, not folded in: ${JSON.stringify(due[0].supersedes)}`
  );
  assert(/due today/.test(composeMessage(due[0], { now: NOW + 3 * DAY })), "it does not say how little time is left");
});

await check("an amendment that goes past its date is chased once, then left", () => {
  // Announced while it was still live, so the overdue stage is reached the
  // ordinary way rather than being folded into a first message.
  const registry = registryOf(amendment({ due: ahead(4) }));
  const ledger = { sent: [] };
  let overdue = 0;
  let total = 0;
  for (let day = 0; day < 30; day++) {
    for (const r of dueReminders(registry, ledger, { now: NOW + day * DAY })) {
      if (r.kind === "overdue") overdue++;
      total++;
      recordSent(ledger, r, [{ name: "Dhibin", ok: true }]);
    }
  }
  assert(overdue === 1, `chased ${overdue} times about the same overdue amendment`);
  assert(total === 4, `${total} messages over a month about one amendment`);
});

await check("an amendment already past its date when first seen is mentioned once", () => {
  const registry = registryOf(amendment({ due: ago(1) }));
  const ledger = { sent: [] };
  let total = 0;
  for (let day = 0; day < 20; day++) {
    for (const r of dueReminders(registry, ledger, { now: NOW + day * DAY })) {
      total++;
      recordSent(ledger, r, [{ name: "Dhibin", ok: true }]);
    }
  }
  assert(total === 1, `${total} messages about an amendment that was already late when found`);
});

await check("a new date from the journal re-arms the reminders", () => {
  const m = amendment({ due: ahead(2) });
  const ledger = { sent: [] };
  for (const r of dueReminders(registryOf(m), ledger, { now: NOW })) {
    recordSent(ledger, r, [{ name: "Dhibin", ok: true }]);
  }
  assert(dueReminders(registryOf(m), ledger, { now: NOW }).length === 0, "not settled");

  // The journal writes again with an extension.
  m.deadline = ahead(10);
  const after = dueReminders(registryOf(m), ledger, { now: NOW });
  assert(after.some((r) => r.kind === "new"), "an extended deadline was never announced");
});

await check("a reminder that reached nobody is retried, not written off", () => {
  const registry = registryOf(amendment({ due: ahead(6) }));
  const ledger = { sent: [] };
  const [reminder] = dueReminders(registry, ledger, { now: NOW });

  const allFailed = [{ name: "Dhibin", ok: false, error: "network" }];
  assert(!reachedSomeone(allFailed), "a total failure was treated as delivery");
  // notify.mjs records only when reachedSomeone; nothing is written here, so:
  assert(dueReminders(registry, ledger, { now: NOW }).length === 1, "the message would have been lost");

  const partial = [{ name: "Dhibin", ok: true }, { name: "Dr Sathish", ok: false, error: "bad key" }];
  assert(reachedSomeone(partial), "a partial delivery was treated as failure");
  recordSent(ledger, reminder, partial);
  assert(ledger.sent[0].failed.length === 1, "the failure was not written down beside it");
  assert(dueReminders(registry, ledger, { now: NOW }).length === 0, "the one who got it would be told twice");
});

// --- what the message says --------------------------------------------------

await check("the message says the paper, the journal and the date", () => {
  const registry = registryOf(amendment({ due: ahead(3) }));
  const [reminder] = dueReminders(registry, { sent: [] }, { now: NOW });
  const text = composeMessage(reminder, { now: NOW });

  assert(/Cervical Spine Giant Cell/.test(text), "no title");
  assert(/International Orthopaedics/.test(text), "no journal");
  assert(/INOR-D-26-00412/.test(text), "no manuscript number");
  assert(/3 days left/.test(text), `no time remaining: ${text}`);
  assert(text.length < 700, `too long for a phone at ${text.length} characters`);
});

await check("an estimated date never passes itself off as the journal's", () => {
  const registry = registryOf(amendment({ due: ahead(3), source: "assumed" }));
  const [reminder] = dueReminders(registry, { sent: [] }, { now: NOW });
  const text = composeMessage(reminder, { now: NOW });
  assert(/estimated/i.test(text), `it reads as though the journal set the date:\n${text}`);
});

await check("an overdue message does not say days left", () => {
  const registry = registryOf(amendment({ due: ago(2) }));
  const [reminder] = dueReminders(registry, { sent: [] }, { now: NOW });
  const text = composeMessage(reminder, { now: NOW });
  assert(/2 days overdue/.test(text), `reads wrongly: ${text}`);
  assert(!/days left/.test(text), "it claims there is still time");
  assert(text.startsWith("🔴"), "a missed deadline does not read as urgent");
});

await check("the time remaining reads naturally at each stage", () => {
  // Real end-of-day deadlines, the way resolveDeadline produces them.
  const dueIn = (days) => resolveDeadline({ eventTimestamp: NOW, statedDays: days }).due;
  assert(describeDeadline(dueIn(5), NOW) === "5 days left", describeDeadline(dueIn(5), NOW));
  assert(describeDeadline(dueIn(1), NOW) === "due tomorrow", describeDeadline(dueIn(1), NOW));
  assert(describeDeadline(dueIn(7), NOW - 7 * DAY) === "14 days left", "a week out read wrongly");
  assert(describeDeadline(dueIn(7), NOW + 7 * DAY) === "due today", describeDeadline(dueIn(7), NOW + 7 * DAY));
  assert(describeDeadline(dueIn(7), NOW + 8 * DAY) === "1 day overdue", describeDeadline(dueIn(7), NOW + 8 * DAY));
  assert(describeDeadline(dueIn(7), NOW + 10 * DAY) === "3 days overdue", describeDeadline(dueIn(7), NOW + 10 * DAY));
});

await check("a deadline stays put for the whole of its last day", () => {
  // Someone opening the app at breakfast and again at bedtime on the due day
  // must be told the same thing, not "due today" then "overdue".
  const due = resolveDeadline({ eventTimestamp: NOW, statedDays: 3 }).due;
  const dueDayMorning = NOW + 3 * DAY - 4 * 3600000;
  const dueDayNight = NOW + 3 * DAY + 8 * 3600000;
  assert(describeDeadline(due, dueDayMorning) === "due today", describeDeadline(due, dueDayMorning));
  assert(describeDeadline(due, dueDayNight) === "due today", describeDeadline(due, dueDayNight));
});

// --- deadlines as GitHub issues, the floor under all of this ---------------

/** Stands in for the issues API, recording what was asked of it. */
function stubIssues({ nextNumber = 41 } = {}) {
  const calls = [];
  const fetchImpl = async (url, opts = {}) => {
    const path = new URL(url).pathname;
    calls.push({ path, method: opts.method || "GET", body: opts.body ? JSON.parse(opts.body) : null });
    if (path.endsWith("/issues") && opts.method === "POST") {
      return new Response(JSON.stringify({ number: nextNumber++ }), { status: 201 });
    }
    return new Response("{}", { status: 200 });
  };
  return { calls, fetchImpl, opened: () => calls.filter((c) => c.path.endsWith("/issues") && c.method === "POST") };
}

const pendingOf = (...manuscripts) =>
  pendingDeadlines(registryOf(...manuscripts), { now: NOW });

await check("an amendment opens one issue, not one every three hours", () => {
  // The same duplicate problem the messages have, and it must have the same
  // answer: eight runs a day must not open eight issues.
  const m = amendment({ due: ahead(4) });
  const ledger = {};
  const gh = stubIssues();

  return syncIssues(pendingOf(m), ledger, { token: "t", repo: "o/r", fetchImpl: gh.fetchImpl, now: NOW })
    .then(() => {
      assert(gh.opened().length === 1, `opened ${gh.opened().length} issues`);
      assert(ledger.issues.m1.number === 41, "the issue number was not remembered");
      return syncIssues(pendingOf(m), ledger, { token: "t", repo: "o/r", fetchImpl: gh.fetchImpl, now: NOW });
    })
    .then(() => {
      assert(gh.opened().length === 1, `a second run opened another issue (${gh.opened().length} total)`);
      const writes = gh.calls.filter((c) => c.method === "PATCH" || c.method === "POST");
      assert(writes.length === 1, `an unchanged deadline still wrote to GitHub ${writes.length} times`);
    });
});

await check("the issue carries the journal's own list of corrections", () => {
  const m = amendment({ due: ahead(4) });
  m.timeline[0].note =
    "Returned before review: 1. All authors' highest degrees must be on the title page. " +
    "2. Supplemental Table 2 is not cited in the text. 3. The License to Publish form was not supplied.";

  const body = issueBody(m);
  assert((body.match(/- \[ \]/g) || []).length === 3, `checklist has ${(body.match(/- \[ \]/g) || []).length} items:\n${body}`);
  assert(/highest degrees/.test(body), "an item was lost");
  assert(/License to Publish/.test(body), "the last item was lost");
  assert(/International Orthopaedics/.test(body), "no journal");
});

await check("an estimated date is flagged in the issue too", () => {
  const guessed = issueBody(amendment({ due: ahead(4), source: "assumed" }));
  assert(/estimated/i.test(guessed), "the issue passes a guess off as the journal's date");
  const stated = issueBody(amendment({ due: ahead(4), source: "stated" }));
  assert(/stated by the journal/i.test(stated), "a real date is not marked as one");
  assert(!/> The due date above is an estimate/.test(stated), "a stated date carries the estimate warning");
});

await check("a moved deadline retitles the issue and says so", () => {
  const m = amendment({ due: ahead(4) });
  const ledger = {};
  const gh = stubIssues();

  return syncIssues(pendingOf(m), ledger, { token: "t", repo: "o/r", fetchImpl: gh.fetchImpl, now: NOW })
    .then(() => {
      m.deadline = ahead(11);
      return syncIssues(pendingOf(m), ledger, { token: "t", repo: "o/r", fetchImpl: gh.fetchImpl, now: NOW });
    })
    .then(() => {
      const patched = gh.calls.find((c) => c.method === "PATCH");
      assert(patched, "the issue was not updated");
      assert(/11 days left/.test(patched.body.title), `title reads "${patched.body.title}"`);
      const said = gh.calls.find((c) => c.method === "POST" && /comments$/.test(c.path));
      assert(said && /deadline moved/i.test(said.body.body), "the change was made silently");
    });
});

await check("an amendment that is dealt with closes its issue", () => {
  const m = amendment({ due: ahead(4) });
  const ledger = {};
  const gh = stubIssues();

  return syncIssues(pendingOf(m), ledger, { token: "t", repo: "o/r", fetchImpl: gh.fetchImpl, now: NOW })
    .then(() => {
      // What applyEvent does once the journal moves the paper on.
      m.deadline = null;
      m.actionFlag = false;
      return syncIssues(pendingOf(m), ledger, { token: "t", repo: "o/r", fetchImpl: gh.fetchImpl, now: NOW });
    })
    .then((result) => {
      assert(result.closed.length === 1, "the issue was left open after the work was done");
      const closing = gh.calls.find((c) => c.method === "PATCH" && c.body.state === "closed");
      assert(closing, "nothing actually closed it");
      return syncIssues(pendingOf(m), ledger, { token: "t", repo: "o/r", fetchImpl: gh.fetchImpl, now: NOW });
    })
    .then((result) => {
      assert(result.closed.length === 0, "it tried to close an already-closed issue");
    });
});

await check("a stage reminder comments on the issue", () => {
  const m = amendment({ due: ago(1) });
  const ledger = { issues: { m1: { number: 41, title: "x", due: m.deadline } } };
  const gh = stubIssues();
  const [reminder] = dueReminders(registryOf(m), { sent: [] }, { now: NOW });

  return commentReminder(reminder, ledger, { token: "t", repo: "o/r", fetchImpl: gh.fetchImpl, now: NOW })
    .then((number) => {
      assert(number === 41, `commented on issue ${number}`);
      const said = gh.calls.find((c) => /comments$/.test(c.path));
      assert(/1 day overdue/.test(said.body.body), `comment reads: ${said.body.body}`);
      assert(/still in the system/i.test(said.body.body), "an overdue comment does not say what to check");
    });
});

await check("with no token, issues are skipped rather than crashing the reminders", () => {
  return syncIssues(pendingOf(amendment({ due: ahead(4) })), {}, { token: "", repo: "" })
    .then((result) => {
      assert(result.skipped, "a missing token was not reported as skipped");
      assert(result.opened.length === 0, "it claimed to open something");
    });
});

await check("the issue title is short enough to read in a notification", () => {
  const m = amendment({ due: ahead(4) });
  m.title = "A Really Very Long Manuscript Title ".repeat(6);
  const title = issueTitle(m, { now: NOW });
  assert(title.length <= 110, `${title.length} characters: ${title}`);
  assert(/4 days left/.test(title), `the title does not carry the urgency: ${title}`);
});

// --- the template path, which is the only one Meta will accept -------------

await check("Meta sends a template, because a reminder is always outside the 24-hour window", () => {
  // Meta allows free text only within 24 hours of the recipient writing to
  // you. Nobody replies to a deadline reminder, so every one falls outside
  // that window and plain text would be rejected essentially always.
  const registry = registryOf(amendment({ due: ahead(3) }));
  const [reminder] = dueReminders(registry, { sent: [] }, { now: NOW });

  let sent = null;
  return sendToAll([{ name: "Dhibin", phone: "918778138148" }], composeFor(reminder, { now: NOW }), {
    transport: "meta",
    env: { META_WHATSAPP_TOKEN: "t", META_WHATSAPP_PHONE_ID: "1", META_WHATSAPP_TEMPLATE: "amendment_due" },
    fetchImpl: async (url, opts) => { sent = JSON.parse(opts.body); return new Response("{}", { status: 200 }); },
  }).then(() => {
    assert(sent.type === "template", `sent as ${sent.type}, which Meta would reject`);
    assert(sent.template.name === "amendment_due", "the wrong template was named");
    const values = sent.template.components[0].parameters.map((p) => p.text);
    assert(values.length === 5, `${values.length} parameters, template expects 5`);
    assert(/3 days left/.test(values[1]), `no time remaining: ${values[1]}`);
    assert(/Cervical Spine/.test(values[2]), `no title: ${values[2]}`);
    assert(/International Orthopaedics/.test(values[3]), `no journal: ${values[3]}`);
  });
});

await check("no template parameter carries a newline, which Meta rejects", () => {
  // It refuses newlines, tabs and long runs of spaces, and does not say which
  // parameter is at fault -- so this must not be discovered in production.
  const registry = registryOf(amendment({
    due: ahead(3),
    title: "A Title\nWith A Line Break\tAnd    Wide     Spacing",
  }));
  const [reminder] = dueReminders(registry, { sent: [] }, { now: NOW });

  let sent = null;
  return sendToAll([{ name: "Dhibin", phone: "918778138148" }], composeFor(reminder, { now: NOW }), {
    transport: "meta",
    env: { META_WHATSAPP_TOKEN: "t", META_WHATSAPP_PHONE_ID: "1", META_WHATSAPP_TEMPLATE: "amendment_due" },
    fetchImpl: async (url, opts) => { sent = JSON.parse(opts.body); return new Response("{}", { status: 200 }); },
  }).then(() => {
    for (const p of sent.template.components[0].parameters) {
      assert(!/[\r\n\t]/.test(p.text), `a parameter carries a line break: ${JSON.stringify(p.text)}`);
      assert(!/ {4,}/.test(p.text), `a parameter carries a long run of spaces: ${JSON.stringify(p.text)}`);
    }
  });
});

await check("Meta's 24-hour refusal explains itself", () => {
  return sendToAll([{ name: "Dhibin", phone: "918778138148" }], { text: "hello", params: [] }, {
    transport: "meta",
    env: { META_WHATSAPP_TOKEN: "t", META_WHATSAPP_PHONE_ID: "1" },
    fetchImpl: async () => new Response(
      JSON.stringify({ error: { code: 131047, message: "Re-engagement message" } }), { status: 400 }
    ),
  }).then((results) => {
    assert(!results[0].ok, "a rejection was reported as a send");
    assert(/META_WHATSAPP_TEMPLATE/.test(results[0].error), `does not say how to fix it: ${results[0].error}`);
  });
});

await check("the template fields say the same thing as the text", () => {
  const registry = registryOf(amendment({ due: ago(2), source: "assumed" }));
  const [reminder] = dueReminders(registry, { sent: [] }, { now: NOW });
  const params = composeTemplateParams(reminder, { now: NOW });
  const text = composeMessage(reminder, { now: NOW });

  assert(/overdue/i.test(params[0]) || /overdue/i.test(params[1]), `template does not say it is overdue: ${params}`);
  assert(/overdue/i.test(text), "text does not say it is overdue");
  assert(/estimated/i.test(params[4]), `template hides that the date is a guess: ${params[4]}`);
  assert(/estimated/i.test(text), "text hides that the date is a guess");
});

// --- recipients and sending -------------------------------------------------

await check("an Indian mobile is given its country code", () => {
  assert(normalizePhone("9600856806") === "919600856806", normalizePhone("9600856806"));
  assert(normalizePhone("+91 8778138148") === "918778138148", normalizePhone("+91 8778138148"));
  assert(normalizePhone("918778138148") === "918778138148", "an already-prefixed number was mangled");
  assert(normalizePhone("") === null, "an empty number became something");
});

await check("a malformed recipients secret is reported, not silently ignored", () => {
  let threw = false;
  try { readRecipients({ WHATSAPP_RECIPIENTS: "9600856806, 8778138148" }); }
  catch (err) { threw = /valid JSON/.test(err.message); }
  assert(threw, "a plain list of numbers was accepted, and nobody would ever be messaged");
});

await check("recipients are read from the environment", () => {
  const list = readRecipients({
    WHATSAPP_RECIPIENTS: JSON.stringify([
      { name: "Dr Sathish", phone: "9600856806", apiKey: "111" },
      { name: "Dhibin", phone: "+91 8778138148", apiKey: "222" },
      { name: "no number", phone: "" },
    ]),
  });
  assert(list.length === 2, `expected 2 usable recipients, got ${list.length}`);
  assert(list[0].phone === "919600856806", list[0].phone);
});

await check("one bad key does not stop the other person being told", () => {
  const recipients = [
    { name: "Dr Sathish", phone: "919600856806", apiKey: "" },
    { name: "Dhibin", phone: "918778138148", apiKey: "222" },
  ];
  return sendToAll(recipients, "test", {
    transport: "callmebot",
    fetchImpl: async () => new Response("Message queued", { status: 200 }),
  }).then((results) => {
    assert(results.length === 2, "somebody was skipped entirely");
    assert(results[0].ok === false && /apiKey/i.test(results[0].error), "the missing key was not reported");
    assert(results[1].ok === true, "the second person was not told because the first failed");
  });
});

await check("CallMeBot's errors are caught even though it returns 200", () => {
  return sendToAll([{ name: "Dhibin", phone: "918778138148", apiKey: "222" }], "test", {
    transport: "callmebot",
    fetchImpl: async () => new Response("<p>APIKey is invalid</p>", { status: 200 }),
  }).then((results) => {
    assert(!results[0].ok, "an invalid key was reported as a successful send");
  });
});

await check("a network failure is not blamed on the recipient's phone", () => {
  // The tempting mistake: pattern-match the word "allow" anywhere in a failure
  // and tell someone their number is not authorised, sending them off to fix a
  // phone when the host was simply unreachable.
  return sendToAll([{ name: "Dhibin", phone: "918778138148", apiKey: "222" }], "test", {
    transport: "callmebot",
    fetchImpl: async () => { throw new Error("getaddrinfo ENOTFOUND api.callmebot.com"); },
  }).then((results) => {
    assert(!results[0].ok, "an unreachable host was reported as a successful send");
    assert(/could not reach/i.test(results[0].error), `unhelpful: ${results[0].error}`);
    assert(
      !/authoris|authoriz|I allow callmebot/i.test(results[0].error),
      `a network failure was misdiagnosed as an authorisation problem: ${results[0].error}`
    );
  });
});

await check("a missing key names the person it belongs to", () => {
  return sendToAll([
    { name: "Dr Sathish", phone: "919600856806", apiKey: "111" },
    { name: "Dhibin", phone: "918778138148", apiKey: "" },
  ], "test", {
    transport: "callmebot",
    fetchImpl: async () => new Response("Message queued", { status: 200 }),
  }).then((results) => {
    assert(results[1].error.includes("Dhibin"), `does not say whose key is missing: ${results[1].error}`);
    assert(/callmebot\.com/i.test(results[1].error), "does not say where to get one");
  });
});

await check("no phone number is ever written into the ledger", () => {
  // The ledger is committed to a public repository; the numbers are not.
  const ledger = { sent: [] };
  const registry = registryOf(amendment({ due: ahead(3) }));
  const [reminder] = dueReminders(registry, ledger, { now: NOW });
  recordSent(ledger, reminder, [{ name: "Dhibin", phone: "918778138148", ok: true }]);
  const text = JSON.stringify(ledger);
  assert(!/9\d{11}/.test(text), `a phone number reached the ledger: ${text}`);
});

await check("the ledger does not grow without bound", () => {
  const ledger = { sent: Array.from({ length: 900 }, (_, i) => ({ key: `k${i}` })) };
  pruneLedger(ledger, { keep: 500 });
  assert(ledger.sent.length === 500, `${ledger.sent.length} entries kept`);
  assert(ledger.sent[499].key === "k899", "it kept the oldest instead of the newest");
});

// ---------------------------------------------------------------------------

if (failures.length) {
  console.error(`\n${failures.length} of ${passed + failures.length} reminder checks failed:\n`);
  for (const f of failures) console.error(`  ✗ ${f}\n`);
  process.exit(1);
}
console.log(`✓ all ${passed} reminder checks passed`);
