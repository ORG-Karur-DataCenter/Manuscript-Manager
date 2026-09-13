#!/usr/bin/env node
/**
 * Proves every subject rule against the mail the classifier has already read.
 *
 * A rule here skips a language-model call, so a wrong one files a paper wrongly
 * and silently, for ever. The guard is that the registry is a labelled corpus:
 * several hundred emails whose subject and event type are both recorded. A rule
 * may ship only if every email it matches was classified the same way.
 *
 * "Agrees with the classifier" is not the same as "correct" -- these labels
 * came from the model, and some of them will be wrong. What this catches is the
 * failure that matters: a subject that means two different things, which is a
 * rule that will certainly misfile. Ambiguity is measurable; truth is not.
 *
 * It also reports coverage, since the whole point is how much mail never
 * reaches a paid call.
 *
 *   node scripts/check-subject-rules.mjs
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { SUBJECT_RULES, classifyBySubject, bareSubject } from "./lib/subject-rules.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const registry = JSON.parse(fs.readFileSync(path.join(ROOT, "data/manuscripts.json"), "utf8"));

const corpus = registry.manuscripts.flatMap((m) =>
  (m.timeline || [])
    .filter((t) => t.source && t.source.subject && t.eventType)
    .map((t) => ({ subject: t.source.subject, eventType: t.eventType, title: m.title }))
);

let failures = 0;
const fail = (msg) => { failures++; console.log(`FAIL  ${msg}`); };

console.log(`Replaying ${SUBJECT_RULES.length} rules against ${corpus.length} classified emails.\n`);

// --- no rule may ever have meant two things ---------------------------------

const seen = new Set();
for (const rule of SUBJECT_RULES) {
  if (seen.has(rule.id)) fail(`two rules share the id "${rule.id}"`);
  seen.add(rule.id);

  const matched = corpus.filter((e) => rule.test.test(bareSubject(e.subject)));
  const labels = [...new Set(matched.map((e) => e.eventType))];

  if (!matched.length) {
    // Not a failure: a rule may be written for a journal that has not written
    // yet. It is untested, though, and saying so is the honest report.
    console.log(`  ·     ${rule.id.padEnd(30)} no examples yet — unverified`);
    continue;
  }

  if (labels.length > 1) {
    fail(
      `${rule.id} matches ${matched.length} emails meaning ${labels.length} different things: ` +
      labels.join(", ") + `\n      e.g. "${matched[0].subject.slice(0, 70)}"`
    );
    continue;
  }

  if (labels[0] !== rule.eventType) {
    fail(
      `${rule.id} says "${rule.eventType}" but all ${matched.length} matching emails ` +
      `were classified "${labels[0]}"\n      e.g. "${matched[0].subject.slice(0, 70)}"`
    );
    continue;
  }

  console.log(`  PASS  ${rule.id.padEnd(30)} ${String(matched.length).padStart(3)} emails, all "${labels[0]}"`);
}

// --- the rules must agree with the whole corpus, not just their own matches --

let decided = 0;
let disagreed = 0;
for (const e of corpus) {
  const answer = classifyBySubject(e.subject);
  if (!answer) continue;
  decided++;
  if (answer.eventType !== e.eventType) {
    disagreed++;
    fail(
      `"${bareSubject(e.subject).slice(0, 64)}"\n      rule ${answer.rule} says ` +
      `${answer.eventType}, the classifier said ${e.eventType}`
    );
  }
}

// --- a decision email must never be answered here ---------------------------
//
// The outcome of a decision lives in the body. Any rule that starts answering
// them is reaching past what a subject line can know, however pure it looks.

const decisions = corpus.filter((e) => /\bdecision\b/i.test(bareSubject(e.subject)));
const decided_decisions = decisions.filter((e) => classifyBySubject(e.subject));
if (decided_decisions.length) {
  fail(
    `${decided_decisions.length} decision email(s) were answered without reading the body, ` +
    `e.g. "${decided_decisions[0].subject.slice(0, 64)}"`
  );
} else {
  console.log(`\n  PASS  all ${decisions.length} "decision" emails left to the classifier`);
}

// --- what this saves --------------------------------------------------------

const pct = corpus.length ? Math.round((decided / corpus.length) * 100) : 0;
console.log(
  `\nCoverage: ${decided} of ${corpus.length} emails (${pct}%) answered without a model call, ` +
  `${disagreed} disagreement(s).`
);

const byType = {};
for (const e of corpus) {
  const a = classifyBySubject(e.subject);
  if (a) byType[a.eventType] = (byType[a.eventType] || 0) + 1;
}
console.log("By event type:", JSON.stringify(byType));

console.log(failures ? `\n${failures} subject-rule check(s) failed.` : "\nAll subject-rule checks passed.");
process.exit(failures ? 1 : 0);
