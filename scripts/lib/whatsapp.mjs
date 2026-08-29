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
  async callmebot(recipient, message, { env, fetchImpl }) {
    if (!recipient.apiKey) {
      throw new Error(
        `No apiKey for ${recipient.name}. Each person gets their own by sending ` +
        `"I allow callmebot to send me messages" on WhatsApp to +34 613 01 49 37 ` +
        `-- check that number on callmebot.com first, it has changed once already ` +
        `and a stale one is simply read by whoever holds it now. If no key comes ` +
        `back within two minutes, their advice is to try again a day later.`
      );
    }
    const url =
      "https://api.callmebot.com/whatsapp.php" +
      `?phone=${encodeURIComponent(recipient.phone)}` +
      `&apikey=${encodeURIComponent(recipient.apiKey)}` +
      `&text=${encodeURIComponent(message.text)}`;

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

  async twilio(recipient, message, { env, fetchImpl }) {
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
        Body: message.text,
      }).toString(),
    });
    const body = await res.text();
    if (!res.ok) throw new Error(`Twilio returned ${res.status}: ${body.slice(0, 160)}`);
    return { ok: true, detail: `sid ${JSON.parse(body).sid}` };
  },

  /**
   * Meta's own WhatsApp Cloud API.
   *
   * THE RULE THAT SHAPES THIS. Meta only accepts free-form text within 24 hours
   * of the recipient last messaging you. Outside that window a business may
   * send only a pre-approved TEMPLATE. Deadline reminders fire days apart and
   * nobody replies to them, so in practice every single one falls outside the
   * window -- sending plain text here would be rejected essentially always.
   *
   * So a template is the normal path, and the free-text path is kept only for
   * the rare case of replying inside an open window. Set:
   *   META_WHATSAPP_TEMPLATE   the approved template's name
   *   META_WHATSAPP_LANGUAGE   its language code (default en)
   *   META_API_VERSION         the Graph API version (default below)
   *
   * The version is configurable because Meta retires each one about two years
   * after release, and a retired version fails with an error that reads like a
   * broken request rather than an expired one. The API Setup page in the Meta
   * dashboard shows the current version in its sample request; if the error
   * below mentions the version, copy it from there.
   *
   * The template needs one body with five placeholders, in this order:
   *   {{1}} what has happened   e.g. "Amendment due"
   *   {{2}} how long is left    e.g. "3 days left"
   *   {{3}} the manuscript      title, shortened
   *   {{4}} the journal
   *   {{5}} the due date        e.g. "Tue 1 Sept (estimated)"
   *
   * Meta REFUSES a body that begins or ends with a placeholder -- a "dangling
   * parameter" -- and wants each one introduced by a label. So the approved
   * body wraps them in plain sentences; see the README for the exact text. If
   * a sixth parameter is ever added here, it has to go in the middle.
   */
  async meta(recipient, message, { env, fetchImpl }) {
    const token = env.META_WHATSAPP_TOKEN;
    const phoneId = env.META_WHATSAPP_PHONE_ID;
    if (!token || !phoneId) {
      throw new Error("The Meta route needs META_WHATSAPP_TOKEN and META_WHATSAPP_PHONE_ID.");
    }
    const template = (env.META_WHATSAPP_TEMPLATE || "").trim();
    const version = (env.META_API_VERSION || "v21.0").trim();

    const payload = template
      ? {
          messaging_product: "whatsapp",
          to: recipient.phone,
          type: "template",
          template: {
            name: template,
            language: { code: (env.META_WHATSAPP_LANGUAGE || "en").trim() },
            components: [{
              type: "body",
              parameters: (message.params || []).map((p) => ({ type: "text", text: templateSafe(p) })),
            }],
          },
        }
      : {
          messaging_product: "whatsapp",
          to: recipient.phone,
          type: "text",
          text: { preview_url: false, body: message.text },
        };

    const res = await fetchImpl(`https://graph.facebook.com/${version}/${phoneId}/messages`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    const body = await res.text();
    if (!res.ok) {
      // The failure everyone hits first, translated. Meta reports it as a
      // generic 131047 / "Re-engagement message" and it reads like a bug.
      const outsideWindow = /131047|re-?engagement|24 hour/i.test(body);
      const badVersion = /unsupported (get|post) request|version|deprecat/i.test(body) && res.status === 400;
      const notInAllowList = /131030|not in allowed list/i.test(body);
      throw new Error(
        `Meta returned ${res.status}: ${body.slice(0, 200)}` +
        (outsideWindow && !template
          ? " — plain text is only allowed within 24 hours of the recipient writing to you. " +
            "Set META_WHATSAPP_TEMPLATE to an approved template name; reminders always fall outside that window."
          : notInAllowList
          ? ` — ${recipient.name}'s number is not on the test number's recipient list. ` +
            "Add and verify it under WhatsApp -> API Setup -> To."
          : badVersion
          ? ` — the Graph API version (${version}) may have been retired. ` +
            "Set META_API_VERSION to the version shown in the dashboard's API Setup sample request."
          : "")
      );
    }
    return { ok: true, detail: template ? `template ${template}` : "free text" };
  },

  /** No service configured: say what would have gone out, and to whom. */
  async console(recipient, message) {
    console.log(`\n--- would send to ${recipient.name} (+${recipient.phone}) ---\n${message.text}\n---`);
    return { ok: true, detail: "printed, not sent" };
  },
};

/**
 * Meta rejects a template parameter containing a newline, a tab, or four or
 * more consecutive spaces, with an error that does not say which parameter is
 * at fault. Flattening here is cheaper than diagnosing that later.
 */
const templateSafe = (value) =>
  String(value ?? "").replace(/[\r\n\t]+/g, " ").replace(/ {4,}/g, "   ").trim().slice(0, 900);

const stripTags = (html) => String(html).replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();

export const TRANSPORT_NAMES = Object.keys(TRANSPORTS);

/**
 * Send one message to everyone.
 *
 * One recipient's failure must not stop the others — if Sathish's key has
 * expired, Dhibin should still be told his amendment is due tomorrow. Results
 * come back per person so the caller can record what actually landed.
 */
export async function sendToAll(recipients, message, {
  transport = "console",
  env = process.env,
  fetchImpl = globalThis.fetch,
  pauseMs = 0,
} = {}) {
  // Callers may pass a plain string; the template transports need the
  // structured form, so normalise once here rather than in each transport.
  const payload = typeof message === "string" ? { text: message, params: [] } : message;

  const send = TRANSPORTS[transport];
  if (!send) {
    throw new Error(`Unknown WhatsApp transport "${transport}". Try one of: ${TRANSPORT_NAMES.join(", ")}`);
  }

  const results = [];
  for (const recipient of recipients) {
    try {
      const out = await send(recipient, payload, { env, fetchImpl });
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
