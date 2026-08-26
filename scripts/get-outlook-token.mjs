/**
 * One-time helper: turn an Azure app registration into a refresh token for an
 * outlook.com mailbox, to be stored as a GitHub Actions secret.
 *
 *   OUTLOOK_CLIENT_ID=... [OUTLOOK_CLIENT_SECRET=...] node scripts/get-outlook-token.mjs
 *
 * Mirrors get-refresh-token.mjs: opens a local callback, prints a URL to sign
 * in with, and exchanges the code. Nothing is written to disk -- the token is
 * printed once, for pasting straight into the secret.
 */
import http from "node:http";
import { SCOPES } from "./lib/outlook.mjs";

const PORT = 53683;
const REDIRECT_URI = `http://localhost:${PORT}/callback`;
const AUTH = "https://login.microsoftonline.com/common/oauth2/v2.0";

const clientId = process.env.OUTLOOK_CLIENT_ID;
const clientSecret = process.env.OUTLOOK_CLIENT_SECRET || "";
if (!clientId) {
  console.error("Set OUTLOOK_CLIENT_ID (from the Azure app registration) first.");
  process.exit(1);
}

const authUrl =
  `${AUTH}/authorize?client_id=${encodeURIComponent(clientId)}` +
  `&response_type=code&redirect_uri=${encodeURIComponent(REDIRECT_URI)}` +
  `&response_mode=query&scope=${encodeURIComponent(SCOPES)}&prompt=consent`;

console.log("\nOpen this in a browser, signed in as the Outlook account:\n");
console.log(authUrl + "\n");

const server = http.createServer(async (req, res) => {
  if (!req.url.startsWith("/callback")) {
    res.writeHead(404).end();
    return;
  }
  const code = new URL(req.url, `http://localhost:${PORT}`).searchParams.get("code");
  if (!code) {
    res.writeHead(400).end("No code in the callback.");
    return;
  }

  const body = new URLSearchParams({
    client_id: clientId,
    grant_type: "authorization_code",
    code,
    redirect_uri: REDIRECT_URI,
    scope: SCOPES,
  });
  if (clientSecret) body.set("client_secret", clientSecret);

  const tokenRes = await fetch(`${AUTH}/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });
  const data = await tokenRes.json().catch(() => ({}));

  if (!tokenRes.ok || !data.refresh_token) {
    const why = data.error_description || data.error || "no refresh_token returned";
    res.writeHead(500).end(`Token exchange failed: ${why}`);
    console.error(`\nFailed: ${why}`);
    console.error(
      "If it mentions the audience or account type, the app registration must allow " +
      "personal Microsoft accounts. If it mentions offline_access, that scope is missing."
    );
    server.close();
    process.exit(1);
  }

  res.end("Done. The refresh token is in your terminal — close this tab.");
  console.log("\nRefresh token (store as a GitHub Actions secret, e.g. OUTLOOK_REFRESH_TOKEN_DHIBIN):\n");
  console.log(data.refresh_token + "\n");
  server.close();
  process.exit(0);
});

server.listen(PORT, () => console.log(`Waiting for the callback on ${REDIRECT_URI} ...`));
