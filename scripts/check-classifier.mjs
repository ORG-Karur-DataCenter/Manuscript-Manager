/**
 * Proves the free classifier works end to end against whichever provider keys
 * are configured, without needing Gmail access. Run: npm run check-classifier
 *
 * Each fixture is a realistic journal email with a known correct answer, so the
 * output shows not just "the API responded" but "it got the hard ones right".
 */
import { buildProviderChain } from "./lib/providers.mjs";
import { classifyEmail } from "./lib/classify.mjs";

const FIXTURES = [
  {
    name: "decision on the author's own manuscript",
    expect: { relevant: true, event_type: "rejected" },
    email: {
      subject: "Decision on JCM-D-26-01144",
      from: "Journal of Clinical Medicine <em@editorialmanager.com>",
      date: "Mon, 18 Aug 2026 09:14:00 +0000",
      text: `Dear Dr Muthu,

Thank you for submitting your manuscript "Vitamin D Supplementation and Fracture Risk in Postmenopausal Women: A Systematic Review and Meta-Analysis" (JCM-D-26-01144) to the Journal of Clinical Medicine.

Your manuscript has now been assessed by two reviewers. I regret to inform you that we are unable to accept it for publication. The reviewers raised concerns about heterogeneity between the included trials that cannot be resolved by revision.

We hope you will consider submitting future work to this journal.

Yours sincerely,
Prof. A. Editor, Editor-in-Chief`,
    },
  },
  {
    name: "reviewer invitation for SOMEONE ELSE's manuscript (the hard one)",
    expect: { relevant: false, exclude_reason: "peer_review_invitation_for_other_manuscript" },
    email: {
      subject: "Review Invitation - Manuscript BMC-2026-8871",
      from: "BMC Musculoskeletal Disorders <editorial@biomedcentral.com>",
      date: "Tue, 19 Aug 2026 11:02:00 +0000",
      text: `Dear Dr Muthu,

Manuscript BMC-2026-8871 entitled "Tranexamic Acid in Total Knee Arthroplasty: A Randomised Controlled Trial" has been submitted to BMC Musculoskeletal Disorders.

Given your expertise in this area, I am writing to ask whether you would be willing to review this manuscript.

Abstract: We randomised 240 patients undergoing primary total knee arthroplasty to intravenous tranexamic acid or placebo. The primary outcome was total blood loss at 48 hours...

If you are able to review, please respond within 5 days. Reviews are due 21 days after acceptance of this invitation.`,
    },
  },
  {
    name: "predatory solicitation",
    expect: { relevant: false, exclude_reason: "predatory_solicitation" },
    email: {
      subject: "Invitation for Article Submission - Impact Factor 7.2",
      from: "Int. Journal of Advanced Medical Research <submissions@ijamr-online.com>",
      date: "Wed, 20 Aug 2026 03:41:00 +0000",
      text: `Dear Dr. Muthu,

Greetings for the day!!

We are highly impressed by your esteemed contribution in the field of orthopaedics. It is our immense pleasure to invite you to submit your valuable manuscript for our forthcoming issue.

We accept all article types. Rapid peer review within 48 hours. Nominal article processing charges of 599 USD apply after acceptance.

Awaiting your positive response.`,
    },
  },
];

function tick(ok) {
  return ok ? "PASS" : "FAIL";
}

const chain = buildProviderChain();
console.log(
  `Provider chain: ${chain.length ? chain.map((p) => `${p.id} (${p.model})`).join(" -> ") : "(none configured)"}\n`
);
if (!chain.length) {
  console.error("No provider keys set — set GEMINI_API_KEY, CEREBRAS_API_KEY or GROQ_API_KEY.");
  process.exit(1);
}

// Diagnostic mode: print the model ids each key can actually reach, then stop.
if (process.env.LIST_MODELS) {
  for (const provider of chain) {
    try {
      const models = await provider.listModels();
      console.log(`${provider.id} — ${models.length} model(s) reachable:`);
      for (const m of models) console.log(`    ${m}`);
    } catch (err) {
      console.log(`${provider.id} — could not list models: ${err.message}`);
    }
    console.log();
  }
  process.exit(0);
}

let failures = 0;
for (const fixture of FIXTURES) {
  console.log(`--- ${fixture.name}`);
  try {
    const r = await classifyEmail(fixture.email);
    const checks = Object.entries(fixture.expect).map(([k, v]) => [k, r[k], r[k] === v]);
    const passed = checks.every(([, , ok]) => ok);
    if (!passed) failures++;

    for (const [key, got, ok] of checks) {
      console.log(`    ${tick(ok)}  ${key}: ${got}`);
    }
    console.log(`    answered by : ${r.meta.primaryProvider} (confidence: ${r.meta.primaryConfidence})`);
    console.log(`    cross-check : ${r.meta.verifiedBy || "not needed"} -> ${r.meta.agreement || "n/a"}`);
    if (r.needsReview) console.log(`    NEEDS REVIEW: ${r.reviewReason}`);
    if (r.title) console.log(`    title       : ${r.title}`);
    if (r.journal) console.log(`    journal     : ${r.journal}`);
  } catch (err) {
    failures++;
    console.log(`    FAIL  threw: ${err.message}`);
  }
  console.log();
}

console.log(
  failures
    ? `${failures} of ${FIXTURES.length} fixtures did not classify as expected.`
    : `All ${FIXTURES.length} fixtures classified correctly.`
);
process.exit(failures ? 1 : 0);
