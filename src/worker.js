// ikai-sales Worker — all API routes. Multi-tenant, tenant-scoped everywhere.

// ---------- small utils ----------
const enc = new TextEncoder();

function uuid() {
  return crypto.randomUUID();
}

function nowISO() {
  return new Date().toISOString();
}

function addDaysISO(days) {
  return new Date(Date.now() + days * 86400_000).toISOString();
}

function json(data, status = 200, headers = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

function err(message, status = 400) {
  return json({ error: message }, status);
}

function toHex(buf) {
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function randHex(bytes = 32) {
  const b = new Uint8Array(bytes);
  crypto.getRandomValues(b);
  return toHex(b);
}

async function sha256Hex(str) {
  const digest = await crypto.subtle.digest("SHA-256", enc.encode(str));
  return toHex(digest);
}

// ---------- password crypto (PBKDF2-SHA256, 100k) ----------
const PBKDF2_ITER = 100_000;

async function pbkdf2(password, saltHex, iterations) {
  const salt = Uint8Array.from(saltHex.match(/../g).map((h) => parseInt(h, 16)));
  const key = await crypto.subtle.importKey("raw", enc.encode(password), "PBKDF2", false, [
    "deriveBits",
  ]);
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", salt, iterations, hash: "SHA-256" },
    key,
    256,
  );
  return toHex(bits);
}

async function hashPassword(password) {
  const saltHex = randHex(16);
  const hash = await pbkdf2(password, saltHex, PBKDF2_ITER);
  return `${PBKDF2_ITER}:${saltHex}:${hash}`;
}

// constant-time string compare (hex strings of equal length)
function timingSafeEqual(a, b) {
  if (a.length !== b.length) return false;
  let out = 0;
  for (let i = 0; i < a.length; i++) out |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return out === 0;
}

async function verifyPassword(password, stored) {
  const parts = String(stored).split(":");
  if (parts.length !== 3) return false;
  const [iterStr, saltHex, hash] = parts;
  const computed = await pbkdf2(password, saltHex, parseInt(iterStr, 10));
  return timingSafeEqual(computed, hash);
}

// ---------- cookies ----------
function parseCookies(req) {
  const out = {};
  const raw = req.headers.get("cookie");
  if (!raw) return out;
  for (const part of raw.split(";")) {
    const idx = part.indexOf("=");
    if (idx > -1) out[part.slice(0, idx).trim()] = part.slice(idx + 1).trim();
  }
  return out;
}

function sessionCookie(token, req, maxAgeSec = 30 * 86400) {
  const secure = new URL(req.url).protocol === "https:" ? " Secure;" : "";
  return `sid=${token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${maxAgeSec};${secure}`;
}

function clearCookie(req) {
  const secure = new URL(req.url).protocol === "https:" ? " Secure;" : "";
  return `sid=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0;${secure}`;
}

// ---------- auth ----------
// Returns { user, tenant_id } or null. Every data query hangs off this.
async function getSession(req, env) {
  const token = parseCookies(req).sid;
  if (!token) return null;
  const tokenHash = await sha256Hex(token);
  const row = await env.DB.prepare(
    `SELECT u.id, u.tenant_id, u.email, u.name, u.role, s.expires_at
       FROM sessions s JOIN users u ON u.id = s.user_id
      WHERE s.token_hash = ?`,
  )
    .bind(tokenHash)
    .first();
  if (!row) return null;
  if (new Date(row.expires_at).getTime() < Date.now()) {
    await env.DB.prepare(`DELETE FROM sessions WHERE token_hash = ?`).bind(tokenHash).run();
    return null;
  }
  return {
    user: { id: row.id, email: row.email, name: row.name, role: row.role },
    tenant_id: row.tenant_id,
  };
}

// ---------- route handlers ----------
async function seedStages(env, tenantId) {
  const names = ["New", "Contacted", "Consult booked", "Proposal", "Won", "Lost"];
  const stmts = names.map((name, i) =>
    env.DB.prepare(`INSERT INTO stages (id, tenant_id, name, position) VALUES (?,?,?,?)`).bind(
      uuid(),
      tenantId,
      name,
      i,
    ),
  );
  await env.DB.batch(stmts);
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

async function handleRegister(req, env) {
  const body = await req.json().catch(() => null);
  if (!body) return err("Invalid request body");
  const businessName = (body.business_name || "").trim();
  const name = (body.name || "").trim();
  const email = (body.email || "").trim().toLowerCase();
  const password = body.password || "";
  if (!businessName || !name || !email || !password) return err("All fields are required");
  if (!EMAIL_RE.test(email)) return err("Invalid email address");
  if (password.length < 8) return err("Password must be at least 8 characters");

  const existing = await env.DB.prepare(`SELECT id FROM users WHERE email = ?`).bind(email).first();
  if (existing) return err("An account with that email already exists", 409);

  const tenantId = uuid();
  const userId = uuid();
  const passwordHash = await hashPassword(password);
  const ts = nowISO();

  await env.DB.batch([
    env.DB.prepare(`INSERT INTO tenants (id, name, created_at) VALUES (?,?,?)`).bind(
      tenantId,
      businessName,
      ts,
    ),
    env.DB.prepare(
      `INSERT INTO users (id, tenant_id, email, name, role, password_hash, created_at)
       VALUES (?,?,?,?,?,?,?)`,
    ).bind(userId, tenantId, email, name, "owner", passwordHash, ts),
  ]);
  await seedStages(env, tenantId);

  return startSession(env, req, userId);
}

async function startSession(env, req, userId) {
  const token = randHex(32);
  const tokenHash = await sha256Hex(token);
  await env.DB.prepare(`INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (?,?,?)`)
    .bind(tokenHash, userId, addDaysISO(30))
    .run();
  return json({ ok: true }, 200, { "set-cookie": sessionCookie(token, req) });
}

async function handleLogin(req, env) {
  const body = await req.json().catch(() => null);
  if (!body) return err("Invalid request body");
  const email = (body.email || "").trim().toLowerCase();
  const password = body.password || "";
  if (!email || !password) return err("Email and password are required");

  // rate limit: 5 attempts / 15 min per email
  const windowStart = new Date(Date.now() - 15 * 60_000).toISOString();
  const { count } = await env.DB.prepare(
    `SELECT COUNT(*) AS count FROM login_attempts WHERE email = ? AND ts > ?`,
  )
    .bind(email, windowStart)
    .first();
  if (count >= 5) return err("Too many attempts. Try again in 15 minutes.", 429);

  const user = await env.DB.prepare(
    `SELECT id, password_hash FROM users WHERE email = ?`,
  )
    .bind(email)
    .first();

  const ok = user ? await verifyPassword(password, user.password_hash) : false;
  if (!ok) {
    await env.DB.prepare(`INSERT INTO login_attempts (email, ts) VALUES (?,?)`)
      .bind(email, nowISO())
      .run();
    return err("Invalid email or password", 401);
  }

  // success: clear attempts for this email
  await env.DB.prepare(`DELETE FROM login_attempts WHERE email = ?`).bind(email).run();
  return startSession(env, req, user.id);
}

async function handleLogout(req, env) {
  const token = parseCookies(req).sid;
  if (token) {
    const tokenHash = await sha256Hex(token);
    await env.DB.prepare(`DELETE FROM sessions WHERE token_hash = ?`).bind(tokenHash).run();
  }
  return json({ ok: true }, 200, { "set-cookie": clearCookie(req) });
}

async function handleMe(session, env) {
  const tenant = await env.DB.prepare(`SELECT id, name FROM tenants WHERE id = ?`)
    .bind(session.tenant_id)
    .first();
  return json({ user: session.user, tenant, role: session.user.role });
}

async function handleGetStages(session, env) {
  const { results } = await env.DB.prepare(
    `SELECT id, name, position FROM stages WHERE tenant_id = ? ORDER BY position`,
  )
    .bind(session.tenant_id)
    .all();
  return json({ stages: results });
}

async function handleGetLeads(session, env) {
  const { results: stages } = await env.DB.prepare(
    `SELECT id, name, position FROM stages WHERE tenant_id = ? ORDER BY position`,
  )
    .bind(session.tenant_id)
    .all();
  // stage_since = timestamp the lead entered its current stage (last stage_change, else created).
  const { results: leads } = await env.DB.prepare(
    `SELECT l.id, l.stage_id, l.name, l.company, l.email, l.phone, l.source, l.value_cents,
            l.notes, l.created_at, l.updated_at,
            COALESCE(
              (SELECT MAX(e.created_at) FROM lead_events e
                WHERE e.lead_id = l.id AND e.type = 'stage_change' AND e.to_stage = l.stage_id),
              l.created_at
            ) AS stage_since
       FROM leads l WHERE l.tenant_id = ? ORDER BY l.updated_at DESC`,
  )
    .bind(session.tenant_id)
    .all();
  return json({ stages, leads });
}

// Valid lead sources — built-ins + marketing channels. Keep in sync with the
// leads.source CHECK constraint (migration 0002) and the UI dropdowns.
const LEAD_SOURCES = ["manual", "csv", "demo", "booking", "call", "google", "linkedin", "meta", "email", "sms", "web"];
function validSource(s) {
  return LEAD_SOURCES.includes(s);
}

async function handleCreateLead(session, env, req) {
  const body = await req.json().catch(() => null);
  if (!body) return err("Invalid request body");
  const name = (body.name || "").trim();
  if (!name) return err("Lead name is required");
  const source = validSource(body.source) ? body.source : "manual";

  // stage must belong to this tenant; default to first stage
  let stageId = body.stage_id;
  const stage = stageId
    ? await env.DB.prepare(`SELECT id FROM stages WHERE id = ? AND tenant_id = ?`)
        .bind(stageId, session.tenant_id)
        .first()
    : null;
  if (!stage) {
    const first = await env.DB.prepare(
      `SELECT id FROM stages WHERE tenant_id = ? ORDER BY position LIMIT 1`,
    )
      .bind(session.tenant_id)
      .first();
    if (!first) return err("No stages configured", 500);
    stageId = first.id;
  }

  const id = uuid();
  const ts = nowISO();
  const valueCents = normalizeValueCents(body.value_cents, body.value);
  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO leads (id, tenant_id, stage_id, name, company, email, phone, source,
                          value_cents, notes, created_at, updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
    ).bind(
      id,
      session.tenant_id,
      stageId,
      name,
      body.company || null,
      body.email || null,
      body.phone || null,
      source,
      valueCents,
      body.notes || null,
      ts,
      ts,
    ),
    env.DB.prepare(
      `INSERT INTO lead_events (id, lead_id, tenant_id, type, to_stage, actor_user_id, created_at)
       VALUES (?,?,?,?,?,?,?)`,
    ).bind(uuid(), id, session.tenant_id, "created", stageId, session.user.id, ts),
  ]);

  const lead = await env.DB.prepare(`SELECT * FROM leads WHERE id = ? AND tenant_id = ?`)
    .bind(id, session.tenant_id)
    .first();
  return json({ lead }, 201);
}

function normalizeValueCents(valueCents, value) {
  if (valueCents !== undefined && valueCents !== null && valueCents !== "") {
    const n = Math.round(Number(valueCents));
    return Number.isFinite(n) ? n : null;
  }
  if (value !== undefined && value !== null && value !== "") {
    const n = Math.round(Number(value) * 100);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

async function handleGetLead(session, env, id) {
  const lead = await env.DB.prepare(`SELECT * FROM leads WHERE id = ? AND tenant_id = ?`)
    .bind(id, session.tenant_id)
    .first();
  if (!lead) return err("Lead not found", 404);
  const { results: events } = await env.DB.prepare(
    `SELECT id, type, from_stage, to_stage, note, actor_user_id, created_at
       FROM lead_events WHERE lead_id = ? AND tenant_id = ? ORDER BY created_at ASC`,
  )
    .bind(id, session.tenant_id)
    .all();
  return json({ lead, events });
}

async function handleDeleteLead(session, env, id) {
  // Tenant-scoped: only the owning tenant can delete, and only its own lead.
  // A non-existent id or another tenant's id both fail the same way (404).
  const lead = await env.DB.prepare(`SELECT id FROM leads WHERE id = ? AND tenant_id = ?`)
    .bind(id, session.tenant_id)
    .first();
  if (!lead) return err("Lead not found", 404);
  // Cascade to the lead's events, then remove the lead. batch() is atomic in D1.
  await env.DB.batch([
    env.DB.prepare(`DELETE FROM lead_events WHERE lead_id = ? AND tenant_id = ?`).bind(id, session.tenant_id),
    env.DB.prepare(`DELETE FROM leads WHERE id = ? AND tenant_id = ?`).bind(id, session.tenant_id),
  ]);
  return json({ ok: true });
}

// POST /api/leads/export  { lead_ids: [...] } | { all: true }
// Emails a CSV of the chosen (tenant-scoped) leads to the logged-in user.
async function handleExportLeads(session, env, req) {
  const body = await req.json().catch(() => null);
  if (!body) return err("Invalid request body");
  const all = body.all === true;
  const ids = Array.isArray(body.lead_ids) ? body.lead_ids.filter((x) => typeof x === "string") : [];
  if (!all && ids.length === 0) return err("No leads selected", 400);

  // Stage id -> name (tenant-scoped), for the "stage" column.
  const { results: stages } = await env.DB
    .prepare(`SELECT id, name FROM stages WHERE tenant_id = ?`)
    .bind(session.tenant_id)
    .all();
  const stageName = Object.fromEntries(stages.map((s) => [s.id, s.name]));

  // Only ever read this tenant's leads; then narrow to the selected ids in JS
  // (avoids IN(...) param limits and silently ignores any foreign/unknown id).
  const { results: allLeads } = await env.DB
    .prepare(`SELECT * FROM leads WHERE tenant_id = ? ORDER BY updated_at DESC`)
    .bind(session.tenant_id)
    .all();
  const leads = all ? allLeads : allLeads.filter((l) => ids.includes(l.id));
  if (leads.length === 0) return err("No matching leads to export", 400);

  const csv = buildLeadsCsv(leads, stageName);
  const filename = `ikai-leads-${new Date().toISOString().slice(0, 10)}.csv`;
  const to = session.user.email;

  const result = await sendCsvEmail(env, to, filename, csv, leads.length);
  if (!result.ok) return err(result.error || "Failed to send export email", 502);
  return json({ ok: true, count: leads.length, email: to });
}

// RFC-4180 quoting + CSV-injection guard (prefix =,+,-,@ with a single quote).
function csvCell(v) {
  let s = v == null ? "" : String(v);
  if (/^[=+\-@]/.test(s)) s = "'" + s;
  if (/[",\n\r]/.test(s)) s = '"' + s.replace(/"/g, '""') + '"';
  return s;
}

function buildLeadsCsv(leads, stageName) {
  const headers = ["name", "company", "email", "phone", "source", "stage", "value", "notes", "created_at", "updated_at", "id"];
  const lines = [headers.join(",")];
  for (const l of leads) {
    const value = l.value_cents != null ? (l.value_cents / 100).toFixed(2) : "";
    const cells = [l.name, l.company, l.email, l.phone, l.source, stageName[l.stage_id] || "", value, l.notes, l.created_at, l.updated_at, l.id];
    lines.push(cells.map(csvCell).join(","));
  }
  return lines.join("\r\n");
}

// base64 of a UTF-8 string (Workers-safe: encode bytes, then btoa a binary string).
function toBase64(str) {
  const bytes = new TextEncoder().encode(str);
  let bin = "";
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin);
}

async function sendCsvEmail(env, to, filename, csv, count) {
  if (!env.RESEND_API_KEY) {
    console.error("[export] RESEND_API_KEY is not configured");
    return { ok: false, error: "Email isn't configured yet — set RESEND_API_KEY." };
  }
  const n = `${count} lead${count === 1 ? "" : "s"}`;
  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { Authorization: `Bearer ${env.RESEND_API_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      from: `ikai Sales <${env.FROM_EMAIL}>`,
      to: [to],
      subject: `Your ikai leads export (${n})`,
      text: `Attached is your export of ${n} from ikai Sales.\nFile: ${filename}`,
      html: `<p>Attached is your export of <b>${n}</b> from ikai Sales.</p><p>File: ${filename}</p>`,
      attachments: [{ filename, content: toBase64(csv) }],
    }),
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    console.error(`[export] Resend ${res.status}: ${detail}`);
    return { ok: false, status: res.status, error: `Couldn't send the export (Resend ${res.status}).` };
  }
  return { ok: true };
}

// ---------------------------------------------------------------------------
// Marketing — GA4 (Google Analytics Data API v1). No SDK: service-account JWT
// signed with WebCrypto RS256 -> OAuth token -> batchRunReports. Cached 1h in D1.
// ---------------------------------------------------------------------------
const GA4_PROPERTY = "542595696";
const GA4_KEY_EVENTS = ["demo_link_requested", "demo_onboarding_complete", "demo_book_click"];

function b64urlBytes(bytes) {
  let bin = "";
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
function b64urlStr(str) { return b64urlBytes(new TextEncoder().encode(str)); }
function bytesFromB64(b64) {
  const bin = atob(b64);
  const a = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) a[i] = bin.charCodeAt(i);
  return a;
}

async function ga4AccessToken(env) {
  if (!env.GA4_SA_KEY) throw new Error("GA4 is not configured (no GA4_SA_KEY).");
  const sa = JSON.parse(env.GA4_SA_KEY);
  const now = Math.floor(Date.now() / 1000);
  const header = b64urlStr(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const claim = b64urlStr(JSON.stringify({
    iss: sa.client_email,
    scope: "https://www.googleapis.com/auth/analytics.readonly",
    aud: sa.token_uri,
    iat: now,
    exp: now + 3600,
  }));
  const signingInput = `${header}.${claim}`;
  const pkcs8 = sa.private_key.replace(/-----BEGIN PRIVATE KEY-----/, "").replace(/-----END PRIVATE KEY-----/, "").replace(/\s+/g, "");
  const key = await crypto.subtle.importKey("pkcs8", bytesFromB64(pkcs8), { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign({ name: "RSASSA-PKCS1-v1_5" }, key, new TextEncoder().encode(signingInput));
  const jwt = `${signingInput}.${b64urlBytes(new Uint8Array(sig))}`;
  const res = await fetch(sa.token_uri, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: `grant_type=${encodeURIComponent("urn:ietf:params:oauth:grant-type:jwt-bearer")}&assertion=${jwt}`,
  });
  if (!res.ok) {
    const t = await res.text().catch(() => "");
    const e = new Error(`Google OAuth ${res.status}: ${t.slice(0, 300)}`);
    e.status = res.status;
    throw e;
  }
  const j = await res.json();
  if (!j.access_token) throw new Error("Google OAuth: no access_token returned");
  return j.access_token;
}

function ga4ParseReport(rep) {
  const dh = ((rep && rep.dimensionHeaders) || []).map((h) => h.name);
  const mh = ((rep && rep.metricHeaders) || []).map((h) => h.name);
  return ((rep && rep.rows) || []).map((r) => {
    const dims = {}, mets = {};
    dh.forEach((n, i) => { dims[n] = (r.dimensionValues[i] || {}).value; });
    mh.forEach((n, i) => { mets[n] = Number((r.metricValues[i] || {}).value || 0); });
    return { dims, mets };
  });
}

async function ga4Fetch(env) {
  const token = await ga4AccessToken(env);
  const cur = { startDate: "30daysAgo", endDate: "yesterday" };
  const prev = { startDate: "60daysAgo", endDate: "31daysAgo" };
  const body = {
    requests: [
      { dateRanges: [cur, prev], metrics: [{ name: "sessions" }, { name: "engagedSessions" }] },
      {
        dateRanges: [cur, prev],
        dimensions: [{ name: "eventName" }],
        metrics: [{ name: "eventCount" }],
        dimensionFilter: { filter: { fieldName: "eventName", inListFilter: { values: GA4_KEY_EVENTS } } },
      },
      {
        dateRanges: [cur],
        dimensions: [{ name: "sessionSourceMedium" }],
        metrics: [{ name: "sessions" }],
        orderBys: [{ metric: { metricName: "sessions" }, desc: true }],
        limit: 10,
      },
      {
        dateRanges: [cur],
        dimensions: [{ name: "date" }],
        metrics: [{ name: "sessions" }],
        orderBys: [{ dimension: { dimensionName: "date" } }],
      },
    ],
  };
  const res = await fetch(`https://analyticsdata.googleapis.com/v1beta/properties/${GA4_PROPERTY}:batchRunReports`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const t = await res.text().catch(() => "");
    const e = new Error(`GA4 API ${res.status}: ${t.slice(0, 300)}`);
    e.status = res.status;
    throw e;
  }
  const j = await res.json();
  const reps = j.reports || [];
  const totals = ga4ParseReport(reps[0]);
  const c0 = totals.find((r) => r.dims.dateRange === "date_range_0") || { mets: {} };
  const p0 = totals.find((r) => r.dims.dateRange === "date_range_1") || { mets: {} };
  const ke = ga4ParseReport(reps[1]);
  const keyEvents = {};
  for (const ev of GA4_KEY_EVENTS) {
    const c = ke.find((r) => r.dims.eventName === ev && r.dims.dateRange === "date_range_0");
    const p = ke.find((r) => r.dims.eventName === ev && r.dims.dateRange === "date_range_1");
    keyEvents[ev] = { cur: c ? c.mets.eventCount : 0, prev: p ? p.mets.eventCount : 0 };
  }
  return {
    sessions: { cur: c0.mets.sessions || 0, prev: p0.mets.sessions || 0 },
    engagedSessions: { cur: c0.mets.engagedSessions || 0, prev: p0.mets.engagedSessions || 0 },
    keyEvents,
    sourceMedium: ga4ParseReport(reps[2]).map((r) => ({ sourceMedium: r.dims.sessionSourceMedium || "(not set)", sessions: r.mets.sessions })),
    daily: ga4ParseReport(reps[3]).map((r) => ({ date: r.dims.date, sessions: r.mets.sessions })).sort((a, b) => (a.date < b.date ? -1 : 1)),
  };
}

// 1-hour cache in D1; on error/quota serve the last good cache if we have one.
async function getGa4Data(env) {
  const row = await env.DB.prepare(`SELECT data, fetched_at FROM ga4_cache WHERE k = 'google_30d'`).first();
  if (row) {
    const age = Date.now() - new Date(row.fetched_at).getTime();
    if (age >= 0 && age < 3600000) return { data: JSON.parse(row.data), fetchedAt: row.fetched_at, cached: true };
  }
  try {
    const data = await ga4Fetch(env);
    const fetchedAt = new Date().toISOString();
    await env.DB
      .prepare(`INSERT INTO ga4_cache (k, data, fetched_at) VALUES ('google_30d', ?, ?)
                ON CONFLICT(k) DO UPDATE SET data = excluded.data, fetched_at = excluded.fetched_at`)
      .bind(JSON.stringify(data), fetchedAt)
      .run();
    return { data, fetchedAt, cached: false };
  } catch (e) {
    if (row) return { data: JSON.parse(row.data), fetchedAt: row.fetched_at, cached: true, stale: true, error: e.message };
    return { error: e.message, status: e.status || null };
  }
}

async function handleMarketingGoogle(session, env) {
  const g = await getGa4Data(env);
  if (g.error && !g.data) return json({ error: g.error, status: g.status });
  return json({ ...g.data, fetchedAt: g.fetchedAt, cached: !!g.cached, stale: !!g.stale, staleError: g.error || null });
}

async function handleMarketingOverview(session, env) {
  const since = "datetime('now','-30 days')";
  const { results: srcRows } = await env.DB
    .prepare(`SELECT source, COUNT(*) c FROM leads WHERE tenant_id = ? AND created_at >= ${since} GROUP BY source`)
    .bind(session.tenant_id)
    .all();
  const bySource = {};
  srcRows.forEach((r) => { bySource[r.source] = r.c; });
  const { results: dayRows } = await env.DB
    .prepare(`SELECT substr(created_at,1,10) d, COUNT(*) c FROM leads WHERE tenant_id = ? AND created_at >= ${since} GROUP BY d ORDER BY d`)
    .bind(session.tenant_id)
    .all();

  const g = await getGa4Data(env);
  const gd = g.data || null;
  const channels = [
    { channel: "google", live: true, sessions: gd ? gd.sessions.cur : null, leads: bySource.google || 0, conversions: gd ? gd.keyEvents.demo_book_click.cur : null, error: gd ? null : (g.error || null) },
    { channel: "linkedin", live: false, sessions: null, leads: bySource.linkedin || 0, conversions: null },
    { channel: "meta", live: false, sessions: null, leads: bySource.meta || 0, conversions: null },
    { channel: "email", live: false, sessions: null, leads: bySource.email || 0, conversions: null },
    { channel: "sms", live: false, sessions: null, leads: bySource.sms || 0, conversions: null },
  ];
  return json({
    channels,
    leadsBySource: srcRows.map((r) => ({ source: r.source, count: r.c })),
    leadsByDay: dayRows.map((r) => ({ date: r.d, count: r.c })),
    fetchedAt: g.fetchedAt || null,
  });
}

async function handlePatchLead(session, env, id, req) {
  const body = await req.json().catch(() => null);
  if (!body) return err("Invalid request body");
  const lead = await env.DB.prepare(`SELECT * FROM leads WHERE id = ? AND tenant_id = ?`)
    .bind(id, session.tenant_id)
    .first();
  if (!lead) return err("Lead not found", 404);

  const ts = nowISO();
  const stmts = [];

  // stage change → validate stage belongs to tenant, write event
  let newStageId = lead.stage_id;
  if (body.stage_id && body.stage_id !== lead.stage_id) {
    const stage = await env.DB.prepare(`SELECT id FROM stages WHERE id = ? AND tenant_id = ?`)
      .bind(body.stage_id, session.tenant_id)
      .first();
    if (!stage) return err("Invalid stage", 400);
    newStageId = body.stage_id;
    stmts.push(
      env.DB.prepare(
        `INSERT INTO lead_events (id, lead_id, tenant_id, type, from_stage, to_stage, actor_user_id, created_at)
         VALUES (?,?,?,?,?,?,?,?)`,
      ).bind(
        uuid(),
        id,
        session.tenant_id,
        "stage_change",
        lead.stage_id,
        newStageId,
        session.user.id,
        ts,
      ),
    );
  }

  const fields = {
    name: body.name !== undefined ? String(body.name).trim() : lead.name,
    company: body.company !== undefined ? body.company || null : lead.company,
    email: body.email !== undefined ? body.email || null : lead.email,
    phone: body.phone !== undefined ? body.phone || null : lead.phone,
    notes: body.notes !== undefined ? body.notes || null : lead.notes,
    stage_id: newStageId,
    value_cents:
      body.value_cents !== undefined || body.value !== undefined
        ? normalizeValueCents(body.value_cents, body.value)
        : lead.value_cents,
  };
  if (!fields.name) return err("Lead name cannot be empty");

  stmts.unshift(
    env.DB.prepare(
      `UPDATE leads SET name=?, company=?, email=?, phone=?, notes=?, stage_id=?, value_cents=?, updated_at=?
        WHERE id=? AND tenant_id=?`,
    ).bind(
      fields.name,
      fields.company,
      fields.email,
      fields.phone,
      fields.notes,
      fields.stage_id,
      fields.value_cents,
      ts,
      id,
      session.tenant_id,
    ),
  );

  await env.DB.batch(stmts);
  const updated = await env.DB.prepare(`SELECT * FROM leads WHERE id = ? AND tenant_id = ?`)
    .bind(id, session.tenant_id)
    .first();
  return json({ lead: updated });
}

async function handleAddNote(session, env, id, req) {
  const body = await req.json().catch(() => null);
  const note = (body && body.note ? String(body.note) : "").trim();
  if (!note) return err("Note is required");
  const lead = await env.DB.prepare(`SELECT id FROM leads WHERE id = ? AND tenant_id = ?`)
    .bind(id, session.tenant_id)
    .first();
  if (!lead) return err("Lead not found", 404);
  const ts = nowISO();
  await env.DB.prepare(
    `INSERT INTO lead_events (id, lead_id, tenant_id, type, note, actor_user_id, created_at)
     VALUES (?,?,?,?,?,?,?)`,
  )
    .bind(uuid(), id, session.tenant_id, "note", note, session.user.id, ts)
    .run();
  await env.DB.prepare(`UPDATE leads SET updated_at=? WHERE id=? AND tenant_id=?`)
    .bind(ts, id, session.tenant_id)
    .run();
  return json({ ok: true }, 201);
}

async function handleImport(session, env, req) {
  const body = await req.json().catch(() => null);
  if (!body || !Array.isArray(body.rows)) return err("rows[] required");
  const first = await env.DB.prepare(
    `SELECT id FROM stages WHERE tenant_id = ? ORDER BY position LIMIT 1`,
  )
    .bind(session.tenant_id)
    .first();
  if (!first) return err("No stages configured", 500);

  // Imported leads default to "csv" but the importer may pick any valid source.
  const importSource = validSource(body.source) ? body.source : "csv";

  const stmts = [];
  let imported = 0;
  for (const row of body.rows) {
    const name = (row.name || "").trim();
    if (!name) continue; // skip nameless rows
    const id = uuid();
    const ts = nowISO();
    const valueCents = normalizeValueCents(undefined, row.value);
    stmts.push(
      env.DB.prepare(
        `INSERT INTO leads (id, tenant_id, stage_id, name, company, email, phone, source,
                            value_cents, notes, created_at, updated_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
      ).bind(
        id,
        session.tenant_id,
        first.id,
        name,
        row.company || null,
        row.email || null,
        row.phone || null,
        importSource,
        valueCents,
        row.notes || null,
        ts,
        ts,
      ),
    );
    stmts.push(
      env.DB.prepare(
        `INSERT INTO lead_events (id, lead_id, tenant_id, type, to_stage, actor_user_id, created_at)
         VALUES (?,?,?,?,?,?,?)`,
      ).bind(uuid(), id, session.tenant_id, "created", first.id, session.user.id, ts),
    );
    imported++;
  }
  if (stmts.length) await env.DB.batch(stmts);
  return json({ imported });
}

async function handleCreateInvite(session, env, req) {
  if (session.user.role !== "owner") return err("Only owners can create invites", 403);
  const token = randHex(32);
  const tokenHash = await sha256Hex(token);
  await env.DB.prepare(
    `INSERT INTO invites (token_hash, tenant_id, role, created_by, expires_at)
     VALUES (?,?,?,?,?)`,
  )
    .bind(tokenHash, session.tenant_id, "member", session.user.id, addDaysISO(7))
    .run();
  const link = `${env.APP_URL}/join?token=${token}`;
  return json({ link, expires_at: addDaysISO(7) }, 201);
}

async function handleJoin(req, env) {
  const body = await req.json().catch(() => null);
  if (!body) return err("Invalid request body");
  const token = (body.token || "").trim();
  const name = (body.name || "").trim();
  const password = body.password || "";
  const email = (body.email || "").trim().toLowerCase();
  if (!token || !name || !password || !email) return err("All fields are required");
  if (!EMAIL_RE.test(email)) return err("Invalid email address");
  if (password.length < 8) return err("Password must be at least 8 characters");

  const tokenHash = await sha256Hex(token);
  const invite = await env.DB.prepare(
    `SELECT tenant_id, role, expires_at, used_at FROM invites WHERE token_hash = ?`,
  )
    .bind(tokenHash)
    .first();
  if (!invite) return err("Invalid invite link", 404);
  if (invite.used_at) return err("This invite has already been used", 410);
  if (new Date(invite.expires_at).getTime() < Date.now()) return err("This invite has expired", 410);

  const existing = await env.DB.prepare(`SELECT id FROM users WHERE email = ?`).bind(email).first();
  if (existing) return err("An account with that email already exists", 409);

  const userId = uuid();
  const ts = nowISO();
  const passwordHash = await hashPassword(password);
  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO users (id, tenant_id, email, name, role, password_hash, created_at)
       VALUES (?,?,?,?,?,?,?)`,
    ).bind(userId, invite.tenant_id, email, name, invite.role, passwordHash, ts),
    env.DB.prepare(`UPDATE invites SET used_at = ? WHERE token_hash = ?`).bind(ts, tokenHash),
  ]);
  return startSession(env, req, userId);
}

// ---------- dashboard aggregates ----------
async function handleDashboard(session, env) {
  const t = session.tenant_id;
  const { results: stages } = await env.DB.prepare(
    `SELECT id, name, position FROM stages WHERE tenant_id = ? ORDER BY position`,
  )
    .bind(t)
    .all();
  const won = stages.find((s) => s.name.toLowerCase() === "won");
  const lost = stages.find((s) => s.name.toLowerCase() === "lost");
  const closed = [won?.id, lost?.id].filter(Boolean);
  const ph = closed.map(() => "?").join(",");
  const notClosed = closed.length ? `AND stage_id NOT IN (${ph})` : "";
  const notClosedL = closed.length ? `AND l.stage_id NOT IN (${ph})` : "";

  // Funnel: count + value per stage (all leads).
  const { results: grp } = await env.DB.prepare(
    `SELECT stage_id, COUNT(*) c, COALESCE(SUM(value_cents),0) v
       FROM leads WHERE tenant_id = ? GROUP BY stage_id`,
  )
    .bind(t)
    .all();
  const gmap = {};
  grp.forEach((r) => (gmap[r.stage_id] = { count: r.c, value: r.v }));
  const funnel = stages.map((s) => ({
    stage_id: s.id,
    name: s.name,
    count: gmap[s.id]?.count || 0,
    value: gmap[s.id]?.value || 0,
  }));

  // Open pipeline (stages not Won/Lost).
  const openRow = await env.DB.prepare(
    `SELECT COUNT(*) c, COALESCE(SUM(value_cents),0) v FROM leads WHERE tenant_id = ? ${notClosed}`,
  )
    .bind(t, ...closed)
    .first();

  // Leads added: last 30d vs previous 30d.
  const added = await env.DB.prepare(
    `SELECT
       SUM(CASE WHEN julianday(created_at) >= julianday('now','-30 days') THEN 1 ELSE 0 END) a30,
       SUM(CASE WHEN julianday(created_at) >= julianday('now','-60 days')
                 AND julianday(created_at) <  julianday('now','-30 days') THEN 1 ELSE 0 END) aprev
     FROM leads WHERE tenant_id = ?`,
  )
    .bind(t)
    .first();

  // Won this month / last month (from stage_change events to Won).
  let wonThis = { c: 0, v: 0 };
  let wonLast = { c: 0 };
  if (won) {
    wonThis = await env.DB.prepare(
      `SELECT COUNT(*) c, COALESCE(SUM(l.value_cents),0) v
         FROM lead_events e JOIN leads l ON l.id = e.lead_id
        WHERE e.tenant_id = ? AND e.type = 'stage_change' AND e.to_stage = ?
          AND julianday(e.created_at) >= julianday(date('now','start of month'))`,
    )
      .bind(t, won.id)
      .first();
    wonLast = await env.DB.prepare(
      `SELECT COUNT(*) c FROM lead_events e
        WHERE e.tenant_id = ? AND e.type = 'stage_change' AND e.to_stage = ?
          AND julianday(e.created_at) >= julianday(date('now','start of month','-1 month'))
          AND julianday(e.created_at) <  julianday(date('now','start of month'))`,
    )
      .bind(t, won.id)
      .first();
  }

  const wonAll = won ? gmap[won.id]?.count || 0 : 0;
  const lostAll = lost ? gmap[lost.id]?.count || 0 : 0;

  // Source breakdown (open leads only).
  const { results: src } = await env.DB.prepare(
    `SELECT source, COUNT(*) c FROM leads WHERE tenant_id = ? ${notClosed} GROUP BY source`,
  )
    .bind(t, ...closed)
    .all();
  // Data-driven so any source (incl. new marketing channels) shows up.
  const sources = src.map((r) => ({ source: r.source, count: r.c }));

  // Weekly time-series (last 8 weeks). wk 0 = this week … 7 = 7 weeks ago.
  const { results: wc } = await env.DB.prepare(
    `SELECT CAST((julianday('now') - julianday(created_at)) / 7 AS INT) wk, COUNT(*) c
       FROM leads WHERE tenant_id = ? AND julianday(created_at) >= julianday('now','-56 days')
      GROUP BY wk`,
  )
    .bind(t)
    .all();
  let ww = [];
  if (won) {
    const r = await env.DB.prepare(
      `SELECT CAST((julianday('now') - julianday(created_at)) / 7 AS INT) wk, COUNT(*) c
         FROM lead_events
        WHERE tenant_id = ? AND type = 'stage_change' AND to_stage = ?
          AND julianday(created_at) >= julianday('now','-56 days')
        GROUP BY wk`,
    )
      .bind(t, won.id)
      .all();
    ww = r.results;
  }
  const created8 = Array(8).fill(0);
  const won8 = Array(8).fill(0);
  wc.forEach((r) => { if (r.wk >= 0 && r.wk < 8) created8[7 - r.wk] += r.c; });
  ww.forEach((r) => { if (r.wk >= 0 && r.wk < 8) won8[7 - r.wk] += r.c; });

  // Stale open leads: no lead_events in 7+ days.
  const { results: stale } = await env.DB.prepare(
    `SELECT l.id, l.name, l.stage_id,
            MAX(e.created_at) last_event,
            CAST(julianday('now') - julianday(MAX(e.created_at)) AS INT) days_silent
       FROM leads l JOIN lead_events e ON e.lead_id = l.id
      WHERE l.tenant_id = ? ${notClosedL}
      GROUP BY l.id
     HAVING julianday(MAX(e.created_at)) < julianday('now','-7 days')
      ORDER BY last_event ASC LIMIT 25`,
  )
    .bind(t, ...closed)
    .all();

  // Activity feed: last 15 events with lead + actor names.
  const { results: activity } = await env.DB.prepare(
    `SELECT e.type, e.from_stage, e.to_stage, e.note, e.created_at,
            l.name lead_name, u.name actor_name
       FROM lead_events e JOIN leads l ON l.id = e.lead_id
       LEFT JOIN users u ON u.id = e.actor_user_id
      WHERE e.tenant_id = ? ORDER BY e.created_at DESC LIMIT 15`,
  )
    .bind(t)
    .all();

  return json({
    stages,
    kpis: {
      open_value_cents: openRow.v,
      open_count: openRow.c,
      leads_added_30: added.a30 || 0,
      leads_added_prev_30: added.aprev || 0,
      won_this_month_count: wonThis.c || 0,
      won_this_month_value: wonThis.v || 0,
      won_last_month_count: wonLast.c || 0,
      won_all: wonAll,
      lost_all: lostAll,
    },
    funnel,
    sources,
    weekly: { created: created8, won: won8 },
    stale,
    activity,
  });
}

// ---------- router ----------
export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    const path = url.pathname;

    if (!path.startsWith("/api/")) {
      // Static assets (index.html, join.html, app.html, css, js) handled by ASSETS binding.
      return env.ASSETS.fetch(req);
    }

    try {
      const method = req.method;

      // Public auth routes
      if (path === "/api/auth/register" && method === "POST") return await handleRegister(req, env);
      if (path === "/api/auth/login" && method === "POST") return await handleLogin(req, env);
      if (path === "/api/auth/logout" && method === "POST") return await handleLogout(req, env);
      if (path === "/api/join" && method === "POST") return await handleJoin(req, env);

      // Everything below requires a valid session.
      const session = await getSession(req, env);
      if (!session) return err("Unauthorized", 401);

      if (path === "/api/me" && method === "GET") return await handleMe(session, env);
      if (path === "/api/stages" && method === "GET") return await handleGetStages(session, env);
      if (path === "/api/dashboard" && method === "GET") return await handleDashboard(session, env);
      if (path === "/api/marketing/google" && method === "GET") return await handleMarketingGoogle(session, env);
      if (path === "/api/marketing/overview" && method === "GET") return await handleMarketingOverview(session, env);
      if (path === "/api/invites" && method === "POST")
        return await handleCreateInvite(session, env, req);

      if (path === "/api/leads" && method === "GET") return await handleGetLeads(session, env);
      if (path === "/api/leads" && method === "POST")
        return await handleCreateLead(session, env, req);
      if (path === "/api/leads/import" && method === "POST")
        return await handleImport(session, env, req);
      if (path === "/api/leads/export" && method === "POST")
        return await handleExportLeads(session, env, req);

      const leadMatch = path.match(/^\/api\/leads\/([^/]+)$/);
      if (leadMatch) {
        const id = leadMatch[1];
        if (method === "GET") return await handleGetLead(session, env, id);
        if (method === "PATCH") return await handlePatchLead(session, env, id, req);
        if (method === "DELETE") return await handleDeleteLead(session, env, id);
      }

      const noteMatch = path.match(/^\/api\/leads\/([^/]+)\/notes$/);
      if (noteMatch && method === "POST")
        return await handleAddNote(session, env, noteMatch[1], req);

      return err("Not found", 404);
    } catch (e) {
      return err("Internal error: " + (e && e.message ? e.message : String(e)), 500);
    }
  },
};
