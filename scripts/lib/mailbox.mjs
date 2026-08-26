/**
 * One way in for every mailbox, whichever provider it lives on.
 *
 * The sync loop used to hold Gmail's search syntax inline, which does not
 * survive a second provider: Graph filters with OData, not "after:2026/08/22".
 * Each provider now builds its own query from a plain Date, and returns the
 * same message shape, so adding a third mailbox is a config entry rather than
 * a change to the loop.
 *
 * Message shape every provider must return:
 *   { id, threadId, subject, from, to, date, internalDate, text }
 */
import { buildGmailClient, fetchNewMessages as fetchGmail } from "./gmail.mjs";
import { buildOutlookClient, fetchNewMessages as fetchOutlook } from "./outlook.mjs";

/** Accounts written before providers existed are Gmail. */
export const providerOf = (account) => (account.provider || "gmail").toLowerCase();

function gmailDateQuery(date, keyword = "after") {
  const d = new Date(date);
  const y = d.getUTCFullYear();
  const mm = String(d.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(d.getUTCDate()).padStart(2, "0");
  return `${keyword}:${y}/${mm}/${dd}`;
}

/**
 * Names the env vars an account needs, so a missing one can be reported by
 * name instead of failing somewhere inside an HTTP call.
 */
export function credentialsFor(account, env = process.env) {
  const provider = providerOf(account);
  if (provider === "outlook") {
    return {
      provider,
      clientId: env.OUTLOOK_CLIENT_ID,
      clientSecret: env.OUTLOOK_CLIENT_SECRET,
      refreshToken: env[account.refreshTokenEnv],
      missing: [
        !env.OUTLOOK_CLIENT_ID && "OUTLOOK_CLIENT_ID",
        !env[account.refreshTokenEnv] && account.refreshTokenEnv,
      ].filter(Boolean),
    };
  }
  return {
    provider: "gmail",
    clientId: env.GMAIL_CLIENT_ID,
    clientSecret: env.GMAIL_CLIENT_SECRET,
    refreshToken: env[account.refreshTokenEnv],
    missing: [
      !env.GMAIL_CLIENT_ID && "GMAIL_CLIENT_ID",
      !env.GMAIL_CLIENT_SECRET && "GMAIL_CLIENT_SECRET",
      !env[account.refreshTokenEnv] && account.refreshTokenEnv,
    ].filter(Boolean),
  };
}

export function buildClient(account, env = process.env) {
  const creds = credentialsFor(account, env);
  if (creds.missing.length) {
    throw new Error(`${account.label}: missing ${creds.missing.join(", ")}`);
  }
  return creds.provider === "outlook"
    ? { provider: "outlook", client: buildOutlookClient(creds) }
    : { provider: "gmail", client: buildGmailClient(creds) };
}

export function fetchNewMessages({ provider, client }, { since, until, seenIds, maxResults }) {
  if (provider === "outlook") {
    return fetchOutlook(client, { since, until, seenIds, maxResults });
  }
  const before = until ? ` ${gmailDateQuery(until, "before")}` : "";
  return fetchGmail(client, {
    query: `-in:chats -in:drafts -in:spam -in:trash ${gmailDateQuery(since)}${before}`,
    seenIds,
    maxResults,
  });
}
