import { requireUnlock, signOut } from "./auth.js";
import { runSync, waitForFreshData, hasToken, hasOwnToken, setToken, usingProxy, rememberPassphrase } from "./sync.js";
import { loadConfig } from "./config.js";
import { FIELDS, SECTIONS, isPinned, editingAvailable, saveEdit, diff } from "./edit.js";

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
  review: "Emails the classifier would not guess at. Nothing here has been filed on a guess — check each one and correct the record.",
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

// `review` holds the entries the classifier declined to guess at. Some
// correspond to a filed manuscript (flagged on its card); the rest were never
// filable at all and would otherwise be invisible.
let state = { manuscripts: [], review: [], bucket: "all", query: "", generatedAt: null };

/**
 * How long is left on an amendment. Counted in whole calendar days in the
 * group's own timezone, matching scripts/lib/deadline.mjs — a deadline is a
 * day, not an instant, and it must read the same on the phone as in the
 * WhatsApp message that announced it.
 */
const ZONE_MS = 330 * 60000; // Asia/Kolkata, which has no daylight saving
const dayIndex = (ms) => Math.floor((ms + ZONE_MS) / 86400000);

function daysLeft(due) {
  const at = new Date(due).getTime();
  if (!Number.isFinite(at)) return null;
  return dayIndex(at) - dayIndex(Date.now());
}

function deadlineText(due) {
  const left = daysLeft(due);
  if (left === null) return "";
  if (left < 0) return left === -1 ? "1 day overdue" : `${-left} days overdue`;
  if (left === 0) return "due today";
  if (left === 1) return "due tomorrow";
  return `${left} days left`;
}

/** Urgent, close, or merely pending — drives the colour, nothing else. */
function deadlineLevel(due) {
  const left = daysLeft(due);
  if (left === null) return "";
  return left < 0 ? "overdue" : left <= 1 ? "urgent" : left <= 3 ? "soon" : "open";
}

/** A date nobody stated and nobody chose — worked out from the journal's habits. */
const isEstimated = (m) => m.deadlineSource === "assumed" && !isPinned(m, "deadline");

function deadlineChip(m) {
  // Only while the work is actually outstanding: a date left over from a
  // finished amendment is a false alarm, and the most alarming kind.
  if (!m.deadline || !m.actionFlag) return "";
  const exact = new Date(m.deadline).toLocaleDateString(undefined, {
    weekday: "short", day: "numeric", month: "short",
  });
  // An estimated date must never pass itself off as the journal's own. Someone
  // rearranging a clinic around a date deserves to know who set it.
  const title = isEstimated(m)
    ? `Due ${exact}. Estimated from this journal's usual window — the email did not give a date.`
    : isPinned(m, "deadline")
    ? `Due ${exact}, set by hand.`
    : `Due ${exact}, as stated by the journal.`;
  return `<span class="deadline-chip ${deadlineLevel(m.deadline)}" title="${esc(title)}">⏳ ${esc(deadlineText(m.deadline))}${isEstimated(m) ? "*" : ""}</span>`;
}

/** "2026-09-12" -> the last instant of 12 September, where the group is. */
function endOfLocalDay(yyyymmdd) {
  const [y, mo, d] = yyyymmdd.split("-").map(Number);
  if (!y || !mo || !d) return "";
  return new Date(Date.UTC(y, mo - 1, d, 23, 59, 59, 999) - ZONE_MS).toISOString();
}

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

function fmtDate(iso) {
  if (!iso) return "—";
  const d = new Date(iso);
  if (isNaN(d)) return "—";
  return d.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
}
// The sync runs every three hours, so the card-level "today / 3d ago" scale is
// far too coarse to tell a healthy tracker from a stalled one. This one reads
// in minutes and hours.
const SYNC_EVERY_HOURS = 3;
function fmtAge(iso) {
  const d = new Date(iso);
  if (isNaN(d)) return null;
  const mins = Math.round((Date.now() - d.getTime()) / 60000);
  if (mins < 0) return "just now";           // clock skew between runner and viewer
  if (mins < 2) return "just now";
  if (mins < 60) return `${mins} min ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return hrs === 1 ? "1 hour ago" : `${hrs} hours ago`;
  const days = Math.floor(hrs / 24);
  return days === 1 ? "1 day ago" : `${days} days ago`;
}

/**
 * Judge the age against the schedule rather than against a fixed clock: one
 * missed run is worth a warning, several means the sync has stopped -- most
 * likely an expired Gmail token, which is the failure this is here to catch.
 */
function syncHealth(iso) {
  const d = new Date(iso);
  if (isNaN(d)) return "unknown";
  const hrs = (Date.now() - d.getTime()) / 3600000;
  if (hrs <= SYNC_EVERY_HOURS + 1) return "fresh";
  if (hrs <= SYNC_EVERY_HOURS * 3) return "late";
  return "stale";
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

function renderSyncStatus(iso, failure) {
  const el = $("#generated-at");
  if (!el) return;
  const dot = el.querySelector(".sync-dot");
  const text = el.querySelector(".sync-text");
  el.classList.remove("fresh", "late", "stale");

  if (failure || !iso) {
    if (text) text.textContent = failure || "Not yet synced";
    el.title = failure ? "The dashboard could not read its data file." : "No sync has run yet.";
    return;
  }

  const health = syncHealth(iso);
  el.classList.add(health);
  const age = fmtAge(iso);
  if (text) text.textContent = `Last synced ${age}`;

  const exact = new Date(iso).toLocaleString(undefined, {
    weekday: "short", day: "numeric", month: "short",
    hour: "2-digit", minute: "2-digit",
  });
  const note =
    health === "fresh" ? `Checked ${exact}. Running on schedule, every ${SYNC_EVERY_HOURS} hours.`
    : health === "late" ? `Checked ${exact}. A scheduled run looks to have been missed.`
    : `Checked ${exact}. The sync appears to have stopped — check the Gmail token and the workflow runs.`;
  el.title = note;
  if (dot) dot.setAttribute("title", note);
}

// Kept ticking so a tab left open overnight does not keep claiming the data is
// minutes old.
let syncTicker = null;
function startSyncTicker(iso) {
  if (syncTicker) clearInterval(syncTicker);
  if (!iso) return;
  syncTicker = setInterval(() => renderSyncStatus(iso), 60000);
}

async function load() {
  try {
    const res = await fetch("data/manuscripts.json?_=" + Date.now());
    const data = await res.json();
    state.manuscripts = data.manuscripts || [];
    state.generatedAt = data.generatedAt || null;
    renderSyncStatus(data.generatedAt);
    startSyncTicker(data.generatedAt);
  } catch (err) {
    renderSyncStatus(null, "Could not load data");
    console.error(err);
  }

  // A missing or empty review queue is normal, not an error.
  try {
    const res = await fetch("data/review-queue.json?_=" + Date.now());
    state.review = (await res.json()).review || [];
  } catch {
    state.review = [];
  }

  renderCounts();
  selectBucket(location.hash.replace("#", "") || "all");
}

/** Select a filter and sync the nav, so a bucket can be reached by URL hash too. */
function selectBucket(bucket) {
  if (!BUCKET_HINTS[bucket]) bucket = "all";
  state.bucket = bucket;
  $$(".bucket-btn").forEach((b) => b.classList.toggle("active", b.dataset.bucket === bucket));
  render();
}

/** Review items that never became a manuscript, so have no card of their own. */
function unfiledReview() {
  return state.review.filter((r) => r.relevant !== true);
}

/** Why a filed manuscript was flagged, matched back from the review queue. */
function reviewReasonFor(m) {
  const hit = state.review.find(
    (r) => r.relevant === true && r.title && m.title && r.title.trim() === m.title.trim()
  );
  return hit?.reason || "Flagged during classification — verify this record.";
}

function counts() {
  const c = { all: state.manuscripts.length, submissions: 0, needs_action: 0, in_review: 0, published: 0 };
  for (const m of state.manuscripts) if (c[m.bucket] !== undefined) c[m.bucket]++;
  c.review = state.manuscripts.filter((m) => m.needsReview).length + unfiledReview().length;
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
  return state.manuscripts.filter((m) => {
    const inBucket =
      state.bucket === "all" ||
      (state.bucket === "review" ? m.needsReview : m.bucket === state.bucket);
    return inBucket && matchesQuery(m, state.query);
  });
}

function matchesReviewQuery(r, q) {
  if (!q) return true;
  return [r.title, r.journal, r.subject, r.from, r.reason]
    .join(" ")
    .toLowerCase()
    .includes(q.toLowerCase());
}

/**
 * A review item with no manuscript behind it. Rendered plainly and marked
 * "not filed" so it can never be mistaken for a tracked submission.
 */
function reviewCardHtml(r) {
  return `
  <article class="card b-review review-card" tabindex="0">
    <div class="card-top">
      <span class="pill review">Not filed</span>
      <span class="action-flag">⚑ Needs review</span>
    </div>
    <h3 class="card-title">${esc(r.title || r.subject || "(no subject)")}</h3>
    <div class="card-meta">
      ${r.journal ? `<div class="row"><span class="lbl">Journal</span><span>${esc(r.journal)}</span></div>` : ""}
      <div class="row"><span class="lbl">From</span><span>${esc(r.from || "—")}</span></div>
      <div class="row"><span class="lbl">Why</span><span style="color:var(--needs)">${esc(r.reason || "")}</span></div>
    </div>
    <div class="card-foot">
      <span class="card-when">${esc(fmtDate(r.timestamp))}</span>
      <span class="card-accounts">${
        r.account
          ? `<span class="avatar" style="background:${avatarColor(r.account)}" title="${esc(r.account)}">${esc(initials(r.account))}</span>`
          : ""
      }</span>
    </div>
  </article>`;
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
      ${deadlineChip(m)}
      ${m.needsReview ? `<span class="review-flag" title="${esc(reviewReasonFor(m))}">⚑ Check</span>` : ""}
    </div>
    <h3 class="card-title">${esc(m.title)}</h3>
    <div class="card-meta">
      <div class="row"><span class="lbl">Journal</span><span>${esc(m.currentJournal || "—")}</span></div>
      <div class="row"><span class="lbl">Status</span><span>${esc(m.currentStatus || "—")}</span></div>
      ${m.needsReview ? `<div class="row"><span class="lbl">Check</span><span style="color:var(--needs)">${esc(reviewReasonFor(m))}</span></div>` : ""}
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

  // The review view also surfaces items that never became a manuscript.
  const extras =
    state.bucket === "review"
      ? unfiledReview().filter((r) => matchesReviewQuery(r, state.query))
      : [];

  if (!list.length && !extras.length) {
    cards.innerHTML = "";
    empty.hidden = false;
    empty.innerHTML = state.bucket === "review"
      ? `<h3>Nothing to review</h3><p>Every email was classified confidently. Anything the classifier is unsure about lands here instead of being guessed at.</p>`
      : state.manuscripts.length
      ? `<h3>Nothing here</h3><p>No manuscripts match this filter${state.query ? " and search" : ""}.</p>`
      : `<h3>No manuscripts yet</h3><p>Once the Gmail sync runs, your tracked manuscripts will appear here.</p>`;
    return;
  }
  empty.hidden = true;
  cards.innerHTML = list.map(cardHtml).join("") + extras.map(reviewCardHtml).join("");
}

// A pinned field is one the sync is no longer allowed to touch. That is a
// real change in how the record behaves, so it is marked wherever the value is
// shown rather than only inside the edit form.
const PIN_TITLE = "Set by hand — the email sync will not change this";
const pinMark = (m, field) =>
  isPinned(m, field) ? ` <span class="pin-mark" title="${PIN_TITLE}">set by hand</span>` : "";

function drawerHtml(m) {
  const pill = BUCKET_META[m.bucket];
  const attnReason = m.needsActionReason ? NEEDS_ACTION_REASON[m.needsActionReason] : null;
  const lastEdit = (m.edits || [])[m.edits?.length - 1];

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

  const notes = m.notes
    ? `<div class="d-notes"><span class="d-notes-lab">Notes${pinMark(m, "notes")}</span><p>${esc(m.notes)}</p></div>`
    : "";

  return `
    <h2 class="d-title">${esc(m.title)}${pinMark(m, "title")}</h2>
    <div class="d-status-row">
      <span class="pill ${pill.pill}">${esc(pill.label)}</span>
      ${isPinned(m, "bucket") ? `<span class="pin-mark" title="${PIN_TITLE}">moved by hand</span>` : ""}
      ${m.actionFlag ? `<span class="action-flag">● ${esc(m.actionLabel || "Action")}</span>` : ""}
      ${deadlineChip(m)}
      ${attnReason ? `<span class="pill needs_action">${esc(attnReason)}</span>` : ""}
    </div>
    ${doiBox}
    ${notes}
    <dl class="d-facts">
      <dt>Current journal</dt><dd>${esc(m.currentJournal || "—")}${pinMark(m, "currentJournal")}</dd>
      <dt>Current status</dt><dd>${esc(m.currentStatus || "—")}${pinMark(m, "currentStatus")}</dd>
      ${m.currentManuscriptNumber ? `<dt>Manuscript no.</dt><dd>${esc(m.currentManuscriptNumber)}${pinMark(m, "currentManuscriptNumber")}</dd>` : ""}
      ${m.deadline && m.actionFlag ? `<dt>Due back</dt><dd class="d-deadline ${deadlineLevel(m.deadline)}">${esc(new Date(m.deadline).toLocaleDateString(undefined, { weekday: "short", day: "numeric", month: "short", year: "numeric" }))} · ${esc(deadlineText(m.deadline))}${pinMark(m, "deadline")}${isEstimated(m) ? `<span class="d-estimated">Estimated from this journal's usual window — the email did not give a date. Correct it with Edit if you know better.</span>` : ""}</dd>` : ""}
      <dt>Author inbox</dt><dd>${esc((m.authorAccounts || []).join(", ") || "—")}</dd>
      <dt>First tracked</dt><dd>${esc(fmtDate(m.createdAt))}</dd>
      <dt>Last update</dt><dd>${esc(fmtDate(m.updatedAt))}</dd>
      ${lastEdit ? `<dt>Edited by hand</dt><dd>${esc(fmtDate(lastEdit.at))}</dd>` : ""}
    </dl>

    <div class="d-section-label">Submission thread (${(m.submissions || []).length})</div>
    <div class="chain">${chain}</div>

    <div class="d-section-label">Status timeline</div>
    <div class="timeline">${timeline}</div>
  `;
}

/**
 * The edit form.
 *
 * Two things here are worth more than they look. The first is the section
 * picker's "Automatic" chip: without it, one move by hand would freeze a
 * manuscript in that section forever, since the sync is then forbidden from
 * moving it. The second is the per-field "use automatic again" button, which
 * is the same escape hatch for everything else.
 */
function editFormHtml(m) {
  const releaseBtn = (field) =>
    isPinned(m, field)
      ? `<button type="button" class="edit-release" data-release="${field}">use automatic again</button>`
      : "";

  const sections = SECTIONS.map((s) => `
    <button type="button" class="section-chip ${m.bucket === s.bucket ? "active" : ""}"
            data-bucket="${s.bucket}" aria-pressed="${m.bucket === s.bucket}">
      <span class="bucket-icon ${s.bucket}">${BUCKET_ICON[s.bucket]}</span>${esc(s.label)}
    </button>`).join("");

  const fields = FIELDS.map((f) => {
    // A date input speaks yyyy-mm-dd; the record holds the last moment of that
    // day as a real instant, so convert through the group's own calendar or
    // the box shows the day before for anything set in the evening.
    const raw = f.type === "date" && m[f.field]
      ? new Date(new Date(m[f.field]).getTime() + ZONE_MS).toISOString().slice(0, 10)
      : m[f.field] || "";
    const value = esc(raw);
    const input = f.type === "textarea"
      ? `<textarea name="${f.field}" rows="${f.field === "title" ? 3 : 4}" placeholder="${esc(f.placeholder || "")}">${value}</textarea>`
      : `<input name="${f.field}" type="${f.type}" value="${value}" placeholder="${esc(f.placeholder || "")}" />`;
    return `
      <div class="edit-field" data-field="${f.field}">
        <div class="edit-label-row">
          <label for="${f.field}">${esc(f.label)}</label>
          ${isPinned(m, f.field) ? `<span class="pin-mark" title="${PIN_TITLE}">set by hand</span>` : ""}
          ${releaseBtn(f.field)}
        </div>
        ${input}
        ${f.help ? `<p class="edit-help">${esc(f.help)}</p>` : ""}
      </div>`;
  }).join("");

  return `
    <form id="edit-form" class="edit-form">
      <h2 class="d-title">Edit this manuscript</h2>
      <p class="edit-intro">
        Anything you set here outranks the email sync: it will be left exactly as you
        put it, however the next email from the journal reads. Hand a field back with
        <b>use automatic again</b>.
      </p>

      <div class="edit-field" data-field="bucket">
        <div class="edit-label-row">
          <label>Section</label>
          ${isPinned(m, "bucket") ? `<span class="pin-mark" title="${PIN_TITLE}">moved by hand</span>` : ""}
          ${releaseBtn("bucket")}
        </div>
        <div class="section-picker">${sections}</div>
      </div>

      ${fields}

      <p id="edit-error" class="lock-error" hidden role="alert"></p>
      <div class="edit-actions">
        <button type="button" id="edit-cancel" class="sync-close">Cancel</button>
        <button type="submit" id="edit-save" class="lock-btn">Save changes</button>
      </div>
    </form>`;
}

const BUCKET_ICON = { submissions: "↑", needs_action: "!", in_review: "◷", published: "✓" };

// The manuscript on screen, and which of its fields the person has asked to
// hand back to automation during this edit.
let drawerId = null;
let editing = null;

function openDrawer(id) {
  const m = state.manuscripts.find((x) => x.id === id);
  if (!m) return;
  drawerId = id;
  editing = null;
  renderDrawer();
  $("#drawer").hidden = false;
  $("#drawer-overlay").hidden = false;
  document.body.style.overflow = "hidden";
}

function renderDrawer() {
  const m = state.manuscripts.find((x) => x.id === drawerId);
  if (!m) return closeDrawer();
  const editBtn = $("#drawer-edit");
  if (editing) {
    $("#drawer-body").innerHTML = editFormHtml(m);
    editBtn.hidden = true;
    wireEditForm(m);
  } else {
    $("#drawer-body").innerHTML = drawerHtml(m);
    // Offered only where it can actually work. Somewhere with no sync service
    // has nowhere to save to, and a button that always fails is worse than none.
    const available = editingAvailable();
    editBtn.hidden = !available.ok;
    editBtn.title = available.ok ? "Correct a field or move this to another section" : available.reason;
  }
}

function wireEditForm(m) {
  const form = $("#edit-form");

  form.querySelector(".section-picker").addEventListener("click", (e) => {
    const chip = e.target.closest(".section-chip");
    if (!chip) return;
    $$(".section-chip", form).forEach((c) => {
      const on = c === chip;
      c.classList.toggle("active", on);
      c.setAttribute("aria-pressed", String(on));
    });
    // Choosing a section is the opposite of handing it back.
    editing.dirty = true;
    editing.released.delete("bucket");
    form.querySelector('[data-field="bucket"]').classList.remove("released");
  });

  form.addEventListener("click", (e) => {
    const btn = e.target.closest(".edit-release");
    if (!btn) return;
    const field = btn.dataset.release;
    const wrap = form.querySelector(`[data-field="${field}"]`);
    const releasing = !editing.released.has(field);
    editing.dirty = true;
    if (releasing) editing.released.add(field);
    else editing.released.delete(field);
    wrap.classList.toggle("released", releasing);
    btn.textContent = releasing ? "keep it set by hand" : "use automatic again";
    const input = wrap.querySelector("input, textarea");
    if (input) input.disabled = releasing;
  });

  form.addEventListener("input", () => { editing.dirty = true; });
  $("#edit-cancel").addEventListener("click", () => {
    if (editing.dirty && !confirm("Discard the changes you have not saved?")) return;
    editing = null;
    renderDrawer();
  });
  form.addEventListener("submit", (e) => { e.preventDefault(); void submitEdit(m); });
}

async function submitEdit(m) {
  const form = $("#edit-form");
  const error = $("#edit-error");
  const save = $("#edit-save");

  const values = { bucket: form.querySelector(".section-chip.active")?.dataset.bucket || m.bucket };
  for (const f of FIELDS) {
    const typed = form.querySelector(`[name="${f.field}"]`).value;
    // A deadline is a day you have until the end of, so a date picked here
    // becomes that day's last moment rather than its first.
    values[f.field] = f.type === "date" && typed ? endOfLocalDay(typed) : typed;
  }

  const patch = diff(m, values, editing.released);
  if (!Object.keys(patch).length) { editing = null; renderDrawer(); return; }

  error.hidden = true;
  save.disabled = true;
  save.textContent = "Saving…";
  try {
    const result = await saveEdit(m.id, patch);
    // Show the saved record straight away. The commit takes a minute or two to
    // reach the served copy of data/manuscripts.json, and re-reading that file
    // in the meantime would show the edit vanishing and then reappearing.
    if (result.manuscript) {
      const i = state.manuscripts.findIndex((x) => x.id === m.id);
      if (i >= 0) state.manuscripts[i] = result.manuscript;
    }
    editing = null;
    // A move changes what each section holds, so the counts and the current
    // filter both have to be redrawn, not just the card.
    renderCounts();
    render();
    renderDrawer();
  } catch (err) {
    if (err.code === "auth") {
      // The password was never typed this session, or the proxy rejected it.
      save.disabled = false;
      save.textContent = "Save changes";
      if (await askForToken()) void submitEdit(m);
      return;
    }
    error.textContent = err.message || "The change could not be saved.";
    error.hidden = false;
    save.disabled = false;
    save.textContent = "Save changes";
    console.error(err);
  }
}

function closeDrawer() {
  $("#drawer").hidden = true;
  $("#drawer-overlay").hidden = true;
  $("#drawer-edit").hidden = true;
  drawerId = null;
  editing = null;
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
    selectBucket(btn.dataset.bucket);
    if (history.replaceState) history.replaceState(null, "", `#${btn.dataset.bucket}`);
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
  $("#drawer-edit").addEventListener("click", () => {
    editing = { released: new Set(), dirty: false };
    renderDrawer();
  });
  // Closing mid-edit would throw away what someone has typed, and the drawer
  // closes on a click anywhere outside it — far too easy to do by accident.
  const leaveDrawer = () => {
    if (editing?.dirty && !confirm("Discard the changes you have not saved?")) return;
    if (editing) { editing = null; renderDrawer(); return; }
    closeDrawer();
  };
  $("#drawer-close").addEventListener("click", leaveDrawer);
  $("#drawer-overlay").addEventListener("click", leaveDrawer);
  document.addEventListener("keydown", (e) => {
    if (e.key !== "Escape" || $("#drawer").hidden) return;
    leaveDrawer();
  });
  $("#theme-btn").addEventListener("click", toggleTheme);
}

const fmtClock = (secs) => {
  const s = Math.max(0, Math.round(secs));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
};

const RING_CIRCUMFERENCE = 2 * Math.PI * 52;

function setRing(fraction) {
  const fill = $("#sync-ring-fill");
  if (fill) fill.style.strokeDashoffset = String(RING_CIRCUMFERENCE * (1 - fraction));
}

function askForToken({ forceToken = false } = {}) {
  return new Promise((resolve) => {
    const modal = $("#token-modal");
    // forceToken is the fallback route: a proxy is configured but unreachable,
    // so this browser needs its own token after all.
    const proxyMode = usingProxy() && !forceToken;
    modal.classList.toggle("proxy-mode", proxyMode);
    const form = $("#token-form");
    const input = $("#token-input");
    const error = $("#token-error");
    modal.hidden = false;
    error.hidden = true;
    input.value = "";
    setTimeout(() => input.focus(), 60);

    const finish = (value) => {
      modal.hidden = true;
      form.onsubmit = null;
      $("#token-cancel").onclick = null;
      resolve(value);
    };
    form.onsubmit = (e) => {
      e.preventDefault();
      const value = input.value.trim();
      if (!value) {
        error.textContent = proxyMode ? "Enter the dashboard password." : "Paste the token to continue.";
        error.hidden = false;
        return;
      }
      if (proxyMode) rememberPassphrase(value);
      else setToken(value);
      finish(value);
    };
    $("#token-cancel").onclick = () => finish(null);
  });
}

let syncing = false;
async function onSyncNow({ forceOwnToken = false } = {}) {
  if (syncing) return;
  const needsToken = forceOwnToken || !usingProxy();
  if (needsToken && !hasOwnToken() && !(await askForToken({ forceToken: true }))) return;
  if (!needsToken && !hasToken() && !(await askForToken())) return;

  syncing = true;
  const btn = $("#sync-btn");
  const modal = $("#sync-modal");
  const panel = modal.querySelector(".sync-panel");
  const phase = $("#sync-phase");
  const detail = $("#sync-detail");
  const remaining = $("#sync-remaining");
  const link = $("#sync-run-link");
  const closeBtn = $("#sync-close");
  const forgetBtn = $("#sync-forget");

  btn.disabled = true;
  btn.classList.add("busy");
  panel.classList.remove("done", "failed");
  link.hidden = true;
  closeBtn.hidden = true;
  forgetBtn.hidden = true;
  forgetBtn.textContent = "Use a different GitHub token";
  forgetBtn.dataset.action = "";
  modal.hidden = false;
  setRing(0);
  remaining.textContent = "—";
  phase.textContent = "Syncing…";
  detail.textContent = "Asking GitHub to start the sync.";

  const previous = state.generatedAt;
  const finish = (ok, message) => {
    panel.classList.add(ok ? "done" : "failed");
    phase.textContent = ok ? "Sync complete" : "Sync did not finish";
    detail.textContent = message;
    closeBtn.hidden = false;
    // Meaningless when a proxy holds the token: there is nothing per-device
    // to replace.
    forgetBtn.hidden = usingProxy() || !hasToken();
    btn.disabled = false;
    btn.classList.remove("busy");
    syncing = false;
  };

  try {
    const result = await runSync(({ phase: p, elapsed, remaining: left, fraction }) => {
      setRing(fraction);
      remaining.textContent = fmtClock(left);
      if (p === "running") {
        phase.textContent = "Syncing…";
        detail.textContent = `Reading new email and filing what it finds · ${fmtClock(elapsed)} elapsed`;
      }
    }, { forceOwnToken });

    setRing(1);
    remaining.textContent = "0:00";
    phase.textContent = "Finishing up";
    detail.textContent = "The run finished. Waiting for the updated data to appear.";
    if (result.runUrl) { link.href = result.runUrl; link.hidden = false; }

    const fresh = await waitForFreshData(previous);
    if (fresh) {
      await load();
      finish(true, `Done in ${fmtClock(result.elapsed)}. The tracker is up to date.`);
    } else {
      // The run succeeded; only the published copy is lagging.
      finish(true, "The sync ran successfully. The updated data has not appeared yet — reload in a minute.");
    }
  } catch (err) {
    if (err.code === "proxy-unreachable") {
      finish(false, err.message);
      forgetBtn.hidden = false;
      forgetBtn.textContent = "Sync with my own GitHub token instead";
      forgetBtn.dataset.action = "own-token";
      console.error(err);
      return;
    }
    if (err.code === "auth") {
      if (usingProxy()) {
        modal.hidden = true;
        btn.disabled = false;
        btn.classList.remove("busy");
        syncing = false;
        if (await askForToken()) onSyncNow();
        return;
      }
      setToken(null);
      finish(false, err.message + " Press Sync now again to enter a new one.");
    } else {
      finish(false, err.message || "Something went wrong starting the sync.");
    }
    if (err.runUrl) { link.href = err.runUrl; link.hidden = false; }
    console.error(err);
  }
}

function wireSync() {
  $("#sync-btn")?.addEventListener("click", onSyncNow);
  $("#sync-close")?.addEventListener("click", () => { $("#sync-modal").hidden = true; });
  $("#sync-forget")?.addEventListener("click", async (e) => {
    const btn = e.currentTarget;
    $("#sync-modal").hidden = true;
    if (btn.dataset.action === "own-token") {
      btn.dataset.action = "";
      onSyncNow({ forceOwnToken: true });
      return;
    }
    setToken(null);
    if (await askForToken()) onSyncNow();
  });
}

// Nothing renders, and no data is fetched, until the gate is passed.
// Config first: whether a sync proxy is in use decides what the sync button
// asks for, so nothing may run before it is known.
loadConfig()
  .then(() => requireUnlock((password) => rememberPassphrase(password)))
  .then(() => {
    initTheme();
    wire();
    wireSync();
    load();
  });
