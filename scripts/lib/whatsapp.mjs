/**
 * Sending a WhatsApp message.
 *
 * WHICH SERVICE, AND WHY IT IS PLUGGABLE. WhatsApp does not let a program
 * message a phone directly; something has to sit in between, and the options
 * differ sharply in what they cost and how much setting up they need:
 *
 *   callmebot  Free. Each recipient messages a bot once and gets a key back.
 *              No business account, no approval, no card. This is the default
 *              because there are two recipients and a handful of messages a
 *              week. It is a hobbyist service run by one person: it rate-limits
 *              to roughly a message a minute and could disappear, which is
 *              exactly why nothing below is written around it specifically.
 *   twilio     Paid, about half a cent a message, and reliable. A drop-in
 *              replacement when the free route stops being good enough.
 *   meta       WhatsApp Cloud API, from Meta itself. Cheapest at volume, but
 *              wants a verified business and pre-approved message templates.
 *   console    Prints instead of sending. What runs when nothing is configured,
 *              so a misconfigured setup is loud rather than silently mute.
 *
 * The message text is identical whichever is in use, so switching is a config
 * change and not a rewrite.
 *
 * ON PHONE NUMBERS. They are read from the environment, never from a file in
 * this repository. The repository is public: a number committed here is a
 * number published, and unlike a token it cannot be revoked and reissued.
 */

/** International format, digits only, no + — what every one of these APIs wants. */
export function normalizePhone(raw, defaultCountry = "91") {
  const digits = String(raw || "").replace(/[^\d]/g, "");
  if (!digits) return null;
  // A bare Indian mobile is ten digits starting 6-9; anything longer already
  // carries its country code.
  if (digits.length === 10 && /^[6-9]/.test(digits)) return `${defaultCountry}${digits}`;
  return digits.replace(/^0+/, "");
}

/**
 * Recipients come from WHATSAPP_RECIPIENTS as JSON:
 *   [{"name":"Dr Sathish","phone":"9600856806","apiKey":"123456"}]
 * `apiKey` is per-person and only CallMeBot needs it.
 */
export function readRecipients(env = process.env) {
  const raw = (env.WHATSAPP_RECIPIENTS || "").trim();
  if (!raw) return [];
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(
      "WHATSAPP_RECIPIENTS is not valid JSON. It should look like " +
      '[{"name":"Dr Sathish","phone":"9600856806","apiKey":"123456"}]'
    );
  }
  if (!Array.isArray(parsed)) throw new Error("WHATSAPP_RECIPIENTS must be a JSON array.");

  return parsed
    .map((r) => ({
      name: String(r.name || "").trim() || "unnamed",
      phone: normalizePhone(r.phone),
      apiKey: String(r.apiKey || r.api_key || "").trim(),
    }))
    .filter((r) => r.phone);
}

const TRANSPORTS = {
  /**
   * CallMeBot: one GET per message. It answers 200 with an HTML page whether it
   * worked or not, so the body is inspected rather than the status code alone.
   */
  async callmebot(recipient, text, { env, fetchImpl }) {
    if (!recipient.apiKey) {
      throw new Error(
        `No apiKey for ${recipient.name}. Each person gets their own by sending ` +
        `"I allow callmebot to send me messages" to CallMeBot on WhatsApp. If no key ` +
        `comes back, check the current number at callmebot.com/whatsapp/ — it has ` +
        `changed before — or switch to another service with WHATSAPP_TRANSPORT.`
      );
    }
    const url =
      "https://api.callmebot.com/whatsapp.php" +
      `?phone=${encodeURIComponent(recipient.phone)}` +
      `&apikey=${encodeURIComponent(recipient.apiKey)}` +
      `&text=${encodeURIComponent(text)}`;

    // A network failure is not CallMeBot refusing anything, and must not be
    // reported as though it were -- "the number has not authorised us" sends
    // someone off to fix a phone when the real fault is that the host was
    // unreachable.
    let res;
    try {
      res = await fetchImpl(url, { method: "GET" });
    } catch (err) {
      throw new Error(`Could not reach CallMeBot for ${recipient.name}: ${err.message}`);
    }
    const body = await res.text();
    // Its errors arrive as prose in a 200, so read the prose.
    if (!res.ok || /error|invalid|not.*allow|APIKey/i.test(body.slice(0, 400))) {
      const said = stripTags(body).slice(0, 160);
      // Its two usual complaints, translated into what to actually do.
      const hint = /apikey/i.test(said)
        ? " — the key does not match this number. Each person's key belongs to their own phone; check they have not been swapped."
        : /(you are|number is) not (allowed|authoriz)|not registered/i.test(said)
        ? " — this number has not authorised CallMeBot yet. Send it \"I allow callmebot to send me messages\" on WhatsApp first."
        : "";
      throw new Error(`CallMeBot refused the message for ${recipient.name}: ${said}${hint}`);
    }
    return { ok: true, detail: stripTags(body).slice(0, 120) };
  },

  async twilio(recipient, text, { env, fetchImpl }) {
    const sid = env.TWILIO_ACCOUNT_SID;
    const token = env.TWILIO_AUTH_TOKEN;
    const from = env.TWILIO_WHATSAPP_FROM;
    if (!sid || !token || !from) {
      throw new Error("Twilio needs TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN and TWILIO_WHATSAPP_FROM.");
    }
    const res = await fetchImpl(`https://api.twilio.com/2010-04-01/Accounts/${sid}/Messages.json`, {
      method: "POST",
      headers: {
        Authorization: `Basic ${Buffer.from(`${sid}:${token}`).toString("base64")}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({
        From: `whatsapp:${from.startsWith("+") ? from : `+${from}`}`,
        To: `whatsapp:+${recipient.phone}`,
        Body: text,
      }).toString(),
    });
    const body = await res.text();
    if (!res.ok) throw new Error(`Twilio returned ${res.status}: ${body.slice(0, 160)}`);
    return { ok: true, detail: `sid ${JSON.parse(body).sid}` };
  },

  async meta(recipient, text, { env, fetchImpl }) {
    const token = env.META_WHATSAPP_TOKEN;
    const phoneId = env.META_WHATSAPP_PHONE_ID;
    if (!token || !phoneId) {
      throw new Error("The Meta route needs META_WHATSAPP_TOKEN and META_WHATSAPP_PHONE_ID.");
    }
    const res = await fetchImpl(`https://graph.facebook.com/v21.0/${phoneId}/messages`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        messaging_product: "whatsapp",
        to: recipient.phone,
        type: "text",
        text: { preview_url: false, body: text },
      }),
    });
    const body = await res.text();
    if (!res.ok) throw new Error(`Meta returned ${res.status}: ${body.slice(0, 200)}`);
    return { ok: true, detail: "sent" };
  },

  /** No service configured: say what would have gone out, and to whom. */
  async console(recipient, text) {
    console.log(`\n--- would send to ${recipient.name} (+${recipient.phone}) ---\n${text}\n---`);
    return { ok: true, detail: "printed, not sent" };
  },
};

const stripTags = (html) => String(html).replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();

export const TRANSPORT_NAMES = Object.keys(TRANSPORTS);

/**
 * Send one message to everyone.
 *
 * One recipient's failure must not stop the others — if Sathish's key has
 * expired, Dhibin should still be told his amendment is due tomorrow. Results
 * come back per person so the caller can record what actually landed.
 */
export async function sendToAll(recipients, text, {
  transport = "console",
  env = process.env,
  fetchImpl = globalThis.fetch,
  pauseMs = 0,
} = {}) {
  const send = TRANSPORTS[transport];
  if (!send) {
    throw new Error(`Unknown WhatsApp transport "${transport}". Try one of: ${TRANSPORT_NAMES.join(", ")}`);
  }

  const results = [];
  for (const recipient of recipients) {
    try {
      const out = await send(recipient, text, { env, fetchImpl });
      results.push({ name: recipient.name, phone: recipient.phone, ok: true, detail: out.detail });
    } catch (err) {
      results.push({ name: recipient.name, phone: recipient.phone, ok: false, error: err.message });
    }
    // CallMeBot throttles at roughly a message a minute; a short pause between
    // recipients keeps a two-person send from tripping it.
    if (pauseMs && recipient !== recipients[recipients.length - 1]) {
      await new Promise((r) => setTimeout(r, pauseMs));
    }
  }
  return results;
}
