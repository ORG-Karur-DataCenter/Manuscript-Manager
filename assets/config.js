/**
 * Deployment settings. A URL is not a secret, so this file is committed; the
 * GitHub token it stands in for lives only in the Worker.
 *
 * Leave SYNC_PROXY_URL empty and "Sync now" falls back to asking each person
 * for their own GitHub token, stored in their own browser. Set it to a
 * deployed Worker and nobody is ever asked for a token again — see
 * worker/README.md.
 */
export const SYNC_PROXY_URL = "";
