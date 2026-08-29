import { readFile } from "node:fs/promises";
const d = JSON.parse(await readFile(process.argv[2], "utf-8"));
const by = new Map(d.candidates.map((c) => [c.id, c]));
const V = /(regret to inform|cannot be accepted|has been rejected|not be considered|decline to publish|unable to accept|is a pleasure to accept|pleased to (?:inform|accept)|accepted for publication|has been accepted|requires? (?:a )?revision|major revision|minor revision|revise and resubmit|invite you to (?:submit a )?revis|resubmit|reconsider|has been reviewed|transfer|withdraw|reject)/gi;
for (const id of process.argv.slice(3)) {
  const c = by.get(id);
  if (!c) { console.log(id, "not found"); continue; }
  const t = (c.text || "").replace(/\s+/g, " ");
  const hits = [...new Set((t.match(V) || []).map((x) => x.toLowerCase()))];
  console.log(`[${id}] ${(c.subject||"").slice(0,64)}`);
  console.log(`   verdicts: ${hits.join(" | ") || "(none)"}`);
}
