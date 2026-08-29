/**
 * Microsoft Graph mail reader, shaped to match lib/gmail.mjs so the sync loop
 * does not care which mailbox it is reading.
 *
 * Plain fetch rather than an SDK, for the same reason the classifier providers
 * are: one HTTP call each way, no dependency to keep current, and the failure
 * modes stay visible.
 *
 * Auth is the OAuth refresh-token flow against the "common" endpoint, which is
 * what a personal outlook.com account needs. The app registration must allow
 * "personal Microsoft accounts" or the token exchange fails with an audience
 * error that reads as though the credentials are wrong.
 */
import { stripHtml } from "./text.mjs";

const TOKEN_URL = "https://login.microsoftonline.com/common/oauth2/v2.0/token";
const GRAPH = "https://graph.microsoft.com/v1.0";
export const SCOPES = "offline_access Mail.Read";

export function buildOutlookClient({ clientId, clientSecret, refreshToken }) {
  if (!clientId || !refreshToken) {
    throw new Error("Outlook needs OUTLOOK_CLIENT_ID and a refresh token.");
  }

  let accessToken = null;
  let expiresAt = 0;

  async function token() {
    // Graph access tokens last an hour; refresh a minute early so a long run
    // cannot have one expire mid-page.
    if (accessToken && Date.now() < expiresAt - 60000) return accessToken;

    const body = new URLSearchParams({
      client_id: clientId,
      refresh_token: refreshToken,
      grant_type: "refresh_token",
      scope: SCOPES,
    });
    // Public clients registered without one legitimately have no secret.
    if (clientSecret) body.set("client_secret", clientSecret);

    const res = await fetch(TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body,
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      throw new Error(
        `Outlook token refresh failed (${res.status}): ${data.error_description || data.error || "unknown"}`
      );
    }
    accessToken = data.access_token;
    expiresAt = Date.now() + (data.expires_in || 3600) * 1000;
    return accessToken;
  }

  async function get(url) {
    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${await token()}`, Accept: "application/json" },
    });
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Graph ${res.status} on ${url.replace(GRAPH, "")}: ${text.slice(0, 200)}`);
    }
    return res.json();
  }

  return { get, graph: GRAPH };
}

const address = (recipient) => {
  const e = recipient?.emailAddress;
  if (!e) return "";
  return e.name && e.name !== e.address ? `${e.name} <${e.address}>` : e.address || "";
};

/**
 * Fetches messages received since `since`, skipping ids already seen.
 *
 * Graph returns the full message in the list response, so unlike Gmail there
 * is no second round trip per message.
 *
 * Deleted Items is included: /me/messages spans folders, and filtering it out
 * costs an extra lookup for little gain, since seen ids and the registry both
 * dedupe by message id anyway.
 */
export async function fetchNewMessages(client, { since, until, seenIds, maxResults = 150 }) {
  const sinceIso = new Date(since).toISOString();
  // A backfill is taken in slices, so the window needs a far edge too.
  const untilClause = until ? ` and receivedDateTime lt ${new Date(until).toISOString()}` : "";
  const select = "id,conversationId,subject,from,toRecipients,receivedDateTime,body,bodyPreview,isDraft";
  let url =
    `${client.graph}/me/messages` +
    `?$filter=receivedDateTime ge ${sinceIso}${untilClause} and isDraft eq false` +
    `&$select=${select}&$orderby=receivedDateTime desc&$top=50`;

  const messages = [];
  while (url && messages.length < maxResults) {
    const page = await client.get(url);
    for (const m of page.value || []) {
      if (seenIds.has(m.id)) continue;
      const raw = m.body?.content || m.bodyPreview || "";
      const text = m.body?.contentType === "html" ? stripHtml(raw) : raw;
      messages.push({
        id: m.id,
        threadId: m.conversationId || m.id,
        subject: m.subject || "",
        from: address(m.from),
        to: (m.toRecipients || []).map(address).filter(Boolean).join(", "),
        date: m.receivedDateTime || "",
        internalDate: m.receivedDateTime
          ? new Date(m.receivedDateTime).toISOString()
          : new Date().toISOString(),
        // Graph reports delivery to this mailbox, so the two coincide here.
        receivedAt: m.receivedDateTime
          ? new Date(m.receivedDateTime).toISOString()
          : new Date().toISOString(),
        text: text.slice(0, 12000),
      });
      if (messages.length >= maxResults) break;
    }
    url = page["@odata.nextLink"] || null;
  }
  return messages;
}
