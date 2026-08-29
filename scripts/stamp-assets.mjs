#!/usr/bin/env node
/**
 * Stamps assets/style.css and assets/app.js with a content hash in index.html.
 *
 * WHY. The dashboard is a static site on GitHub Pages with no build step, so a
 * changed stylesheet reaches a phone only when that phone's browser decides to
 * re-fetch it. A CSS fix therefore looked deployed, and wasn't -- the fix was
 * live and the browser was still painting the old rules.
 *
 * A hand-bumped version number solves that exactly until the first time
 * somebody forgets, which is worse than no versioning at all: the URL looks
 * deliberate and is stale. So the stamp is derived from the file's own
 * contents, and check-registry fails when index.html disagrees with the files
 * on disk. Forgetting is then a failed test rather than a silent non-deploy.
 *
 *   node scripts/stamp-assets.mjs           # rewrite index.html
 *   node scripts/stamp-assets.mjs --check   # exit 1 if it is out of date
 */
import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PAGE = path.join(ROOT, "index.html");

const ASSETS = [
  { file: "assets/style.css", attr: "href" },
  { file: "assets/app.js", attr: "src" },
];

const hashOf = async (rel) =>
  crypto.createHash("sha1").update(await fs.readFile(path.join(ROOT, rel))).digest("hex").slice(0, 8);

export async function stamp(html) {
  let out = html;
  for (const { file, attr } of ASSETS) {
    const v = await hashOf(file);
    const pattern = new RegExp(`${attr}="${file.replace(/[.]/g, "\\.")}(?:\\?v=[0-9a-f]+)?"`, "g");
    out = out.replace(pattern, `${attr}="${file}?v=${v}"`);
  }
  return out;
}

const html = await fs.readFile(PAGE, "utf8");
const stamped = await stamp(html);

if (process.argv.includes("--check")) {
  if (stamped === html) {
    console.log("· asset stamps are current");
    process.exit(0);
  }
  console.error(
    "index.html asset stamps are stale — assets/style.css or assets/app.js changed\n" +
    "without index.html being restamped, so browsers will keep serving the old file.\n" +
    "Fix with: npm run stamp"
  );
  process.exit(1);
}

if (stamped === html) {
  console.log("· already current");
} else {
  await fs.writeFile(PAGE, stamped);
  console.log("· index.html restamped");
}
