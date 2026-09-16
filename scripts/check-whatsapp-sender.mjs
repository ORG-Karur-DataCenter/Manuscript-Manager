#!/usr/bin/env node
/**
 * Says which WhatsApp number the app would actually send FROM.
 *
 * WHY THIS EXISTS. Meta's allow list belongs to a phone number, not to an
 * account. Two test numbers therefore have two separate lists, and a recipient
 * verified on one is a stranger to the other -- which surfaces as
 * "(#131030) Recipient phone number not in allowed list" for a number you can
 * see sitting in the picker on your screen.
 *
 * That happened here: one recipient delivered and the other was refused in the
 * same run, while Meta's own Send message button on the API Setup page
 * delivered to both. The only thing the two paths do not share is which phone
 * number sends -- the page sends from the one it is showing, and the app sends
 * from META_WHATSAPP_PHONE_ID, which nothing on either screen displays.
 *
 * So this resolves the id to the number it belongs to, and prints it next to
 * the id shown in the Meta console. Comparing two numbers by eye takes a
 * second; inferring a mismatch from a delivery failure took an evening.
 *
 * Prints the SENDING number, which is a business identity Meta publishes on
 * its own setup page -- never a recipient's number, since these logs are
 * public on a public repository.
 *
 *   node scripts/check-whatsapp-sender.mjs
 */
const token = (process.env.META_WHATSAPP_TOKEN || "").trim();
const phoneId = (process.env.META_WHATSAPP_PHONE_ID || "").trim();
const version = (process.env.META_API_VERSION || "v21.0").trim();

if (!token || !phoneId) {
  console.log("Meta is not configured here (META_WHATSAPP_TOKEN / META_WHATSAPP_PHONE_ID unset).");
  process.exit(0);
}

const url =
  `https://graph.facebook.com/${version}/${encodeURIComponent(phoneId)}` +
  `?fields=display_phone_number,verified_name,quality_rating`;

let res;
try {
  res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
} catch (err) {
  // Not fatal: this is a diagnostic, and failing it must never stop a send.
  console.log(`Could not reach Meta to identify the sender: ${err.message}`);
  process.exit(0);
}

const body = await res.text();

if (!res.ok) {
  let hint = "";
  if (/190|access token/i.test(body)) {
    hint = " — the token is rejected. A permanent system-user token does not expire, but it can be revoked.";
  } else if (res.status === 404 || /does not exist|unsupported get/i.test(body)) {
    hint =
      " — no phone number has this id, so META_WHATSAPP_PHONE_ID is wrong or belongs to " +
      "an app this token cannot see.";
  }
  console.log(`Meta would not identify the sender (HTTP ${res.status})${hint}`);
  console.log(`  ${body.slice(0, 200)}`);
  process.exit(0);
}

const data = JSON.parse(body);

/*
 * The display number is not an identity.
 *
 * Meta hands test numbers out of a shared pool, so +1 555-202-0133 is issued
 * to many apps at once, each with its own phone number id and its own allow
 * list. Seeing the same number on the console and in this log therefore proves
 * nothing -- it was read here as a match once, and the real mismatch survived
 * another round.
 *
 * The id would settle it, but GitHub masks it in the log for being a secret.
 * So ask the token which business accounts it can act on: those ids are not
 * secrets, they differ between apps, and the console prints one at the top of
 * the API Setup page to compare against.
 */
async function businessAccounts() {
  const url =
    `https://graph.facebook.com/${version}/debug_token` +
    `?input_token=${encodeURIComponent(token)}&access_token=${encodeURIComponent(token)}`;
  try {
    const res = await fetch(url);
    if (!res.ok) return null;
    const { data: info } = await res.json();
    const scopes = info?.granular_scopes || [];
    const ids = new Set();
    for (const g of scopes) for (const id of g.target_ids || []) ids.add(id);
    return { ids: [...ids], expires: info?.expires_at, app: info?.app_id };
  } catch {
    return null;
  }
}

console.log("Sending from:");
console.log(`  phone number id : ${phoneId}`);
console.log(`  which is        : ${data.display_phone_number || "(not reported)"}`);
console.log(`  named           : ${data.verified_name || "(not reported)"}`);
if (data.quality_rating) console.log(`  quality rating  : ${data.quality_rating}`);
console.log("");
const scoped = await businessAccounts();
if (scoped) {
  console.log("This token can act on WhatsApp Business account(s):");
  for (const id of scoped.ids) console.log(`  ${id}`);
  if (scoped.app) console.log(`  (app id ${scoped.app})`);
  console.log(
    scoped.expires === 0 || scoped.expires === undefined
      ? "  token does not expire"
      : `  token expires ${new Date(scoped.expires * 1000).toISOString()}`
  );
  console.log("");
}

console.log("Compare the account id above with the \"WhatsApp Business account ID\" shown");
console.log("on WhatsApp -> API Setup. If they differ, the app is sending from a DIFFERENT");
console.log("test number that merely displays the same pooled +1 555 number, with its own");
console.log("allow list -- which is why a recipient you can see in the console's picker is");
console.log("refused with \"(#131030) Recipient phone number not in allowed list\".");
