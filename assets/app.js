"use strict";

const BUCKET_META = {
  submissions: { label: "Submissions", pill: "submissions" },
  needs_action: { label: "Needs action", pill: "needs_action" },
  in_review: { label: "In review", pill: "in_review" },
  published: { label: "Published", pill: "published" },
};

const BUCKET_HINTS = {
  all: "Every manuscript being tracked, newest activity first.",
  submissions: "Freshly submitted — acknowledged by a journal, awaiting a first editorial check.",
  needs_action: "Needs you: rejected papers to resubmit elsewhere, or manuscripts returned for edits before peer review.",
  in_review: "With the journal — under peer review, revision in progress, or accepted and awaiting publication.",
  published: "Published, with DOI and article link where available.",
};

const NEEDS_ACTION_REASON = {
  rejected_needs_resubmission: "Rejected — resubmit to another journal",
  pre_review_edits: "Returned for edits before peer review",
};

const EVENT_LABELS = {
  new_submission: "Submitted",
  under_review: "Under review",
  revision_requested: "Revision requested",
  sent_back: "Sent back for edits",
  accepted: "Accepted",
  rejected: "Rejected",
  published: "Published",
  transferred: "Transferred",
  other: "Update",
};

let state = { manuscripts: [], bucket: "all", query: "" };

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

function fmtDate(iso) {
  if (!iso) return "—";
  const d = new Date(iso);
  if (isNaN(d)) return "—";
  return d.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
}
function fmtRelative(iso) {
  if (!iso) return "";
  const d = new Date(iso);
  if (isNaN(d)) return "";
  const days = Math.floor((Date.now() - d.getTime()) / 86400000);
  if (days <= 0) return "today";
  if (days === 1) return "yesterday";
  if (days < 30) return `${days}d ago`;
  if (days < 365) return `${Math.floor(days / 30)}mo ago`;
  return `${Math.floor(days / 365)}y ago`;
}
function esc(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}
function initials(name) {
  return String(name || "?").split(/\s+/).map((w) => w[0]).slice(0, 2).join("").toUpperCase();
}
function avatarColor(name) {
  let h = 0;
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) % 360;
  return `hsl(${h}, 55%, 45%)`;
}

async function load() {
  try {
    const res = await fetch("data/manuscripts.json?_=" + Date.now());
    const data = await res.json();
    state.manuscripts = data.manuscripts || [];
    const gen = data.generatedAt ? `Last synced ${fmtRelative(data.generatedAt)}` : "Not yet synced";
    $("#generated-at").textContent = gen;
  } catch (err) {
    $("#generated-at").textContent = "Could not load data";
    console.error(err);
  }
  renderCounts();
  render();
}

function counts() {
  const c = { all: state.manuscripts.length, submissions: 0, needs_action: 0, in_review: 0, published: 0 };
  for (const m of state.manuscripts) if (c[m.bucket] !== undefined) c[m.bucket]++;
  return c;
}

function renderCounts() {
  const c = counts();
  $$("[data-count]").forEach((el) => { el.textContent = c[el.dataset.count] ?? 0; });
}

function matchesQuery(m, q) {
  if (!q) return true;
  const hay = [
    m.title,
    m.currentJournal,
    m.currentManuscriptNumber,
    ...(m.submissions || []).map((s) => `${s.journal} ${s.manuscriptNumber || ""}`),
    ...(m.authorAccounts || []),
  ].join(" ").toLowerCase();
  return hay.includes(q.toLowerCase());
}

function filtered() {
  return state.manuscripts.filter(
    (m) => (state.bucket === "all" || m.bucket === state.bucket) && matchesQuery(m, state.query)
  );
}

function cardHtml(m) {
  const pill = BUCKET_META[m.bucket];
  const attnReason = m.needsActionReason ? NEEDS_ACTION_REASON[m.needsActionReason] : null;
  const chain = (m.submissions || []).length;
  const lastEvent = m.timeline?.[m.timeline.length - 1];
  const accounts = (m.authorAccounts || [])
    .map((a) => `<span class="avatar" style="background:${avatarColor(a)}" title="${esc(a)}">${esc(initials(a))}</span>`)
    .join("");

  return `
  <article class="card b-${m.bucket}" data-id="${esc(m.id)}" tabindex="0" role="button">
    <div class="card-top">
      <span class="pill ${pill.pill}">${esc(pill.label)}</span>
      ${m.actionFlag ? `<span class="action-flag">● ${esc(m.actionLabel || "Action")}</span>` : ""}
    </div>
    <h3 class="card-title">${esc(m.title)}</h3>
    <div class="card-meta">
      <div class="row"><span class="lbl">Journal</span><span>${esc(m.currentJournal || "—")}</span></div>
      <div class="row"><span class="lbl">Status</span><span>${esc(m.currentStatus || "—")}</span></div>
      ${attnReason ? `<div class="row"><span class="lbl">Action</span><span style="color:var(--needs);font-weight:600">${esc(attnReason)}</span></div>` : ""}
    </div>
    <div class="card-foot">
      <span class="card-when">Updated ${esc(fmtRelative(m.updatedAt))}${lastEvent ? " · " + esc(fmtDate(lastEvent.timestamp)) : ""}</span>
      <span style="display:flex;align-items:center;gap:8px">
        ${chain > 1 ? `<span class="chain-badge" title="${chain} journal submissions in this thread">⇄ ${chain}</span>` : ""}
        <span class="card-accounts">${accounts}</span>
      </span>
    </div>
  </article>`;
}

function render() {
  const list = filtered();
  const cards = $("#cards");
  const empty = $("#empty");
  $("#bucket-hint").textContent = BUCKET_HINTS[state.bucket] || "";

  if (!list.length) {
    cards.innerHTML = "";
    empty.hidden = false;
    empty.innerHTML = state.manuscripts.length
      ? `<h3>Nothing here</h3><p>No manuscripts match this filter${state.query ? " and search" : ""}.</p>`
      : `<h3>No manuscripts yet</h3><p>Once the Gmail sync runs, your tracked manuscripts will appear here.</p>`;
    return;
  }
  empty.hidden = true;
  cards.innerHTML = list.map(cardHtml).join("");
}

function drawerHtml(m) {
  const pill = BUCKET_META[m.bucket];
  const attnReason = m.needsActionReason ? NEEDS_ACTION_REASON[m.needsActionReason] : null;

  const chain = (m.submissions || [])
    .slice()
    .sort((a, b) => new Date(a.submittedDate) - new Date(b.submittedDate))
    .map((s) => {
      const outcome = s.outcome || "active";
      const link = s.publicationLink
        ? `<div class="chain-sub"><a href="${esc(s.publicationLink)}" target="_blank" rel="noopener">${esc(s.publicationLink)}</a></div>`
        : "";
      return `
      <div class="chain-item ${outcome === "rejected" ? "rejected" : ""}">
        <div class="chain-jrnl">
          <b>${esc(s.journal)}</b>
          <span class="chain-outcome ${outcome}">${esc(outcome)}</span>
        </div>
        <div class="chain-sub">
          ${s.manuscriptNumber ? `No. ${esc(s.manuscriptNumber)} · ` : ""}Submitted ${esc(fmtDate(s.submittedDate))}
          ${s.doi ? ` · DOI ${esc(s.doi)}` : ""}
        </div>
        ${link}
      </div>`;
    })
    .join("");

  const timeline = (m.timeline || [])
    .slice()
    .sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp))
    .map((e) => `
      <div class="tl-item ev-${esc(e.eventType)}">
        <div class="tl-head">
          <span class="tl-label">${esc(e.label || EVENT_LABELS[e.eventType] || e.eventType)}${e.revisionRound ? ` (round ${esc(e.revisionRound)})` : ""}</span>
          <span class="tl-date">${esc(fmtDate(e.timestamp))}</span>
        </div>
        <div class="tl-journal">${esc(e.journal || "")}</div>
        ${e.note ? `<div class="tl-note">${esc(e.note)}</div>` : ""}
      </div>`)
    .join("");

  const doiBox = m.doi || m.publicationLink
    ? `<div class="d-doi-box">
        <span class="doi-lab">Published</span>
        ${m.doi ? `<div><b>DOI:</b> <a href="https://doi.org/${esc(m.doi)}" target="_blank" rel="noopener">${esc(m.doi)}</a></div>` : ""}
        ${m.publicationLink ? `<div><a href="${esc(m.publicationLink)}" target="_blank" rel="noopener">${esc(m.publicationLink)}</a></div>` : ""}
      </div>`
    : "";

  return `
    <h2 class="d-title">${esc(m.title)}</h2>
    <div class="d-status-row">
      <span class="pill ${pill.pill}">${esc(pill.label)}</span>
      ${m.actionFlag ? `<span class="action-flag">● ${esc(m.actionLabel || "Action")}</span>` : ""}
      ${attnReason ? `<span class="pill needs_action">${esc(attnReason)}</span>` : ""}
    </div>
    ${doiBox}
    <dl class="d-facts">
      <dt>Current journal</dt><dd>${esc(m.currentJournal || "—")}</dd>
      <dt>Current status</dt><dd>${esc(m.currentStatus || "—")}</dd>
      ${m.currentManuscriptNumber ? `<dt>Manuscript no.</dt><dd>${esc(m.currentManuscriptNumber)}</dd>` : ""}
      <dt>Author inbox</dt><dd>${esc((m.authorAccounts || []).join(", ") || "—")}</dd>
      <dt>First tracked</dt><dd>${esc(fmtDate(m.createdAt))}</dd>
      <dt>Last update</dt><dd>${esc(fmtDate(m.updatedAt))}</dd>
    </dl>

    <div class="d-section-label">Submission thread (${(m.submissions || []).length})</div>
    <div class="chain">${chain}</div>

    <div class="d-section-label">Status timeline</div>
    <div class="timeline">${timeline}</div>
  `;
}

function openDrawer(id) {
  const m = state.manuscripts.find((x) => x.id === id);
  if (!m) return;
  $("#drawer-body").innerHTML = drawerHtml(m);
  $("#drawer").hidden = false;
  $("#drawer-overlay").hidden = false;
  document.body.style.overflow = "hidden";
}
function closeDrawer() {
  $("#drawer").hidden = true;
  $("#drawer-overlay").hidden = true;
  document.body.style.overflow = "";
}

function initTheme() {
  const saved = (() => { try { return localStorage.getItem("mt-theme"); } catch { return null; } })();
  if (saved) document.documentElement.setAttribute("data-theme", saved);
  else if (window.matchMedia?.("(prefers-color-scheme: dark)").matches)
    document.documentElement.setAttribute("data-theme", "dark");
}
function toggleTheme() {
  const cur = document.documentElement.getAttribute("data-theme");
  const next = cur === "dark" ? "light" : "dark";
  document.documentElement.setAttribute("data-theme", next);
  try { localStorage.setItem("mt-theme", next); } catch {}
}

function wire() {
  $("#buckets").addEventListener("click", (e) => {
    const btn = e.target.closest(".bucket-btn");
    if (!btn) return;
    state.bucket = btn.dataset.bucket;
    $$(".bucket-btn").forEach((b) => b.classList.toggle("active", b === btn));
    render();
  });
  $("#search").addEventListener("input", (e) => { state.query = e.target.value.trim(); render(); });
  $("#cards").addEventListener("click", (e) => {
    const card = e.target.closest(".card");
    if (card) openDrawer(card.dataset.id);
  });
  $("#cards").addEventListener("keydown", (e) => {
    if ((e.key === "Enter" || e.key === " ") && e.target.classList.contains("card")) {
      e.preventDefault();
      openDrawer(e.target.dataset.id);
    }
  });
  $("#drawer-close").addEventListener("click", closeDrawer);
  $("#drawer-overlay").addEventListener("click", closeDrawer);
  document.addEventListener("keydown", (e) => { if (e.key === "Escape") closeDrawer(); });
  $("#theme-btn").addEventListener("click", toggleTheme);
}

initTheme();
wire();
load();
