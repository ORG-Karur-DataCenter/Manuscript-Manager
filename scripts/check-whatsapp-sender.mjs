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
console.log("Sending from:");
console.log(`  phone number id : ${phoneId}`);
console.log(`  which is        : ${data.display_phone_number || "(not reported)"}`);
console.log(`  named           : ${data.verified_name || "(not reported)"}`);
if (data.quality_rating) console.log(`  quality rating  : ${data.quality_rating}`);
console.log("");
console.log("This id must match the one on WhatsApp -> API Setup, above the Recipient");
console.log("picker. A recipient verified against a DIFFERENT test number is refused with");
console.log("\"(#131030) Recipient phone number not in allowed list\", however plainly that");
console.log("recipient appears in the picker you are looking at.");
