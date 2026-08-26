/**
 * Password gate for the dashboard.
 *
 * READ THIS BEFORE TRUSTING IT. This is a privacy curtain, not a lock. The
 * page is static: there is no server to check a password against, so the check
 * necessarily happens in the browser, and anyone who opens developer tools can
 * step past it. More to the point, the data it covers -- data/manuscripts.json
 * and the rest -- sits in a public GitHub repository and can be read directly
 * without ever loading this page.
 *
 * What it is good for: stopping someone glancing at a shared screen, or
 * landing on the URL, from browsing the group's submissions. What it is not
 * good for: keeping the contents secret from anyone who wants them. The only
 * change that does that is making the repository private.
 *
 * The password is stored as a SHA-256 hash rather than plain text. That does
 * not make the gate stronger -- the hash is right here and the password is
 * guessable from it by anyone determined -- but it keeps the password itself
 * out of the source, off screen shares, and out of the browser's storage
 * inspector, which is where a shoulder-surfer would actually find it.
 */

const PASSWORD_HASH = "dc0b78480c00611eaa15a513c3d8b4539db80e3123f6629acef92b74a90a3ec3";
const SESSION_KEY = "orgkarur.session";
const REMEMBER_DAYS = 30;

async function sha256(text) {
  const bytes = new TextEncoder().encode(text);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * "Stay signed in" is the difference between localStorage, which survives the
 * browser closing, and sessionStorage, which does not. Both hold an expiry so
 * a forgotten tab on a shared machine does not stay unlocked forever.
 */
function readSession() {
  for (const store of [sessionStorage, localStorage]) {
    try {
      const raw = store.getItem(SESSION_KEY);
      if (!raw) continue;
      const { until } = JSON.parse(raw);
      if (until && Date.now() < until) return true;
      store.removeItem(SESSION_KEY); // expired
    } catch {
      // A malformed or unreadable entry is treated as no session at all.
    }
  }
  return false;
}

function writeSession(remember) {
  const store = remember ? localStorage : sessionStorage;
  const until = Date.now() + (remember ? REMEMBER_DAYS * 86400000 : 12 * 3600000);
  try {
    store.setItem(SESSION_KEY, JSON.stringify({ until }));
  } catch {
    // Private mode can refuse storage; the unlock still holds for this page view.
  }
}

export function signOut() {
  for (const store of [sessionStorage, localStorage]) {
    try { store.removeItem(SESSION_KEY); } catch { /* nothing to clear */ }
  }
  location.reload();
}

/** Resolves once the viewer is past the gate; the app boots only after that. */
export function requireUnlock() {
  return new Promise((resolve) => {
    if (readSession()) {
      document.body.classList.remove("locked");
      resolve();
      return;
    }

    document.body.classList.add("locked");
    const gate = document.getElementById("lock-screen");
    const form = document.getElementById("lock-form");
    const input = document.getElementById("lock-password");
    const remember = document.getElementById("lock-remember");
    const error = document.getElementById("lock-error");
    if (!gate || !form) { resolve(); return; }

    gate.hidden = false;
    setTimeout(() => input?.focus(), 60);

    let attempts = 0;
    form.addEventListener("submit", async (e) => {
      e.preventDefault();
      const entered = (input.value || "").trim();
      const ok = entered && (await sha256(entered)) === PASSWORD_HASH;

      if (!ok) {
        attempts++;
        error.textContent = attempts > 2
          ? "Still not right. Check with the group admin."
          : "That password is not right.";
        error.hidden = false;
        form.classList.remove("shake");
        void form.offsetWidth;          // restart the animation on a repeat miss
        form.classList.add("shake");
        input.select();
        return;
      }

      writeSession(remember?.checked);
      gate.hidden = true;
      document.body.classList.remove("locked");
      resolve();
    });
  });
}
