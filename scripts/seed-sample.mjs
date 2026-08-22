/**
 * Generates data/manuscripts.sample.json from synthetic events using the real
 * registry logic. For local UI testing only — not used in production sync.
 *   node scripts/seed-sample.mjs
 * Then temporarily point the dashboard at the sample file, or copy it over
 * data/manuscripts.json to preview.
 */
import { writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { applyEvent } from "./lib/registry.mjs";

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

const db = { generatedAt: null, manuscripts: [] };
const day = (n) => new Date(Date.now() - n * 86400000).toISOString();

const events = [
  // 1. Resubmission chain: rejected at journal A, transferred/resubmitted to B, now under review
  { title: "Mesenchymal Stem Cell Therapy for Knee Osteoarthritis: A Randomized Controlled Trial", journal: "The Journal of Bone & Joint Surgery", manuscriptNumber: "JBJS-24-01123", eventType: "new_submission", summary: "Submission received and assigned a manuscript number.", timestamp: day(96), authorAccount: "Sathish Muthu" },
  { title: "Mesenchymal Stem Cell Therapy for Knee Osteoarthritis: A Randomized Controlled Trial", journal: "The Journal of Bone & Joint Surgery", manuscriptNumber: "JBJS-24-01123", eventType: "under_review", summary: "Manuscript sent out for peer review.", timestamp: day(80), authorAccount: "Sathish Muthu" },
  { title: "Mesenchymal Stem Cell Therapy for Knee Osteoarthritis: A Randomized Controlled Trial", journal: "The Journal of Bone & Joint Surgery", manuscriptNumber: "JBJS-24-01123", eventType: "rejected", summary: "Declined after review; reviewers suggested a more specialised venue.", timestamp: day(55), authorAccount: "Sathish Muthu" },
  { title: "Mesenchymal Stem Cell Therapy for Knee Osteoarthritis: A Randomized Controlled Trial", journal: "Cartilage", manuscriptNumber: "CART-2024-0456", eventType: "new_submission", summary: "Resubmitted to Cartilage; submission acknowledged.", timestamp: day(48), authorAccount: "Sathish Muthu" },
  { title: "Mesenchymal Stem Cell Therapy for Knee Osteoarthritis: A Randomized Controlled Trial", journal: "Cartilage", manuscriptNumber: "CART-2024-0456", eventType: "under_review", summary: "Under peer review at Cartilage.", timestamp: day(30), authorAccount: "Sathish Muthu" },

  // 2. Revision requested (needs action flag stays via actionFlag, bucket in_review)
  { title: "Machine Learning Prediction of Adjacent Segment Disease After Lumbar Fusion", journal: "European Spine Journal", manuscriptNumber: "ESJ-D-24-00789", eventType: "new_submission", summary: "Submission acknowledged.", timestamp: day(60), authorAccount: "Sathish Muthu" },
  { title: "Machine Learning Prediction of Adjacent Segment Disease After Lumbar Fusion", journal: "European Spine Journal", manuscriptNumber: "ESJ-D-24-00789", eventType: "under_review", summary: "Assigned to reviewers.", timestamp: day(42), authorAccount: "Sathish Muthu" },
  { title: "Machine Learning Prediction of Adjacent Segment Disease After Lumbar Fusion", journal: "European Spine Journal", manuscriptNumber: "ESJ-D-24-00789", eventType: "revision_requested", revisionRound: 1, summary: "Major revision requested; decision letter with reviewer comments attached.", timestamp: day(8), authorAccount: "Sathish Muthu" },

  // 3. Sent back before review (needs action)
  { title: "Platelet-Rich Plasma versus Corticosteroid for Lateral Epicondylitis: Meta-analysis", journal: "American Journal of Sports Medicine", manuscriptNumber: "AJSM-2024-2210", eventType: "new_submission", summary: "Submission received.", timestamp: day(14), authorAccount: "Dhibin Vikash Kolarpatti Ponnusamy" },
  { title: "Platelet-Rich Plasma versus Corticosteroid for Lateral Epicondylitis: Meta-analysis", journal: "American Journal of Sports Medicine", manuscriptNumber: "AJSM-2024-2210", eventType: "sent_back", summary: "Returned to author: figures below resolution and ICMJE forms missing before it can enter review.", timestamp: day(3), authorAccount: "Dhibin Vikash Kolarpatti Ponnusamy" },

  // 4. Freshly submitted
  { title: "Outcomes of Robotic-Assisted Total Knee Arthroplasty: A Systematic Review", journal: "Journal of Arthroplasty", manuscriptNumber: "JOA-D-24-01555", eventType: "new_submission", summary: "Submission acknowledged and under editorial screening.", timestamp: day(2), authorAccount: "Sathish Muthu" },

  // 5. Accepted, awaiting publication
  { title: "Vertebral Bone Quality Score as a Predictor of Screw Loosening", journal: "Spine", manuscriptNumber: "SPINE-D-23-09912", eventType: "new_submission", summary: "Submitted.", timestamp: day(150), authorAccount: "Sathish Muthu" },
  { title: "Vertebral Bone Quality Score as a Predictor of Screw Loosening", journal: "Spine", manuscriptNumber: "SPINE-D-23-09912", eventType: "revision_requested", revisionRound: 1, summary: "Minor revision.", timestamp: day(110), authorAccount: "Sathish Muthu" },
  { title: "Vertebral Bone Quality Score as a Predictor of Screw Loosening", journal: "Spine", manuscriptNumber: "SPINE-D-23-09912", eventType: "accepted", summary: "Accepted for publication.", timestamp: day(20), authorAccount: "Sathish Muthu" },

  // 6. Published with DOI
  { title: "Global Burden of Low Back Pain 1990-2021: A Systematic Analysis", journal: "The Lancet Rheumatology", manuscriptNumber: "THELANCETRHEU-D-23-00420", eventType: "new_submission", summary: "Submitted.", timestamp: day(220), authorAccount: "Sathish Muthu" },
  { title: "Global Burden of Low Back Pain 1990-2021: A Systematic Analysis", journal: "The Lancet Rheumatology", manuscriptNumber: "THELANCETRHEU-D-23-00420", eventType: "under_review", summary: "Under review.", timestamp: day(190), authorAccount: "Sathish Muthu" },
  { title: "Global Burden of Low Back Pain 1990-2021: A Systematic Analysis", journal: "The Lancet Rheumatology", manuscriptNumber: "THELANCETRHEU-D-23-00420", eventType: "accepted", summary: "Accepted.", timestamp: day(60), authorAccount: "Sathish Muthu" },
  { title: "Global Burden of Low Back Pain 1990-2021: A Systematic Analysis", journal: "The Lancet Rheumatology", manuscriptNumber: "THELANCETRHEU-D-23-00420", eventType: "published", doi: "10.1016/S2665-9913(24)00123-4", publicationLink: "https://www.thelancet.com/journals/lanrhe/article/PIIS2665-9913(24)00123-4/fulltext", summary: "Published online.", timestamp: day(35), authorAccount: "Sathish Muthu" },
];

for (const e of events) applyEvent(db, e);

db.generatedAt = new Date().toISOString();
db.manuscripts.sort((a, b) => new Date(b.updatedAt) - new Date(a.updatedAt));

await writeFile(
  path.join(ROOT, "data/manuscripts.sample.json"),
  JSON.stringify(db, null, 2) + "\n"
);
console.log(`Wrote ${db.manuscripts.length} sample manuscripts to data/manuscripts.sample.json`);
