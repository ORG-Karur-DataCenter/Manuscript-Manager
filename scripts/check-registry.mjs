/**
 * Known-answer checks for the registry rules that were learned the hard way.
 * Needs no API keys and no network: run it before touching registry.mjs.
 *
 *   node scripts/check-registry.mjs
 */
import { applyEvent, applyEdit, isPinned } from "./lib/registry.mjs";

const reg = { manuscripts: [] };
const ev = (o) => ({ revisionRound: null, doi: null, publicationLink: null, summary: "", needsReview: false, ...o });

// A paper submitted to International Orthopaedics, then rejected there.
applyEvent(reg, ev({ title: "Orthobiologics in Regenerative Orthopedics: A Scoping Review", journal: "International Orthopaedics", manuscriptNumber: "INOR-1", eventType: "new_submission", timestamp: "2026-03-01T00:00:00Z", source: { messageId: "m1" } }));
applyEvent(reg, ev({ title: "Orthobiologics in Regenerative Orthopedics: A Scoping Review", journal: "International Orthopaedics", manuscriptNumber: "INOR-1", eventType: "rejected", timestamp: "2026-03-20T00:00:00Z", source: { messageId: "m2" } }));

const m = reg.manuscripts[0];
console.log("after rejection  -> bucket:", m.bucket, "| submissions:", m.submissions.length, "| outcomes:", m.submissions.map(s => s.outcome).join(","));

// The transfer OFFER that leaks through as relevant: an "other" event at the
// journal that just rejected it.
applyEvent(reg, ev({ title: "Orthobiologics in Regenerative Orthopedics: A Scoping Review", journal: "International Orthopaedics", manuscriptNumber: null, eventType: "other", timestamp: "2026-03-21T00:00:00Z", source: { messageId: "m3" } }));

console.log("after the offer  -> bucket:", m.bucket, "| submissions:", m.submissions.length, "| outcomes:", m.submissions.map(s => s.outcome).join(","));
console.log("timeline:", m.timeline.map(t => t.eventType).join(" -> "));

// And an "other" at a journal the paper was never at: timeline only, no submission.
applyEvent(reg, ev({ title: "Orthobiologics in Regenerative Orthopedics: A Scoping Review", journal: "Some Other Journal", manuscriptNumber: null, eventType: "other", timestamp: "2026-03-22T00:00:00Z", source: { messageId: "m4" } }));
console.log("after stray other-> submissions:", m.submissions.length, "| journals:", m.submissions.map(s => s.journal).join(","));

let failures = 0;
const check = (name, ok) => { console.log(`${ok ? "PASS" : "FAIL"}  ${name}`); if (!ok) failures++; };

console.log("");
check("a transfer offer opens no phantom live submission",
  m.submissions.length === 1 && m.submissions[0].outcome === "rejected" && m.bucket === "needs_action");
check('an ambiguous "other" event does not overwrite a real status',
  m.currentStatus === "Rejected");

// A backfilled event landing after later ones must not speak for the present.
const reg2 = { manuscripts: [] };
applyEvent(reg2, ev({ title: "Late Arrival", journal: "Journal A", eventType: "rejected", timestamp: "2026-08-01T00:00:00Z", source: { messageId: "a1" } }));
applyEvent(reg2, ev({ title: "Late Arrival", journal: "Journal A", eventType: "under_review", timestamp: "2026-04-01T00:00:00Z", source: { messageId: "a2" } }));
const m2 = reg2.manuscripts[0];
check("a stale event joins the timeline without rewriting current status",
  m2.currentStatus === "Rejected" && m2.bucket === "needs_action" && m2.timeline.length === 2);
check("statusHistory is sorted however events arrive",
  m2.submissions[0].statusHistory.map((h) => h.timestamp).join() ===
    [...m2.submissions[0].statusHistory].map((h) => h.timestamp).sort().join());

// The sync window overlaps deliberately, so the same message will arrive twice.
const before = m2.timeline.length;
applyEvent(reg2, ev({ title: "Late Arrival", journal: "Journal A", eventType: "rejected", timestamp: "2026-08-01T00:00:00Z", source: { messageId: "a1" } }));
check("a replayed message is filed once", m2.timeline.length === before);

// The same notice arriving twice from two mailboxes, with different ids.
const reg3 = { manuscripts: [] };
applyEvent(reg3, ev({ title: "Forwarded Twice", journal: "Journal B", eventType: "new_submission", timestamp: "2026-08-24T09:00:00Z", source: { messageId: "gmail-1" } }));
applyEvent(reg3, ev({ title: "Forwarded Twice", journal: "Journal B", eventType: "new_submission", timestamp: "2026-08-24T09:04:00Z", source: { messageId: "outlook-1" } }));
const m3 = reg3.manuscripts[0];
check("the same notice from two mailboxes is filed once", m3.timeline.length === 1);

// A different outcome on the same day is still a real, separate event.
applyEvent(reg3, ev({ title: "Forwarded Twice", journal: "Journal B", eventType: "rejected", timestamp: "2026-08-24T18:00:00Z", source: { messageId: "gmail-2" } }));
check("a different outcome the same day still files", m3.timeline.length === 2 && m3.currentStatus === "Rejected");

// Two different papers at one journal on one day are not a duplicate. Real
// data had exactly this: World Journal of Orthopedics 116723 and 119301.
const reg4 = { manuscripts: [] };
applyEvent(reg4, ev({ title: "Two Papers One Day", journal: "World Journal of Orthopedics", manuscriptNumber: "116723", eventType: "new_submission", timestamp: "2026-04-28T03:22:00Z", source: { messageId: "w1" } }));
applyEvent(reg4, ev({ title: "Two Papers One Day", journal: "World Journal of Orthopedics", manuscriptNumber: "119301", eventType: "new_submission", timestamp: "2026-04-28T08:42:00Z", source: { messageId: "w2" } }));
check("distinct manuscript numbers are not merged", reg4.manuscripts[0].timeline.length === 2);

// A duplicate often carries the DOI; dropping it would lose a fact.
const reg5 = { manuscripts: [] };
applyEvent(reg5, ev({ title: "DOI On The Second Copy", journal: "Journal C", eventType: "accepted", timestamp: "2026-08-18T09:30:00Z", source: { messageId: "d1" } }));
applyEvent(reg5, ev({ title: "DOI On The Second Copy", journal: "Journal C", eventType: "accepted", timestamp: "2026-08-18T09:50:00Z", doi: "10.1000/xyz", source: { messageId: "d2" } }));
const m5 = reg5.manuscripts[0];
check("a merged duplicate still yields its DOI", m5.timeline.length === 1 && m5.doi === "10.1000/xyz");

// ---- Hand edits -------------------------------------------------------
// The whole point of an override is that automation cannot undo it. Each of
// these fails loudly if a later email reverts a person's correction.

const reg6 = { manuscripts: [] };
applyEvent(reg6, ev({ title: "Pinned Paper", journal: "Journal D", eventType: "new_submission", timestamp: "2026-08-01T00:00:00Z", source: { messageId: "p1" } }));
const m6 = reg6.manuscripts[0];

applyEdit(m6, { bucket: "in_review" });
check("an edit moves the card", m6.bucket === "in_review");
check("and records the previous value", m6.edits[0].changes[0].from === "submissions");

// The event that would have moved it back.
applyEvent(reg6, ev({ title: "Pinned Paper", journal: "Journal D", eventType: "rejected", timestamp: "2026-08-05T00:00:00Z", source: { messageId: "p2" } }));
check("a later email does not move a pinned card", m6.bucket === "in_review");
check("but the event still reaches the timeline", m6.timeline.length === 2);

applyEdit(m6, { title: "A Properly Corrected Title" });
applyEvent(reg6, ev({ title: "A Much Longer Automatically Extracted Title That Would Otherwise Win", journal: "Journal D", eventType: "under_review", timestamp: "2026-08-09T00:00:00Z", source: { messageId: "p3" } }));
check("a longer extracted title cannot overwrite a corrected one", m6.title === "A Properly Corrected Title");
check("a renamed manuscript stays findable", m6.titleNormalized === "a properly corrected title");

// Releasing hands the field back rather than trapping it forever.
applyEdit(m6, { bucket: null });
check("releasing a field unpins it", !isPinned(m6, "bucket"));
applyEvent(reg6, ev({ title: "Pinned Paper", journal: "Journal D", eventType: "rejected", timestamp: "2026-08-12T00:00:00Z", source: { messageId: "p4" } }));
check("and automation resumes control", m6.bucket === "needs_action");

// Journal and status pin independently of one another.
const reg7 = { manuscripts: [] };
applyEvent(reg7, ev({ title: "Split Pins", journal: "Journal E", eventType: "new_submission", timestamp: "2026-08-01T00:00:00Z", source: { messageId: "s1" } }));
const m7 = reg7.manuscripts[0];
applyEdit(m7, { currentJournal: "Corrected Journal Name" });
applyEvent(reg7, ev({ title: "Split Pins", journal: "Journal E", eventType: "accepted", timestamp: "2026-08-06T00:00:00Z", source: { messageId: "s2" } }));
check("a pinned journal survives", m7.currentJournal === "Corrected Journal Name");
check("an unpinned status still updates", m7.currentStatus === "Accepted (awaiting publication)");

// Renaming used to split a manuscript in two: the journal keeps sending the
// title it was given, which then matched nothing.
const reg8 = { manuscripts: [] };
applyEvent(reg8, ev({ title: "Original Journal Wording", journal: "Journal F", eventType: "new_submission", timestamp: "2026-08-01T00:00:00Z", source: { messageId: "r1" } }));
applyEdit(reg8.manuscripts[0], { title: "A Completely Different Corrected Title" });
applyEvent(reg8, ev({ title: "Original Journal Wording", journal: "Journal F", eventType: "rejected", timestamp: "2026-08-12T00:00:00Z", source: { messageId: "r2" } }));
check("a rename does not split the manuscript", reg8.manuscripts.length === 1);
check("and later email still lands on it", reg8.manuscripts[0].timeline.length === 2);

let rejected = false;
try { applyEdit(m7, { bucket: "in_review", somethingElse: "x" }); } catch { rejected = true; }
check("an unknown field is refused", rejected);

// A journal name the publisher styles in lower case. The name matcher demands
// an initial capital -- that is what stops an ordinary sentence word being read
// as a journal -- so Nature Portfolio's entire npj family failed it silently,
// and an amendment notice from npj Digital Medicine sat unfiled for months.
const { journalFromSubject } = await import("./backfill/extract.mjs");
check(
  "a lower-case publisher style is still read as a journal",
  journalFromSubject("Re: npj Digital Medicine-Amendment required") === "npj Digital Medicine"
);
check(
  "and so is a longer one",
  journalFromSubject("Re: npj Systems Biology and Applications-Amendment required") ===
    "npj Systems Biology and Applications"
);
check(
  "an ordinary capitalised name is unaffected",
  journalFromSubject("Re: European Spine Journal-Amendment required") === "European Spine Journal"
);
check(
  "and a person is still not a journal",
  journalFromSubject("Dear Dr Muthu-Amendment required") === null
);

// --- provider failures: which ones are the email's fault --------------------
//
// The distinction that stranded 28 messages. A run that hits 429s and a 503
// has hit nothing but temporary walls; counting that as a strike against the
// email retires perfectly classifiable mail into the review queue after three
// bad afternoons.
const { completeWithChain, buildProviderChain } = await import("./lib/providers.mjs");

const failing = (id, props) => ({
  id, model: id,
  async complete() { throw Object.assign(new Error(`${id} failed`), props); },
});

const chainError = async (providers) => {
  try {
    await completeWithChain(providers, { system: "s", user: "u", attemptsPerProvider: 1 });
    return null;
  } catch (err) {
    return err;
  }
};

{
  // Quota spent on one provider, busy model on the other: defer, do not blame.
  const err = await chainError([
    failing("groq", { retryable: true, rateLimited: true, status: 429 }),
    failing("gemini", { retryable: true, rateLimited: false, status: 503 }),
  ]);
  check("a 429 mixed with a 503 is still deferred without penalty", err?.deferrable === true);
  check("and it is not misreported as purely rate limited", err?.rateLimited === false);
}

{
  const err = await chainError([
    failing("groq", { retryable: true, rateLimited: true, status: 429 }),
    failing("gemini", { retryable: true, rateLimited: true, status: 429 }),
  ]);
  check("every provider rate limited still defers", err?.deferrable === true);
  check("and is reported as rate limited", err?.rateLimited === true);
}

{
  // The real case, from a live run: an account with no Cerebras quota answers
  // 402 on every message. 402 is neither 429 nor 5xx, so the earlier fix --
  // which keyed on `retryable` -- let it count as a strike against the email.
  // Billing status is a fact about the account, never about the message.
  const err = await chainError([
    failing("cerebras", { retryable: false, rateLimited: false, deferrable: true, status: 402 }),
    failing("groq", { retryable: true, rateLimited: true, deferrable: true, status: 429 }),
  ]);
  check("a payment-required provider does not blame the email", err?.deferrable === true);
}

{
  // A malformed answer IS about this email. It must spend an attempt, or a
  // genuinely unclassifiable message would be retried forever.
  const err = await chainError([
    failing("groq", { retryable: true, rateLimited: true, status: 429 }),
    failing("gemini", { retryable: false, rateLimited: false, status: 400 }),
  ]);
  check("a real failure among them is not deferred", err?.deferrable === false);
}

// --- the output budget escalates rather than returning truncated JSON -------
{
  const realFetch = globalThis.fetch;
  const reserved = [];
  globalThis.fetch = async (url, options = {}) => {
    const body = JSON.parse(options.body);
    reserved.push(body.max_completion_tokens);
    // Answer the first (small) request with a cutoff, the second with content.
    const truncated = reserved.length === 1;
    return new Response(JSON.stringify({
      choices: [{
        finish_reason: truncated ? "length" : "stop",
        message: { content: JSON.stringify({ relevant: false }) },
      }],
    }), { status: 200, headers: { "content-type": "application/json" } });
  };
  try {
    const chain = buildProviderChain({ GROQ_API_KEY: "test-key" });
    const groq = chain.find((p) => p.id === "groq");
    check("a groq provider is built from a key alone", Boolean(groq));
    if (groq) {
      await groq.complete({ system: "s", user: "u" });
      check("the first request reserves the small budget", reserved[0] === 1024);
      check("a cutoff escalates rather than failing", reserved[1] === 4096);
      check("and it escalates only once", reserved.length === 2);
    }
  } finally {
    globalThis.fetch = realFetch;
  }
}

// --- the second opinion, and what happens without it ------------------------
//
// Off must not mean credulous. The model's own doubt has to reach a human
// instead of another model, or switching this off to save quota would quietly
// start filing shaky answers as though they were certain.
{
  const { classifyEmail } = await import("./lib/classify.mjs");
  const realFetch = globalThis.fetch;
  let calls = 0;

  const answerWith = (confidence) => async () => {
    calls++;
    return new Response(JSON.stringify({
      choices: [{
        finish_reason: "stop",
        message: { content: JSON.stringify({
          relevant: true, event_type: "sent_back", confidence,
          title: "A Paper", journal: "A Journal",
        }) },
      }],
    }), { status: 200, headers: { "content-type": "application/json" } });
  };

  const email = { subject: "s", from: "f", date: "d", text: "t" };
  const prevVerify = process.env.CLASSIFY_VERIFY;
  const prevKeys = [process.env.GROQ_API_KEY, process.env.CEREBRAS_API_KEY, process.env.GEMINI_API_KEY];
  process.env.GROQ_API_KEY = "k1";
  process.env.CEREBRAS_API_KEY = "k2";
  delete process.env.GEMINI_API_KEY;

  try {
    // Off: one call only, and a low-confidence answer is flagged.
    delete process.env.CLASSIFY_VERIFY;
    globalThis.fetch = answerWith("low");
    calls = 0;
    let out = await classifyEmail(email);
    check("with verification off only one model is called", calls === 1);
    check("and a low-confidence answer is flagged for a human", out.needsReview === true);
    check("with a reason that says why it was unverified", /switched off/i.test(out.reviewReason || ""));

    // Off, but the model was certain: trusted, not flagged.
    globalThis.fetch = answerWith("high");
    calls = 0;
    out = await classifyEmail(email);
    check("a high-confidence answer is trusted without a second call", calls === 1 && out.needsReview === false);

    // On: the second model is actually consulted again.
    process.env.CLASSIFY_VERIFY = "1";
    globalThis.fetch = answerWith("high");
    calls = 0;
    out = await classifyEmail(email);
    check("CLASSIFY_VERIFY=1 restores the second opinion", calls === 2);
  } finally {
    globalThis.fetch = realFetch;
    if (prevVerify === undefined) delete process.env.CLASSIFY_VERIFY; else process.env.CLASSIFY_VERIFY = prevVerify;
    [["GROQ_API_KEY", prevKeys[0]], ["CEREBRAS_API_KEY", prevKeys[1]], ["GEMINI_API_KEY", prevKeys[2]]]
      .forEach(([k, v]) => { if (v === undefined) delete process.env[k]; else process.env[k] = v; });
  }
}

// A provider named in the allowlist but never keyed is dropped silently by the
// filter. Silence is how the Outlook mailbox went unread for seven months.
{
  const warnings = [];
  const realWarn = console.warn;
  console.warn = (msg) => warnings.push(String(msg));
  try {
    buildProviderChain({ GROQ_API_KEY: "k", CLASSIFIER_PROVIDERS: "cerebras,groq" });
  } finally {
    console.warn = realWarn;
  }
  check("an allowlisted provider with no key is named out loud", warnings.some((w) => /cerebras/.test(w)));
}

// The same thing through the real HTTP path, not a hand-made error object:
// the status-to-flags mapping is where the bug actually lived.
{
  const realFetch = globalThis.fetch;
  const statusOf = async (status, body) => {
    globalThis.fetch = async () =>
      new Response(body, { status, headers: { "content-type": "application/json" } });
    try {
      const chain = buildProviderChain({ GROQ_API_KEY: "k", CLASSIFIER_PROVIDERS: "groq" });
      await completeWithChain(chain, { system: "s", user: "u", attemptsPerProvider: 1 });
      return null;
    } catch (err) {
      return err;
    } finally {
      globalThis.fetch = realFetch;
    }
  };

  const paid = await statusOf(402, '{"message":"Payment required"}');
  check("402 from the wire is deferrable", paid?.deferrable === true);
  check("but not worth retrying", /402/.test(paid?.message || ""));

  const authed = await statusOf(401, '{"message":"bad key"}');
  check("401 from the wire is deferrable too", authed?.deferrable === true);

  const bad = await statusOf(400, '{"message":"malformed request"}');
  check("400 stays the email's problem", bad?.deferrable === false);
}

// --- the sync window must not walk backwards ---------------------------------
//
// The rule the sync applies, extracted so it can be exercised without Gmail:
// the overlap is a safety margin on a window that FINISHED. Applied to a
// window being held open because work remains, it compounds -- each run
// subtracts another two days from a point already rewound, and the mailbox
// slides into the past. One did: 8 August to 5 August in a day, three times
// faster once the schedule went hourly.
const OVERLAP_DAYS = 2, DAY = 86400000;
const sinceFor = (state) =>
  new Date(new Date(state.lastSyncedAt).getTime() - (state.holding ? 0 : OVERLAP_DAYS * DAY));

{
  // A finished window still gets its overlap: that is what catches an email
  // that landed at the boundary while the last run was mid-flight.
  const clean = { lastSyncedAt: "2026-08-20T00:00:00.000Z", holding: false };
  const back = (new Date(clean.lastSyncedAt) - sinceFor(clean)) / DAY;
  check("a completed window still re-scans the overlap", back === OVERLAP_DAYS);
}

{
  const held = { lastSyncedAt: "2026-08-20T00:00:00.000Z", holding: true };
  check(
    "a held window is not rewound again",
    sinceFor(held).toISOString() === held.lastSyncedAt
  );
}

{
  // The regression itself: hold the window ten runs in a row, each time at the
  // oldest thing still outstanding, and the start must not creep backwards.
  let state = { lastSyncedAt: "2026-08-20T00:00:00.000Z", holding: true };
  const first = sinceFor(state).getTime();
  for (let run = 0; run < 10; run++) {
    const since = sinceFor(state);
    // Worst case: the oldest undecided message sits right at the window start.
    state = { lastSyncedAt: since.toISOString(), holding: true };
  }
  check("ten held runs do not walk the window into the past", sinceFor(state).getTime() === first);
}

{
  // And the same loop under the old rule, to show the check has teeth.
  const oldRule = (st) => new Date(new Date(st.lastSyncedAt).getTime() - OVERLAP_DAYS * DAY);
  let st = { lastSyncedAt: "2026-08-20T00:00:00.000Z" };
  for (let run = 0; run < 10; run++) st = { lastSyncedAt: oldRule(st).toISOString() };
  const drift = (Date.parse("2026-08-20T00:00:00.000Z") - Date.parse(st.lastSyncedAt)) / DAY;
  check("the old rule really did drift, 2 days per run", drift === 20);
}

// --- revisions get their own section -----------------------------------------
//
// "In review" means the journal is working on it. A revision request means YOU
// are, and the two sat in one pile -- so a paper waiting on your revision read
// as a paper you could forget about.
{
  const reg = { manuscripts: [] };
  applyEvent(reg, ev({ title: "Needs A Revision", journal: "Journal R", eventType: "new_submission", timestamp: "2026-08-01T00:00:00Z", source: { messageId: "rv1" } }));
  applyEvent(reg, ev({ title: "Needs A Revision", journal: "Journal R", eventType: "revision_requested", timestamp: "2026-08-10T00:00:00Z", source: { messageId: "rv2" } }));
  check("a revision request lands in its own section", reg.manuscripts[0].bucket === "revisions_pending");

  // And the states around it must not have moved with it.
  const under = { manuscripts: [] };
  applyEvent(under, ev({ title: "Just Under Review", journal: "Journal S", eventType: "under_review", timestamp: "2026-08-10T00:00:00Z", source: { messageId: "ur1" } }));
  check("under review is still in review", under.manuscripts[0].bucket === "in_review");

  const acc = { manuscripts: [] };
  applyEvent(acc, ev({ title: "Accepted Paper", journal: "Journal T", eventType: "accepted", timestamp: "2026-08-10T00:00:00Z", source: { messageId: "ac1" } }));
  check("accepted is still in review", acc.manuscripts[0].bucket === "in_review");

  const back = { manuscripts: [] };
  applyEvent(back, ev({ title: "Sent Back Paper", journal: "Journal U", eventType: "sent_back", timestamp: "2026-08-10T00:00:00Z", source: { messageId: "sb1" } }));
  check("sent back is still needs action", back.manuscripts[0].bucket === "needs_action");

  // Moving on clears it again, so a finished revision does not linger.
  applyEvent(reg, ev({ title: "Needs A Revision", journal: "Journal R", eventType: "under_review", timestamp: "2026-08-20T00:00:00Z", source: { messageId: "rv3" } }));
  check("and it leaves the section once the journal takes it back", reg.manuscripts[0].bucket === "in_review");
}

console.log(failures ? `\n${failures} registry check(s) failed.` : "\nAll registry checks passed.");
process.exit(failures ? 1 : 0);
