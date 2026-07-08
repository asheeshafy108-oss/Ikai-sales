// ikai-sales dashboard client.
const $ = (id) => document.getElementById(id);

let STATE = { me: null, stages: [], leads: [], parsedRows: [] };

// ---------- api ----------
async function api(url, opts = {}) {
  const r = await fetch(url, {
    headers: { "content-type": "application/json" },
    ...opts,
  });
  if (r.status === 401) {
    location.href = "/";
    throw new Error("unauthorized");
  }
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(data.error || "Request failed");
  return data;
}

// ---------- helpers ----------
function money(cents) {
  if (cents == null) return "—";
  return "$" + (cents / 100).toLocaleString(undefined, { minimumFractionDigits: 0, maximumFractionDigits: 2 });
}
function daysSince(iso) {
  const d = Math.floor((Date.now() - new Date(iso).getTime()) / 86400_000);
  return d <= 0 ? "today" : d === 1 ? "1 day" : d + " days";
}
function escapeHtml(s) {
  return String(s == null ? "" : s).replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]),
  );
}
function stageName(id) {
  const s = STATE.stages.find((x) => x.id === id);
  return s ? s.name : "—";
}
function sourceChipClass(src) {
  return "chip " + (["csv", "demo"].includes(src) ? src : "");
}
const showMsg = (el, text, ok) => { el.className = "msg " + (ok ? "ok" : "error"); el.textContent = text; };
const clearMsg = (el) => { el.className = "msg"; el.textContent = ""; };

// ---------- overlays ----------
function openOverlay(id) { $(id).classList.remove("hidden"); }
function closeOverlay(id) { $(id).classList.add("hidden"); }
document.querySelectorAll("[data-close]").forEach((b) => {
  b.onclick = () => closeOverlay(b.getAttribute("data-close"));
});
document.querySelectorAll(".overlay").forEach((ov) => {
  ov.addEventListener("click", (e) => { if (e.target === ov) ov.classList.add("hidden"); });
});

// ---------- load ----------
async function load() {
  const me = await api("/api/me");
  STATE.me = me;
  $("tenantName").textContent = me.tenant.name;
  // hide invite generation for non-owners
  if (me.role !== "owner") $("inviteSection").classList.add("hidden");

  const data = await api("/api/leads");
  STATE.stages = data.stages;
  STATE.leads = data.leads;
  renderBoard();
  renderStageSelects();
  renderStageList();
  await loadDashboard(); // Dashboard is the default tab
}

async function loadDashboard() {
  const d = await api("/api/dashboard");
  STATE.dashboard = d;
  if (d.stages) STATE.stages = d.stages;
  renderDashboard(d);
}

// ---------- tabs ----------
function showTab(name) {
  $("dashboardView").classList.toggle("hidden", name !== "dashboard");
  $("pipelineView").classList.toggle("hidden", name !== "pipeline");
  $("marketingView").classList.toggle("hidden", name !== "marketing");
  $("tabDashboard").classList.toggle("active", name === "dashboard");
  $("tabPipeline").classList.toggle("active", name === "pipeline");
  $("tabMarketing").classList.toggle("active", name === "marketing");
  if (name === "dashboard") loadDashboard().catch(() => {});
  if (name === "marketing") loadMarketing().catch(() => {});
}
document.querySelectorAll(".tab").forEach((b) => (b.onclick = () => showTab(b.dataset.tab)));

function dashboardVisible() {
  return !$("dashboardView").classList.contains("hidden");
}

function renderStageSelects() {
  const opts = STATE.stages
    .map((s) => `<option value="${s.id}">${escapeHtml(s.name)}</option>`)
    .join("");
  $("a-stage").innerHTML = opts;
  $("d-stage").innerHTML = opts;
}

function renderStageList() {
  $("stageList").innerHTML = STATE.stages
    .map((s) => `<li><span>${escapeHtml(s.name)}</span><span style="color:var(--muted)">#${s.position + 1}</span></li>`)
    .join("");
}

const SELECTED = new Set(); // lead ids currently selected on the board

function renderBoard() {
  const board = $("board");
  if (!STATE.stages.length) { board.innerHTML = '<div class="empty">No stages.</div>'; return; }
  // drop any selected ids whose lead no longer exists
  const liveIds = new Set(STATE.leads.map((l) => l.id));
  for (const id of [...SELECTED]) if (!liveIds.has(id)) SELECTED.delete(id);
  board.innerHTML = STATE.stages
    .map((stage) => {
      const leads = STATE.leads.filter((l) => l.stage_id === stage.id);
      const total = leads.reduce((sum, l) => sum + (l.value_cents || 0), 0);
      const cards = leads.length
        ? leads.map((l) => cardHtml(l, stage)).join("")
        : '<div style="color:var(--muted);font-size:12px;padding:8px;">No leads</div>';
      return `
        <div class="col">
          <div class="col-head">
            <div class="name">${escapeHtml(stage.name)}</div>
            <div class="meta">${leads.length} lead${leads.length === 1 ? "" : "s"} · ${money(total)}</div>
          </div>
          <div class="col-body">${cards}</div>
        </div>`;
    })
    .join("");

  board.querySelectorAll(".card").forEach((c) => {
    c.querySelector(".open-lead").onclick = () => openDrawer(c.dataset.id);
    const chk = c.querySelector(".lead-check");
    if (chk) {
      chk.checked = SELECTED.has(c.dataset.id);
      chk.onclick = (e) => e.stopPropagation();
      chk.onchange = () => {
        if (chk.checked) SELECTED.add(c.dataset.id); else SELECTED.delete(c.dataset.id);
        updateSelectionUI();
      };
    }
    const prev = c.querySelector(".move-prev");
    const next = c.querySelector(".move-next");
    if (prev) prev.onclick = (e) => { e.stopPropagation(); moveLead(c.dataset.id, -1); };
    if (next) next.onclick = (e) => { e.stopPropagation(); moveLead(c.dataset.id, 1); };
  });
  updateSelectionUI();
}

// ---------- selection + export ----------
function updateSelectionUI() {
  const n = SELECTED.size;
  const total = STATE.leads.length;
  $("selCount").textContent = n ? `${n} selected` : "";
  $("exportSelected").classList.toggle("hidden", n === 0);
  $("exportAll").disabled = total === 0;
  const all = $("selectAll");
  all.checked = total > 0 && n === total;
  all.indeterminate = n > 0 && n < total;
}

$("selectAll").onchange = () => {
  const check = $("selectAll").checked;
  SELECTED.clear();
  if (check) STATE.leads.forEach((l) => SELECTED.add(l.id));
  document.querySelectorAll(".lead-check").forEach((cb) => { cb.checked = check; });
  updateSelectionUI();
};

async function runExport(payload, btn) {
  const label = btn.textContent;
  btn.disabled = true; btn.textContent = "Exporting…";
  try {
    const data = await api("/api/leads/export", { method: "POST", body: JSON.stringify(payload) });
    showToast(`Export sent to ${data.email}`);
    // clear selection after a selected-export
    if (!payload.all) { SELECTED.clear(); document.querySelectorAll(".lead-check").forEach((cb) => (cb.checked = false)); updateSelectionUI(); }
  } catch (err) {
    showToast(err.message || "Export failed", true);
  } finally {
    btn.disabled = false; btn.textContent = label;
  }
}
$("exportSelected").onclick = () => runExport({ lead_ids: [...SELECTED] }, $("exportSelected"));
$("exportAll").onclick = () => runExport({ all: true }, $("exportAll"));

let toastTimer = null;
function showToast(text, isError) {
  const t = $("toast");
  t.textContent = text;
  t.className = "toast show" + (isError ? " error" : "");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.className = "toast"; }, 4500);
}

function cardHtml(lead, stage) {
  const idx = STATE.stages.findIndex((s) => s.id === stage.id);
  const canPrev = idx > 0;
  const canNext = idx < STATE.stages.length - 1;
  return `
    <div class="card" data-id="${lead.id}">
      <label class="lead-select" title="Select lead"><input type="checkbox" class="lead-check" data-id="${lead.id}"></label>
      <div class="open-lead">
        <div class="lead-name">${escapeHtml(lead.name)}</div>
        ${lead.company ? `<div class="lead-company">${escapeHtml(lead.company)}</div>` : ""}
        <div class="lead-row">
          <span class="${sourceChipClass(lead.source)}">${escapeHtml(lead.source)}</span>
          <span class="lead-value">${money(lead.value_cents)}</span>
        </div>
        <div class="days">In stage ${daysSince(lead.stage_since || lead.created_at)}</div>
      </div>
      <div class="card-actions">
        <button class="btn ghost sm move-prev" ${canPrev ? "" : "disabled"}>◀</button>
        <button class="btn ghost sm move-next" ${canNext ? "" : "disabled"}>▶</button>
      </div>
    </div>`;
}

// ---------- dashboard rendering ----------
function relTime(iso) {
  const s = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 60) return "just now";
  const m = Math.floor(s / 60); if (m < 60) return m + "m ago";
  const h = Math.floor(m / 60); if (h < 24) return h + "h ago";
  const d = Math.floor(h / 24); if (d < 7) return d + "d ago";
  const w = Math.floor(d / 7); if (w < 5) return w + "w ago";
  return new Date(iso).toLocaleDateString();
}

const SOURCE_COLORS = { manual: "#6366f1", csv: "#34d399", demo: "#fbbf24", booking: "#a5b4fc", call: "#f472b6", google: "#60a5fa", linkedin: "#0a66c2", meta: "#a78bfa", email: "#f59e0b", sms: "#22d3ee", web: "#94a3b8" };
const sourceColor = (s) => SOURCE_COLORS[s] || "#94a3b8";

function renderDashboard(d) {
  renderKpiRow(d.kpis);
  renderFunnel(d.funnel);
  renderFlow(d.weekly);
  renderSource(d.sources);
  renderStale(d.stale);
  renderActivity(d.activity);
}

function deltaHtml(cur, prev) {
  if (prev === 0) return cur > 0 ? `<span class="delta up">▲ new</span>` : `<span class="delta flat">–</span>`;
  const pct = Math.round(((cur - prev) / prev) * 100);
  const cls = pct > 0 ? "up" : pct < 0 ? "down" : "flat";
  const arrow = pct > 0 ? "▲" : pct < 0 ? "▼" : "–";
  return `<span class="delta ${cls}">${arrow} ${Math.abs(pct)}%</span>`;
}

function renderKpiRow(k) {
  const n = k.won_all + k.lost_all;
  const winRate = n === 0 ? "—" : Math.round((k.won_all / n) * 100) + "%";
  const cards = [
    { label: "Open pipeline value", value: money(k.open_value_cents), sub: `${k.open_count} open lead${k.open_count === 1 ? "" : "s"}` },
    { label: "Leads added · 30d", value: k.leads_added_30, sub: `vs ${k.leads_added_prev_30} prior · ${deltaHtml(k.leads_added_30, k.leads_added_prev_30)}` },
    { label: "Won this month", value: `${k.won_this_month_count}`, sub: `${money(k.won_this_month_value)} · ${deltaHtml(k.won_this_month_count, k.won_last_month_count)}` },
    { label: "Win rate", value: winRate, sub: n === 0 ? "no closed deals yet" : `${k.won_all} won / ${n} closed` },
  ];
  $("kpiRow").innerHTML = cards
    .map((c) => `<div class="kpi-card"><div class="k-label">${c.label}</div><div class="k-value">${c.value}</div><div class="k-sub">${c.sub}</div></div>`)
    .join("");
}

function renderFunnel(funnel) {
  const el = $("funnelChart");
  const total = funnel.reduce((s, f) => s + f.count, 0);
  if (!total) { el.innerHTML = '<div class="panel-empty">No leads yet — add your first lead to populate the funnel.</div>'; return; }
  const max = Math.max(1, ...funnel.map((f) => f.count));
  el.innerHTML = funnel
    .map((f) => {
      const pct = (f.count / max) * 100;
      return `<div class="funnel-row">
        <div class="funnel-label" title="${escapeHtml(f.name)}">${escapeHtml(f.name)}</div>
        <svg class="bar" viewBox="0 0 100 16" preserveAspectRatio="none">
          <rect x="0" y="0" width="100" height="16" fill="#1b2342"/>
          <rect x="0" y="0" width="${pct.toFixed(2)}" height="16" fill="#6366f1"/>
        </svg>
        <div class="funnel-val"><b>${f.count}</b> · ${money(f.value)}</div>
      </div>`;
    })
    .join("");
}

function renderFlow(weekly) {
  const el = $("flowChart");
  const created = weekly.created, won = weekly.won;
  const totalActivity = created.reduce((s, v) => s + v, 0) + won.reduce((s, v) => s + v, 0);
  const maxVal = Math.max(1, ...created, ...won);
  const W = 320, H = 150, padL = 22, padR = 10, padT = 12, padB = 22, n = created.length;
  const x = (i) => padL + (i * (W - padL - padR)) / (n - 1);
  const y = (v) => padT + (1 - v / maxVal) * (H - padT - padB);
  const line = (arr, color) => {
    const pts = arr.map((v, i) => `${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(" ");
    const dots = arr.map((v, i) => `<circle cx="${x(i).toFixed(1)}" cy="${y(v).toFixed(1)}" r="2.5" fill="${color}"/>`).join("");
    return `<polyline fill="none" stroke="${color}" stroke-width="2" points="${pts}"/>${dots}`;
  };
  const grid = `
    <line x1="${padL}" y1="${y(0)}" x2="${W - padR}" y2="${y(0)}" stroke="#26305a" stroke-width="1"/>
    <line x1="${padL}" y1="${y(maxVal)}" x2="${W - padR}" y2="${y(maxVal)}" stroke="#26305a" stroke-width="0.5" stroke-dasharray="3 3"/>
    <text x="2" y="${(y(maxVal) + 3).toFixed(1)}" fill="#9aa3c7" font-size="8">${maxVal}</text>
    <text x="2" y="${(y(0) + 3).toFixed(1)}" fill="#9aa3c7" font-size="8">0</text>`;
  const xlabels = created
    .map((_, i) => {
      const weeksAgo = n - 1 - i;
      const lbl = weeksAgo === 0 ? "now" : `-${weeksAgo}w`;
      return i % 2 === 0 || i === n - 1
        ? `<text x="${x(i).toFixed(1)}" y="${H - 6}" fill="#9aa3c7" font-size="8" text-anchor="middle">${lbl}</text>`
        : "";
    })
    .join("");
  el.innerHTML = `<svg class="chart-svg" viewBox="0 0 ${W} ${H}">${grid}${line(created, "#6366f1")}${line(won, "#a5b4fc")}${xlabels}</svg>`;
  $("flowLegend").innerHTML = totalActivity
    ? `<span><span class="dot" style="background:#6366f1"></span>Created</span><span><span class="dot" style="background:#a5b4fc"></span>Won</span>`
    : `<span>No leads created or won in the last 8 weeks.</span>`;
}

function renderSource(sources) {
  const el = $("sourceChart");
  const total = sources.reduce((s, x) => s + x.count, 0);
  if (!total) { el.innerHTML = '<div class="panel-empty">No open leads to break down yet.</div>'; return; }
  const R = 40, C = 50, circ = 2 * Math.PI * R, sw = 15;
  let offset = 0;
  const segs = sources
    .filter((s) => s.count > 0)
    .map((s) => {
      const len = (s.count / total) * circ;
      const seg = `<circle cx="${C}" cy="${C}" r="${R}" fill="none" stroke="${sourceColor(s.source)}" stroke-width="${sw}" stroke-dasharray="${len.toFixed(2)} ${(circ - len).toFixed(2)}" stroke-dashoffset="${(-offset).toFixed(2)}" transform="rotate(-90 ${C} ${C})"/>`;
      offset += len;
      return seg;
    })
    .join("");
  const donut = `<svg width="100" height="100" viewBox="0 0 100 100" style="flex:0 0 auto">
     <circle cx="${C}" cy="${C}" r="${R}" fill="none" stroke="#1b2342" stroke-width="${sw}"/>
     ${segs}
     <text x="${C}" y="${C - 1}" text-anchor="middle" fill="#e6e8f2" font-size="20" font-weight="700">${total}</text>
     <text x="${C}" y="${C + 12}" text-anchor="middle" fill="#9aa3c7" font-size="7">OPEN</text>
   </svg>`;
  const legend = `<div class="source-legend">` + sources
    .map((s) => `<div class="row"><span class="lname"><span class="swatch" style="background:${sourceColor(s.source)}"></span>${s.source}</span><span>${s.count}</span></div>`)
    .join("") + `</div>`;
  el.innerHTML = `<div class="source-wrap">${donut}${legend}</div>`;
}

function renderStale(stale) {
  const el = $("staleList");
  if (!stale.length) { el.innerHTML = '<div class="panel-empty">Nothing stale — every open lead has recent activity. 🎉</div>'; return; }
  el.innerHTML = stale
    .map((s) => `<div class="mini-item">
      <div class="m-main" data-lead="${s.id}">
        <div class="m-name">${escapeHtml(s.name)}</div>
        <div class="m-sub">${escapeHtml(stageName(s.stage_id))}</div>
      </div>
      <div class="m-right warn">${s.days_silent}d silent</div>
    </div>`)
    .join("");
  el.querySelectorAll(".m-main").forEach((m) => (m.onclick = () => openDrawer(m.dataset.lead)));
}

function renderActivity(activity) {
  const el = $("activityFeed");
  if (!activity.length) { el.innerHTML = '<div class="panel-empty">No activity yet.</div>'; return; }
  el.innerHTML = activity
    .map((a) => {
      const who = escapeHtml(a.actor_name || "Someone");
      const lead = `<b>${escapeHtml(a.lead_name)}</b>`;
      let text;
      if (a.type === "created") text = `${who} added ${lead}`;
      else if (a.type === "stage_change")
        text = `${who} moved ${lead} ${escapeHtml(stageName(a.from_stage))} → ${escapeHtml(stageName(a.to_stage))}`;
      else text = `${who} noted on ${lead}: “${escapeHtml((a.note || "").slice(0, 60))}”`;
      return `<div class="feed-item"><div>${text}</div><div class="f-when">${relTime(a.created_at)}</div></div>`;
    })
    .join("");
}

// ---------- move lead ----------
async function moveLead(id, dir) {
  const lead = STATE.leads.find((l) => l.id === id);
  if (!lead) return;
  const idx = STATE.stages.findIndex((s) => s.id === lead.stage_id);
  const target = STATE.stages[idx + dir];
  if (!target) return;
  const updated = await api(`/api/leads/${id}`, {
    method: "PATCH",
    body: JSON.stringify({ stage_id: target.id }),
  });
  Object.assign(lead, updated.lead);
  lead.stage_since = new Date().toISOString(); // just entered this stage
  renderBoard();
}

// ---------- add lead ----------
$("addLeadBtn").onclick = () => { $("addForm").reset(); clearMsg($("addMsg")); openOverlay("addOverlay"); };
$("addForm").onsubmit = async (e) => {
  e.preventDefault();
  clearMsg($("addMsg"));
  try {
    const data = await api("/api/leads", {
      method: "POST",
      body: JSON.stringify({
        name: $("a-name").value,
        company: $("a-company").value,
        email: $("a-email").value,
        phone: $("a-phone").value,
        source: $("a-source").value,
        stage_id: $("a-stage").value,
        value: $("a-value").value,
        notes: $("a-notes").value,
      }),
    });
    data.lead.stage_since = data.lead.created_at;
    STATE.leads.unshift(data.lead);
    renderBoard();
    closeOverlay("addOverlay");
  } catch (err) {
    showMsg($("addMsg"), err.message);
  }
};

// ---------- drawer ----------
let currentLeadId = null;
async function openDrawer(id) {
  currentLeadId = id;
  clearMsg($("d-msg"));
  const { lead, events } = await api(`/api/leads/${id}`);
  $("d-title").textContent = lead.name;
  $("d-name").value = lead.name || "";
  $("d-company").value = lead.company || "";
  $("d-email").value = lead.email || "";
  $("d-phone").value = lead.phone || "";
  $("d-stage").value = lead.stage_id;
  $("d-value").value = lead.value_cents != null ? (lead.value_cents / 100) : "";
  $("d-notes").value = lead.notes || "";
  $("d-note-input").value = "";
  renderEvents(events);
  // reset the delete control to its default (un-confirmed) state
  $("d-delete").classList.remove("hidden");
  $("d-delete-confirm").classList.add("hidden");
  openOverlay("drawerOverlay");
}

function renderEvents(events) {
  if (!events.length) { $("d-events").innerHTML = '<div style="color:var(--muted);font-size:12px;">No history yet.</div>'; return; }
  $("d-events").innerHTML = events
    .map((ev) => {
      let text;
      if (ev.type === "created") text = "Lead created in " + escapeHtml(stageName(ev.to_stage));
      else if (ev.type === "stage_change")
        text = `Moved ${escapeHtml(stageName(ev.from_stage))} → ${escapeHtml(stageName(ev.to_stage))}`;
      else text = "Note: " + escapeHtml(ev.note);
      return `<div class="event"><div>${text}</div><div class="when">${new Date(ev.created_at).toLocaleString()}</div></div>`;
    })
    .join("");
}

$("d-save").onclick = async () => {
  clearMsg($("d-msg"));
  try {
    const data = await api(`/api/leads/${currentLeadId}`, {
      method: "PATCH",
      body: JSON.stringify({
        name: $("d-name").value,
        company: $("d-company").value,
        email: $("d-email").value,
        phone: $("d-phone").value,
        stage_id: $("d-stage").value,
        value: $("d-value").value,
        notes: $("d-notes").value,
      }),
    });
    const lead = STATE.leads.find((l) => l.id === currentLeadId);
    if (lead) Object.assign(lead, data.lead);
    renderBoard();
    showMsg($("d-msg"), "Saved", true);
    // refresh timeline (stage change may have added an event)
    const fresh = await api(`/api/leads/${currentLeadId}`);
    renderEvents(fresh.events);
    if (dashboardVisible()) loadDashboard().catch(() => {});
  } catch (err) {
    showMsg($("d-msg"), err.message);
  }
};

$("d-add-note").onclick = async () => {
  const note = $("d-note-input").value.trim();
  if (!note) return;
  clearMsg($("d-msg"));
  try {
    await api(`/api/leads/${currentLeadId}/notes`, { method: "POST", body: JSON.stringify({ note }) });
    $("d-note-input").value = "";
    const fresh = await api(`/api/leads/${currentLeadId}`);
    renderEvents(fresh.events);
    const lead = STATE.leads.find((l) => l.id === currentLeadId);
    if (lead) { lead.updated_at = new Date().toISOString(); renderBoard(); }
    if (dashboardVisible()) loadDashboard().catch(() => {});
  } catch (err) {
    showMsg($("d-msg"), err.message);
  }
};

// delete lead (two-step inline confirm — no browser dialog)
$("d-delete").onclick = () => {
  $("d-delete").classList.add("hidden");
  $("d-delete-confirm").classList.remove("hidden");
};
$("d-delete-no").onclick = () => {
  $("d-delete-confirm").classList.add("hidden");
  $("d-delete").classList.remove("hidden");
};
$("d-delete-yes").onclick = async () => {
  clearMsg($("d-msg"));
  try {
    await api(`/api/leads/${currentLeadId}`, { method: "DELETE" });
    STATE.leads = STATE.leads.filter((l) => l.id !== currentLeadId);
    renderBoard();
    closeOverlay("drawerOverlay");
    if (dashboardVisible()) loadDashboard().catch(() => {});
  } catch (err) {
    showMsg($("d-msg"), err.message);
    // re-show the confirm buttons so the user can retry or cancel
    $("d-delete-confirm").classList.remove("hidden");
  }
};

// ---------- settings ----------
$("settingsBtn").onclick = () => { clearMsg($("inviteMsg")); $("inviteResult").classList.add("hidden"); openOverlay("settingsOverlay"); };
$("genInvite").onclick = async () => {
  clearMsg($("inviteMsg"));
  try {
    const data = await api("/api/invites", { method: "POST", body: "{}" });
    $("inviteLink").value = data.link;
    $("inviteResult").classList.remove("hidden");
  } catch (err) {
    showMsg($("inviteMsg"), err.message);
  }
};
$("copyInvite").onclick = async () => {
  const input = $("inviteLink");
  input.select();
  try { await navigator.clipboard.writeText(input.value); showMsg($("inviteMsg"), "Copied to clipboard", true); }
  catch { document.execCommand("copy"); showMsg($("inviteMsg"), "Copied", true); }
};

// ---------- CSV import ----------
$("importBtn").onclick = () => {
  $("csvFile").value = "";
  $("csvPreview").innerHTML = "";
  $("confirmImport").classList.add("hidden");
  clearMsg($("importMsg"));
  STATE.parsedRows = [];
  openOverlay("importOverlay");
};

function parseCsv(text) {
  const lines = text.split(/\r?\n/).filter((l) => l.trim().length);
  if (!lines.length) return [];
  const cols = ["name", "company", "email", "phone", "value", "notes"];
  // detect header row
  let start = 0;
  const firstCells = splitCsvLine(lines[0]).map((c) => c.toLowerCase().trim());
  if (firstCells.includes("name")) start = 1;
  const rows = [];
  for (let i = start; i < lines.length; i++) {
    const cells = splitCsvLine(lines[i]);
    const row = {};
    cols.forEach((c, idx) => { row[c] = (cells[idx] || "").trim(); });
    rows.push(row);
  }
  return rows;
}

function splitCsvLine(line) {
  // simple split-based parser with basic quote handling
  const out = [];
  let cur = "";
  let inQ = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQ) {
      if (ch === '"' && line[i + 1] === '"') { cur += '"'; i++; }
      else if (ch === '"') inQ = false;
      else cur += ch;
    } else if (ch === '"') inQ = true;
    else if (ch === ",") { out.push(cur); cur = ""; }
    else cur += ch;
  }
  out.push(cur);
  return out;
}

$("csvFile").onchange = (e) => {
  const file = e.target.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = () => {
    clearMsg($("importMsg"));
    let rows;
    try { rows = parseCsv(reader.result); } catch { showMsg($("importMsg"), "Could not parse that file."); return; }
    const valid = rows.filter((r) => r.name);
    const invalid = rows.length - valid.length;
    if (!valid.length) { showMsg($("importMsg"), "No rows with a name found. Every lead needs a name."); return; }
    STATE.parsedRows = valid;
    renderCsvPreview(valid, invalid);
  };
  reader.readAsText(file);
};

function renderCsvPreview(rows, invalidCount) {
  const cols = ["name", "company", "email", "phone", "value", "notes"];
  const head = cols.map((c) => `<th>${c}</th>`).join("");
  const body = rows
    .slice(0, 5)
    .map((r) => "<tr>" + cols.map((c) => `<td>${escapeHtml(r[c])}</td>`).join("") + "</tr>")
    .join("");
  $("csvPreview").innerHTML = `
    <div style="font-size:12px;color:var(--muted);margin-top:8px;">
      Showing first ${Math.min(5, rows.length)} of ${rows.length} valid rows${invalidCount ? ` · ${invalidCount} row(s) skipped (no name)` : ""}.
    </div>
    <table><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table>`;
  $("importCount").textContent = rows.length;
  $("confirmImport").classList.remove("hidden");
}

$("confirmImport").onclick = async () => {
  clearMsg($("importMsg"));
  try {
    const data = await api("/api/leads/import", {
      method: "POST",
      body: JSON.stringify({ rows: STATE.parsedRows, source: $("i-source").value }),
    });
    closeOverlay("importOverlay");
    await load();
  } catch (err) {
    showMsg($("importMsg"), err.message);
  }
};

// ---------- marketing ----------
let marketingWired = false;
async function loadMarketing() {
  if (!marketingWired) {
    marketingWired = true;
    document.querySelectorAll("#channelTabs .subtab").forEach((b) => { b.onclick = () => showChannel(b.dataset.channel); });
  }
  try {
    renderOverview(await api("/api/marketing/overview"));
  } catch (e) {
    $("ov-channels").innerHTML = '<div class="panel-empty">Couldn\'t load overview: ' + escapeHtml(e.message) + "</div>";
  }
}

function showChannel(name) {
  document.querySelectorAll("#channelTabs .subtab").forEach((b) => b.classList.toggle("active", b.dataset.channel === name));
  ["overview", "google", "linkedin", "meta", "email", "sms"].forEach((c) => $("ch-" + c).classList.toggle("hidden", c !== name));
  if (name === "google") loadGoogle();
}

async function loadGoogle() {
  try { renderGoogle(await api("/api/marketing/google")); }
  catch (e) { renderGoogleError(e.message); }
}

function fmtTime(iso) {
  if (!iso) return "";
  try { return new Date(iso).toLocaleString(undefined, { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" }); }
  catch { return iso; }
}
function kpiCard(label, value, sub, cls) {
  return `<div class="kpi-card${cls ? " " + cls : ""}"><div class="k-label">${label}</div><div class="k-value">${value}</div><div class="k-sub">${sub}</div></div>`;
}

// single-series line chart — mirrors the dashboard flow chart
function lineChart(values, color) {
  const n = values.length;
  if (!n) return '<div class="panel-empty">No data yet.</div>';
  const W = 320, H = 150, padL = 22, padR = 10, padT = 12, padB = 22;
  const max = Math.max(1, ...values);
  const x = (i) => (n === 1 ? padL + (W - padL - padR) / 2 : padL + (i * (W - padL - padR)) / (n - 1));
  const y = (v) => padT + (1 - v / max) * (H - padT - padB);
  const pts = values.map((v, i) => `${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(" ");
  const dots = values.map((v, i) => `<circle cx="${x(i).toFixed(1)}" cy="${y(v).toFixed(1)}" r="2" fill="${color}"/>`).join("");
  const grid = `<line x1="${padL}" y1="${y(0)}" x2="${W - padR}" y2="${y(0)}" stroke="#26305a" stroke-width="1"/>
    <line x1="${padL}" y1="${y(max)}" x2="${W - padR}" y2="${y(max)}" stroke="#26305a" stroke-width="0.5" stroke-dasharray="3 3"/>
    <text x="2" y="${(y(max) + 3).toFixed(1)}" fill="#9aa3c7" font-size="8">${max}</text>
    <text x="2" y="${(y(0) + 3).toFixed(1)}" fill="#9aa3c7" font-size="8">0</text>`;
  return `<svg class="chart-svg" viewBox="0 0 ${W} ${H}">${grid}<polyline fill="none" stroke="${color}" stroke-width="2" points="${pts}"/>${dots}</svg>`;
}

// horizontal bars — mirrors the funnel / source pattern
function barRows(rows, color, empty) {
  if (!rows.length) return '<div class="panel-empty">' + (empty || "No data yet.") + "</div>";
  const max = Math.max(1, ...rows.map((r) => r.value));
  return rows.map((r) => {
    const pct = (r.value / max) * 100;
    return `<div class="funnel-row">
      <div class="funnel-label" title="${escapeHtml(r.label)}">${escapeHtml(r.label)}</div>
      <svg class="bar" viewBox="0 0 100 16" preserveAspectRatio="none"><rect x="0" y="0" width="100" height="16" fill="#1b2342"/><rect x="0" y="0" width="${pct.toFixed(2)}" height="16" fill="${color || "#6366f1"}"/></svg>
      <div class="funnel-val"><b>${r.value}</b>${r.sub ? " · " + r.sub : ""}</div>
    </div>`;
  }).join("");
}

function renderOverview(o) {
  const label = { google: "Google", linkedin: "LinkedIn", meta: "Meta", email: "Email", sms: "SMS" };
  const cell = (v) => (v == null ? '<span class="muted">—</span>' : v.toLocaleString());
  $("ov-channels").innerHTML =
    `<table class="ov-table"><thead><tr><th>Channel</th><th>Sessions</th><th>Leads</th><th>Conversions</th></tr></thead><tbody>` +
    o.channels.map((c) => {
      const name = `<span class="ov-ch"><span class="dot" style="background:${sourceColor(c.channel)}"></span>${label[c.channel] || c.channel}${c.live ? "" : ' <span class="tag">soon</span>'}</span>`;
      return `<tr${c.live ? "" : ' class="muted-row"'}><td>${name}</td><td>${cell(c.sessions)}</td><td>${c.leads.toLocaleString()}</td><td>${cell(c.conversions)}</td></tr>`;
    }).join("") + `</tbody></table>`;
  $("ov-source").innerHTML = barRows((o.leadsBySource || []).map((s) => ({ label: s.source, value: s.count })), "#6366f1", "No leads in the last 30 days.");
  $("ov-trend").innerHTML = (o.leadsByDay && o.leadsByDay.length)
    ? lineChart(o.leadsByDay.map((d) => d.count), "#6366f1")
    : '<div class="panel-empty">No leads created in the last 30 days.</div>';
}

function renderGoogleError(msg) {
  $("g-error").innerHTML = `<div class="error-card"><b>Google Analytics didn't load.</b><div>${escapeHtml(msg)}</div></div>`;
  $("g-kpis").innerHTML = ""; $("g-events").innerHTML = "";
  $("g-daily").innerHTML = '<div class="panel-empty">—</div>';
  $("g-sourcemedium").innerHTML = '<div class="panel-empty">—</div>';
  $("g-asof").textContent = "";
}

function renderGoogle(g) {
  if (g.error && g.sessions == null) { renderGoogleError(g.error); return; }
  $("g-error").innerHTML = "";
  $("g-asof").textContent = (g.stale ? "Cached · " : "") + "data as of " + fmtTime(g.fetchedAt);
  $("g-kpis").innerHTML =
    kpiCard("Sessions", g.sessions.cur.toLocaleString(), `vs ${g.sessions.prev} prior · ${deltaHtml(g.sessions.cur, g.sessions.prev)}`) +
    kpiCard("Engaged sessions", g.engagedSessions.cur.toLocaleString(), `vs ${g.engagedSessions.prev} prior · ${deltaHtml(g.engagedSessions.cur, g.engagedSessions.prev)}`);
  const evLabel = { demo_link_requested: "Demo link requested", demo_onboarding_complete: "Onboarding complete", demo_book_click: "Book-a-consult clicks" };
  $("g-events").innerHTML = Object.keys(evLabel).map((k) => {
    const e = g.keyEvents[k] || { cur: 0, prev: 0 };
    return kpiCard(evLabel[k], e.cur.toLocaleString(), `vs ${e.prev} prior · ${deltaHtml(e.cur, e.prev)}`);
  }).join("");
  $("g-daily").innerHTML = lineChart((g.daily || []).map((d) => d.sessions), "#6366f1");
  $("g-sourcemedium").innerHTML = barRows((g.sourceMedium || []).map((s) => ({ label: s.sourceMedium, value: s.sessions })), "#a5b4fc", "No session data.");
}

// ---------- logout ----------
$("logoutBtn").onclick = async () => {
  await fetch("/api/auth/logout", { method: "POST" });
  location.href = "/";
};

// ---------- go ----------
load().catch((e) => { if (e.message !== "unauthorized") document.getElementById("board").innerHTML = '<div class="empty">Failed to load: ' + escapeHtml(e.message) + "</div>"; });
