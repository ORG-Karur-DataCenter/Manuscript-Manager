// Show a short, decision-bearing excerpt for specific message ids.
import { readFile } from "node:fs/promises";

const data = JSON.parse(await readFile(process.argv[2], "utf-8"));
const chars = Number(process.env.CHARS || 380);
const ids = process.argv.slice(3);
const byId = new Map(data.candidates.map((c) => [c.id, c]));

for (const id of ids) {
  const c = byId.get(id);
  if (!c) { console.log(`${id}: not found\n`); continue; }
  const body = (c.text || "").replace(/\s+/g, " ").trim();
  console.log(`[${id}] ${c.internalDate.slice(0, 10)} ${(c.subject || "").slice(0, 76)}`);
  console.log(`  ${body.slice(0, chars)}`);
  console.log();
}
