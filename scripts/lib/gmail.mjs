import { google } from "googleapis";
import { stripHtml, eventTimestamp } from "./text.mjs";

export function buildGmailClient({ clientId, clientSecret, refreshToken }) {
  const oauth2Client = new google.auth.OAuth2(clientId, clientSecret);
  oauth2Client.setCredentials({ refresh_token: refreshToken });
  return google.gmail({ version: "v1", auth: oauth2Client });
}

function decodeBase64Url(data) {
  if (!data) return "";
  return Buffer.from(data, "base64url").toString("utf-8");
}

function extractBody(payload) {
  let plain = "";
  let html = "";

  function walk(part) {
    if (!part) return;
    const mime = part.mimeType || "";
    if (mime === "text/plain" && part.body?.data) {
      plain += decodeBase64Url(part.body.data);
    } else if (mime === "text/html" && part.body?.data) {
      html += decodeBase64Url(part.body.data);
    } else if (part.parts) {
      for (const child of part.parts) walk(child);
    }
  }
  walk(payload);

  if (plain.trim()) return plain.trim();
  if (html.trim()) return stripHtml(html);
  return "";
}

function getHeader(headers, name) {
  const h = (headers || []).find(
    (x) => x.name.toLowerCase() === name.toLowerCase()
  );
  return h ? h.value : "";
}

/**
 * Lists candidate message IDs in the window, then fetches full content
 * only for IDs not already in `seenIds`.
 */
export async function fetchNewMessages(gmail, { query, seenIds, maxResults = 150 }) {
  const results = [];
  let pageToken;

  do {
    const { data } = await gmail.users.messages.list({
      userId: "me",
      q: query,
      maxResults: 100,
      pageToken,
    });
    const ids = (data.messages || []).map((m) => m.id);
    for (const id of ids) {
      if (!seenIds.has(id)) results.push(id);
    }
    pageToken = data.nextPageToken;
  } while (pageToken && results.length < maxResults);

  const messages = [];
  for (const id of results.slice(0, maxResults)) {
    const { data } = await gmail.users.messages.get({
      userId: "me",
      id,
      format: "full",
    });
    const headers = data.payload?.headers || [];
    messages.push({
      id: data.id,
      threadId: data.threadId,
      subject: getHeader(headers, "Subject"),
      from: getHeader(headers, "From"),
      to: getHeader(headers, "To"),
      date: getHeader(headers, "Date"),
      // Not simply data.internalDate: mail imported from another account is
      // delivered today but happened months ago. See eventTimestamp.
      internalDate: eventTimestamp(data.internalDate, getHeader(headers, "Date")),
      // Delivery time, kept separate from the event time above. The sync
      // window is a position in this mailbox's delivery order, so an imported
      // five-month-old message must not drag it five months backwards.
      receivedAt: data.internalDate
        ? new Date(Number(data.internalDate)).toISOString()
        : new Date().toISOString(),
      text: extractBody(data.payload).slice(0, 12000),
    });
  }
  return messages;
}
