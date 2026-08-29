import { readFile } from "node:fs/promises";
const d = JSON.parse(await readFile(process.argv[2], "utf-8"));
const by = new Map(d.candidates.map((c) => [c.id, c]));
const P = [/entitled[,:]?\s*["“]([^"“”\n]{15,300})["”]/i, /manuscript[,:]?\s+["“]([^"“”\n]{15,300})["”]/i, /Title:\s*([^\n]{15,300})/i, /titled\s*["“]([^"“”\n]{15,300})["”]/i, /Decision on\s+(.{15,200})$/i];
for (const id of process.argv.slice(3)) {
  const c = by.get(id);
  const t = (c.text || "").replace(/<[^>]{0,80}>/g, "").replace(/\s+/g, " ");
  let title = null;
  for (const p of P) { const m = p.exec(t) || p.exec(c.subject || ""); if (m) { title = m[1].trim(); break; } }
  console.log(`${id} | ${(c.subject||"").slice(0,52)}\n    -> ${title || "(no title found)"}`);
}
