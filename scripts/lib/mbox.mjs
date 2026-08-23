/**
 * Minimal mbox reader for Google Takeout exports.
 *
 * Deliberately dependency-free and tolerant: Takeout mboxes are large and
 * occasionally malformed, and a single bad message must not abort an import
 * that may be resumed across several days.
 */
import { createReadStream } from "node:fs";
import { createInterface } from "node:readline";

function decodeQuotedPrintable(input) {
  return input
    .replace(/=\r?\n/g, "")
    .replace(/=([0-9A-Fa-f]{2})/g, (_, hex) =>
      String.fromCharCode(parseInt(hex, 16))
    );
}

function decodeBody(body, encoding, charset) {
  const enc = (encoding || "").toLowerCase();
  try {
    if (enc === "base64") {
      return Buffer.from(body.replace(/\s+/g, ""), "base64").toString(
        charset || "utf-8"
      );
    }
    if (enc === "quoted-printable") {
      return Buffer.from(decodeQuotedPrintable(body), "binary").toString(
        charset || "utf-8"
      );
    }
  } catch {
    /* fall through to raw */
  }
  return body;
}

/** RFC 2047 encoded-words appear constantly in Subject headers. */
function decodeHeaderWords(value) {
  return value.replace(
    /=\?([^?]+)\?([BbQq])\?([^?]*)\?=/g,
    (_, charset, enc, text) => {
      try {
        if (enc.toUpperCase() === "B") {
          return Buffer.from(text, "base64").toString(charset);
        }
        return Buffer.from(
          decodeQuotedPrintable(text.replace(/_/g, " ")),
          "binary"
        ).toString(charset);
      } catch {
        return text;
      }
    }
  );
}

function parseHeaders(lines) {
  const headers = {};
  let current = null;
  for (const line of lines) {
    if (/^\s/.test(line) && current) {
      headers[current] += " " + line.trim();
      continue;
    }
    const idx = line.indexOf(":");
    if (idx === -1) continue;
    current = line.slice(0, idx).toLowerCase();
    headers[current] = line.slice(idx + 1).trim();
  }
  return headers;
}

function stripHtml(html) {
  return html
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/p>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/**
 * Pull readable text out of one raw message. Prefers text/plain, falls back to
 * stripped HTML — the same preference the Gmail path uses, so imported and
 * synced emails reach the classifier looking alike.
 */
function extractText(headers, bodyLines) {
  const contentType = headers["content-type"] || "";
  const boundaryMatch = /boundary="?([^";]+)"?/i.exec(contentType);

  if (!boundaryMatch) {
    const text = decodeBody(
      bodyLines.join("\n"),
      headers["content-transfer-encoding"],
      /charset="?([^";]+)"?/i.exec(contentType)?.[1]
    );
    return /html/i.test(contentType) ? stripHtml(text) : text;
  }

  const boundary = `--${boundaryMatch[1]}`;
  const parts = [];
  let currentLines = null;
  for (const line of bodyLines) {
    if (line.startsWith(boundary)) {
      if (currentLines) parts.push(currentLines);
      currentLines = line.startsWith(`${boundary}--`) ? null : [];
      continue;
    }
    if (currentLines) currentLines.push(line);
  }
  if (currentLines) parts.push(currentLines);

  let plain = "";
  let html = "";
  for (const part of parts) {
    const blank = part.indexOf("");
    if (blank === -1) continue;
    const partHeaders = parseHeaders(part.slice(0, blank));
    const partType = partHeaders["content-type"] || "";
    const decoded = decodeBody(
      part.slice(blank + 1).join("\n"),
      partHeaders["content-transfer-encoding"],
      /charset="?([^";]+)"?/i.exec(partType)?.[1]
    );
    if (/text\/plain/i.test(partType)) plain += decoded;
    else if (/text\/html/i.test(partType)) html += decoded;
    else if (/multipart/i.test(partType)) {
      // Nested multipart (common: mixed wrapping alternative).
      plain += extractText(partHeaders, part.slice(blank + 1));
    }
  }

  if (plain.trim()) return plain.trim();
  if (html.trim()) return stripHtml(html);
  return "";
}

function toMessage(rawLines) {
  const blank = rawLines.indexOf("");
  if (blank === -1) return null;
  const headers = parseHeaders(rawLines.slice(0, blank));
  if (!headers["message-id"] && !headers.subject) return null;

  const date = headers.date ? new Date(headers.date) : null;
  const valid = date && !Number.isNaN(date.getTime());

  return {
    id: (headers["message-id"] || "").replace(/[<>]/g, "") || null,
    threadId: (headers["message-id"] || "").replace(/[<>]/g, "") || null,
    subject: decodeHeaderWords(headers.subject || ""),
    from: decodeHeaderWords(headers.from || ""),
    to: decodeHeaderWords(headers.to || ""),
    date: headers.date || "",
    internalDate: valid ? date.toISOString() : new Date(0).toISOString(),
    text: extractText(headers, rawLines.slice(blank + 1)).slice(0, 12000),
  };
}

/**
 * Stream messages out of an mbox file one at a time, so a multi-gigabyte
 * Takeout export never has to be held in memory.
 */
export async function* readMbox(filePath) {
  const rl = createInterface({
    input: createReadStream(filePath),
    crlfDelay: Infinity,
  });

  let buffer = [];
  for await (const line of rl) {
    // A "From " at column 0 starts the next message in mbox format.
    if (/^From \S+/.test(line) && buffer.length) {
      const msg = toMessage(buffer);
      if (msg) yield msg;
      buffer = [];
      continue;
    }
    if (/^From \S+/.test(line)) continue;
    buffer.push(line);
  }
  if (buffer.length) {
    const msg = toMessage(buffer);
    if (msg) yield msg;
  }
}
