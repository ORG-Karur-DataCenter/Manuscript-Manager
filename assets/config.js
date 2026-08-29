/**
 * Deployment settings, read at runtime from assets/config.json.
 *
 * The setting lives in JSON, fetched with a cache-buster, rather than being a
 * baked-in constant. A static module import is cached hard by browsers and by
 * GitHub Pages, so editing it and seeing no change -- with the app quietly
 * falling back to asking for a token -- was an easy and confusing failure.
 * Fetching it means a change takes effect on the next page load, and a missing
 * or unreachable config is reported rather than silently ignored.
 *
 * WHAT GOES IN syncProxyUrl: the WORKER'S URL, e.g.
 * "https://orgkarur-comms-sync.<subdomain>.workers.dev". Never a token. This
 * file is public; the GitHub token belongs only in the Worker's secrets, set
 * with `npx wrangler secret put GITHUB_TOKEN`.
 *
 * Leave it empty and "Sync now" asks each person for their own GitHub token,
 * stored in their own browser. See worker/README.md.
 */

let config = { syncProxyUrl: "" };

export async function loadConfig() {
  try {
    const res = await fetch("assets/config.json?_=" + Date.now(), { cache: "no-store" });
    if (res.ok) config = { ...config, ...(await res.json()) };
  } catch {
    // Opened from the filesystem, or the file is missing: the defaults stand.
  }
  // A token pasted where the URL belongs must never be sent anywhere.
  // http://localhost is allowed alongside https so the app can be driven
  // against a stubbed proxy in a test; nothing leaves the machine there.
  const url = (config.syncProxyUrl || "").trim();
  if (url && !/^(https:\/\/|http:\/\/(localhost|127\.0\.0\.1)(:\d+)?(\/|$))/i.test(url)) {
    console.error(
      "assets/config.json: syncProxyUrl must be the Worker's https:// URL, not a token or anything else. Ignoring it."
    );
    config.syncProxyUrl = "";
  }
  return config;
}

export const syncProxyUrl = () => (config.syncProxyUrl || "").trim();
