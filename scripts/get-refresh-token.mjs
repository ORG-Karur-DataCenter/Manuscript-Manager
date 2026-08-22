/**
 * One-time local helper: mints a Gmail OAuth refresh token for ONE account.
 *
 * Run locally (NOT in CI) once per Gmail account you want the tracker to read:
 *
 *   GMAIL_CLIENT_ID=... GMAIL_CLIENT_SECRET=... node scripts/get-refresh-token.mjs
 *
 * Requires a Google Cloud OAuth 2.0 Client ID of type "Desktop app" with the
 * Gmail API enabled, and http://localhost:53682/oauth2callback allowed as a
 * redirect URI (Desktop-app clients allow loopback redirects on any port
 * automatically). See README.md for the full walkthrough.
 *
 * Sign in with the SPECIFIC Gmail account you're minting the token for —
 * if you're signed into multiple Google accounts in your browser, choose
 * the right one at the account picker.
 *
 * Prints a refresh_token — store it as the matching GitHub Actions secret
 * named in config/accounts.json (refreshTokenEnv), e.g. GMAIL_REFRESH_TOKEN_SATHISH.
 */
import http from "node:http";
import { google } from "googleapis";

const PORT = 53682;
const REDIRECT_URI = `http://localhost:${PORT}/oauth2callback`;

const clientId = process.env.GMAIL_CLIENT_ID;
const clientSecret = process.env.GMAIL_CLIENT_SECRET;

if (!clientId || !clientSecret) {
  console.error("Set GMAIL_CLIENT_ID and GMAIL_CLIENT_SECRET in your environment first.");
  process.exit(1);
}

const oauth2Client = new google.auth.OAuth2(clientId, clientSecret, REDIRECT_URI);

const authUrl = oauth2Client.generateAuthUrl({
  access_type: "offline",
  prompt: "consent", // force a refresh_token even if this client was authorized before
  scope: ["https://www.googleapis.com/auth/gmail.readonly"],
});

console.log("\nOpen this URL, sign in with the Gmail account to track, and approve access:\n");
console.log(authUrl + "\n");
console.log(`Waiting for the redirect back to ${REDIRECT_URI} ...\n`);

const server = http.createServer(async (req, res) => {
  if (!req.url.startsWith("/oauth2callback")) {
    res.writeHead(404);
    res.end();
    return;
  }
  const url = new URL(req.url, REDIRECT_URI);
  const code = url.searchParams.get("code");
  const error = url.searchParams.get("error");

  if (error) {
    res.writeHead(200, { "Content-Type": "text/plain" });
    res.end(`Authorization failed: ${error}. You can close this tab.`);
    console.error(`Authorization failed: ${error}`);
    server.close();
    process.exit(1);
  }

  try {
    const { tokens } = await oauth2Client.getToken(code);
    res.writeHead(200, { "Content-Type": "text/plain" });
    res.end("Success — you can close this tab and return to the terminal.");

    if (!tokens.refresh_token) {
      console.error(
        "\nNo refresh_token was returned. This usually means the account already " +
          "granted this app access before without revoking it. Revoke access at " +
          "https://myaccount.google.com/permissions and run this script again."
      );
      process.exit(1);
    }

    console.log("\nRefresh token (store this as a GitHub Actions secret):\n");
    console.log(tokens.refresh_token);
    console.log("");
  } catch (err) {
    console.error("Token exchange failed:", err.message);
  } finally {
    server.close();
    process.exit(0);
  }
});

server.listen(PORT);
