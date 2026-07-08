// Dashboard analytics tests. Seeds a backdated tenant directly into local D1
// (deterministic UUIDs + a session row), then asserts /api/dashboard aggregates.
// Local only for seeding; remote smoke is handled separately.
import { execSync } from "node:child_process";
import { createHash, randomUUID, randomBytes } from "node:crypto";
import { writeFileSync, unlinkSync } from "node:fs";

const BASE = process.env.BASE_URL || "http://localhost:8787";
const sha256 = (s) => createHash("sha256").update(s).digest("hex");
const iso = (msAgo) => new Date(Date.now() - msAgo).toISOString();
const DAY = 86400_000;

let pass = 0, fail = 0;
const out = [];
function check(name, cond, detail = "") {
  if (cond) { pass++; out.push(`  ✅ ${name}`); }
  else { fail++; out.push(`  ❌ ${name}${detail ? " — " + detail : ""}`); }
}
function section(t) { out.push(`\n▶ ${t}`); }
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);

class Client {
  constructor(cookie = null) { this.cookie = cookie; }
  async req(method, path, body) {
    const headers = { "content-type": "application/json" };
    if (this.cookie) headers.cookie = this.cookie;
    const r = await fetch(BASE + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    const sc = r.headers.get("set-cookie");
    if (sc) { const sid = sc.split(";")[0]; if (sid.startsWith("sid=") && !sid.endsWith("sid=")) this.cookie = sid; }
    let data = null; try { data = await r.json(); } catch {}
    return { status: r.status, data };
  }
  get(p) { return this.req("GET", p); }
  post(p, b) { return this.req("POST", p, b); }
}

const sqlStr = (s) => (s == null ? "NULL" : `'${String(s).replace(/'/g, "''")}'`);

async function main() {
  // ---------- build backdated seed ----------
  const tenantId = randomUUID();
  const ownerId = randomUUID();
  const token = randomBytes(32).toString("hex");
  const tokenHash = sha256(token);
  const uniq = Date.now();
  const ownerEmail = `dash-owner-${uniq}@seed.test`;

  const stageDefs = ["New", "Contacted", "Consult booked", "Proposal", "Won", "Lost"];
  const stageId = {};
  stageDefs.forEach((n) => (stageId[n] = randomUUID()));

  // Stage assignment by lead index (funnel counts): New7 Contacted6 Consult5 Proposal4 Won5 Lost3 = 30
  const stageForIndex = (i) =>
    i < 5 ? "Won" : i < 8 ? "Lost" : i < 15 ? "New" : i < 21 ? "Contacted" : i < 26 ? "Consult booked" : "Proposal";
  // weeksAgo per lead → realizes created counts cwa[wk0..wk7] = [4,3,5,2,6,1,4,5]
  const weeksAgoList = [0,0,0,0, 1,1,1, 2,2,2,2,2, 3,3, 4,4,4,4,4,4, 5, 6,6,6,6, 7,7,7,7,7];

  const rows = [];   // lead insert SQL
  const events = []; // event insert SQL
  const staleTargetId = randomUUID(); // lead index 8 (New, 15d old) — used for stale test
  for (let i = 0; i < 30; i++) {
    const id = i === 8 ? staleTargetId : randomUUID();
    const stage = stageForIndex(i);
    const daysAgo = weeksAgoList[i] * 7 + 1;
    const createdAt = iso(daysAgo * DAY);
    const name = i === 8 ? "StaleTarget" : `Lead${i}`;
    rows.push(
      `INSERT INTO leads (id,tenant_id,stage_id,name,company,email,phone,source,value_cents,notes,created_at,updated_at) VALUES (` +
        `${sqlStr(id)},${sqlStr(tenantId)},${sqlStr(stageId[stage])},${sqlStr(name)},${sqlStr("Co" + i)},NULL,NULL,'manual',100000,NULL,${sqlStr(createdAt)},${sqlStr(createdAt)});`,
    );
    // one 'created' event at created_at
    events.push(
      `INSERT INTO lead_events (id,lead_id,tenant_id,type,to_stage,actor_user_id,created_at) VALUES (` +
        `${sqlStr(randomUUID())},${sqlStr(id)},${sqlStr(tenantId)},'created',${sqlStr(stageId[stage])},${sqlStr(ownerId)},${sqlStr(createdAt)});`,
    );
    // won leads (idx 0-4) get a stage_change→Won event at chosen weeksAgo
    const wonWeeks = [0, 0, 1, 3, 6];
    if (i < 5) {
      const wAgo = wonWeeks[i] * 7 + 1;
      const evAt = iso(wAgo * DAY);
      events.push(
        `INSERT INTO lead_events (id,lead_id,tenant_id,type,from_stage,to_stage,actor_user_id,created_at) VALUES (` +
          `${sqlStr(randomUUID())},${sqlStr(id)},${sqlStr(tenantId)},'stage_change',${sqlStr(stageId["Proposal"])},${sqlStr(stageId["Won"])},${sqlStr(ownerId)},${sqlStr(evAt)});`,
      );
    }
  }

  const seed = [
    `INSERT INTO tenants (id,name,created_at) VALUES (${sqlStr(tenantId)},'Seeded Analytics Co',${sqlStr(iso(60 * DAY))});`,
    `INSERT INTO users (id,tenant_id,email,name,role,password_hash,created_at) VALUES (${sqlStr(ownerId)},${sqlStr(tenantId)},${sqlStr(ownerEmail)},'Seed Owner','owner','x:y:z',${sqlStr(iso(60 * DAY))});`,
    ...stageDefs.map((n, i) => `INSERT INTO stages (id,tenant_id,name,position) VALUES (${sqlStr(stageId[n])},${sqlStr(tenantId)},${sqlStr(n)},${i});`),
    `INSERT INTO sessions (token_hash,user_id,expires_at) VALUES (${sqlStr(tokenHash)},${sqlStr(ownerId)},${sqlStr(iso(-30 * DAY))});`,
    ...rows,
    ...events,
  ].join("\n");

  const seedFile = `/tmp/ikai-dash-seed-${uniq}.sql`;
  writeFileSync(seedFile, seed);
  execSync(`npx wrangler d1 execute ikai-sales-db --local --file ${seedFile}`, {
    stdio: "pipe",
    env: { ...process.env, CLOUDFLARE_ACCOUNT_ID: "cebd2c2d41f211a3f65977a59bf3944c" },
  });
  unlinkSync(seedFile);

  // ---------- expectations computed from the same seed arrays ----------
  const cwa = [4, 3, 5, 2, 6, 1, 4, 5];
  const expCreated8 = [0,1,2,3,4,5,6,7].map((i) => cwa[7 - i]); // oldest→newest
  const wonWk = [2, 1, 0, 1, 0, 0, 1, 0]; // by weeksAgo 0..7
  const expWon8 = [0,1,2,3,4,5,6,7].map((i) => wonWk[7 - i]);
  const now = new Date();
  const wonEventDaysAgo = [0, 0, 1, 3, 6].map((w) => w * 7 + 1);
  const expWonThisMonth = wonEventDaysAgo.filter((d) => {
    const dt = new Date(Date.now() - d * DAY);
    return dt.getFullYear() === now.getFullYear() && dt.getMonth() === now.getMonth();
  }).length;
  const leadDaysAgo = weeksAgoList.map((w) => w * 7 + 1);
  const expAdded30 = leadDaysAgo.filter((d) => d <= 30).length;
  const expPrev30 = leadDaysAgo.filter((d) => d > 30 && d <= 60).length;

  // ---------- Test 2: seeded aggregates ----------
  section("Test 2 — Seeded 30-lead tenant: funnel, win rate, weekly buckets");
  const a = new Client(`sid=${token}`);
  const me = await a.get("/api/me");
  check("seed visible to dev server (session auth works)", me.status === 200 && me.data.tenant?.id === tenantId,
    `status ${me.status} ${JSON.stringify(me.data)}`);
  const dash = (await a.get("/api/dashboard")).data;

  // Test 1 reconciliation: dashboard open value/count must equal the pipeline board's own math.
  const board = (await a.get("/api/leads")).data;
  const closedIds = board.stages.filter((s) => ["won", "lost"].includes(s.name.toLowerCase())).map((s) => s.id);
  const boardOpen = board.leads.filter((l) => !closedIds.includes(l.stage_id));
  const boardOpenValue = boardOpen.reduce((s, l) => s + (l.value_cents || 0), 0);
  const boardTotalPerStage = {};
  board.leads.forEach((l) => (boardTotalPerStage[l.stage_id] = (boardTotalPerStage[l.stage_id] || 0) + 1));
  check("Test 1 · dashboard open_count reconciles with board", dash.kpis.open_count === boardOpen.length,
    `dash ${dash.kpis.open_count} board ${boardOpen.length}`);
  check("Test 1 · dashboard open_value reconciles with board", dash.kpis.open_value_cents === boardOpenValue,
    `dash ${dash.kpis.open_value_cents} board ${boardOpenValue}`);
  check("Test 1 · funnel per-stage counts reconcile with board", dash.funnel.every((f) => (boardTotalPerStage[f.stage_id] || 0) === f.count));

  const fcount = {}; (dash.funnel || []).forEach((f) => (fcount[f.name] = f.count));
  check("funnel counts match [New7,Contacted6,Consult5,Proposal4,Won5,Lost3]",
    fcount.New === 7 && fcount.Contacted === 6 && fcount["Consult booked"] === 5 && fcount.Proposal === 4 && fcount.Won === 5 && fcount.Lost === 3,
    JSON.stringify(fcount));
  check("open count = 22", dash.kpis.open_count === 22, "got " + dash.kpis.open_count);
  check("open value = 2,200,000c", dash.kpis.open_value_cents === 2200000, "got " + dash.kpis.open_value_cents);
  check("win rate inputs won_all=5 lost_all=3", dash.kpis.won_all === 5 && dash.kpis.lost_all === 3,
    `won ${dash.kpis.won_all} lost ${dash.kpis.lost_all}`);
  check("weekly.created buckets correct", eq(dash.weekly.created, expCreated8), `got ${JSON.stringify(dash.weekly.created)} exp ${JSON.stringify(expCreated8)}`);
  check("weekly.won buckets correct", eq(dash.weekly.won, expWon8), `got ${JSON.stringify(dash.weekly.won)} exp ${JSON.stringify(expWon8)}`);
  check("leads added 30d correct", dash.kpis.leads_added_30 === expAdded30, `got ${dash.kpis.leads_added_30} exp ${expAdded30}`);
  check("leads added prev-30 correct", dash.kpis.leads_added_prev_30 === expPrev30, `got ${dash.kpis.leads_added_prev_30} exp ${expPrev30}`);
  check("won this month correct", dash.kpis.won_this_month_count === expWonThisMonth, `got ${dash.kpis.won_this_month_count} exp ${expWonThisMonth}`);
  check("activity feed capped at 15", dash.activity.length === 15, "got " + dash.activity.length);

  // ---------- Test 3: stale list + note removes it ----------
  section("Test 3 — Stale leads list, adding a note clears it");
  const staleBefore = dash.stale.map((s) => s.id);
  check("StaleTarget (15d silent, open) appears in stale list", staleBefore.includes(staleTargetId),
    `stale ids: ${staleBefore.length}`);
  const staleItem = dash.stale.find((s) => s.id === staleTargetId);
  check("StaleTarget days_silent ~15", staleItem && staleItem.days_silent >= 14 && staleItem.days_silent <= 16,
    staleItem ? "days=" + staleItem.days_silent : "missing");
  await a.post(`/api/leads/${staleTargetId}/notes`, { note: "reached out today" });
  const dash2 = (await a.get("/api/dashboard")).data;
  check("after note, StaleTarget removed from stale list", !dash2.stale.map((s) => s.id).includes(staleTargetId));
  check("note appears in activity feed", dash2.activity.some((e) => e.type === "note" && e.lead_name === "StaleTarget"));

  // ---------- Test 4/5: tenant isolation + empty state ----------
  section("Test 4/5 — Tenant isolation + empty-state on fresh tenant");
  const b = new Client();
  await b.post("/api/auth/register", { business_name: "FreshCo", name: "Bee", email: `fresh-${uniq}@seed.test`, password: "freshpass123" });
  const bdash = (await b.get("/api/dashboard")).data;
  check("fresh tenant open_count = 0", bdash.kpis.open_count === 0);
  check("fresh tenant funnel all zero", bdash.funnel.every((f) => f.count === 0 && f.value === 0));
  check("fresh tenant weekly all zero", eq(bdash.weekly.created, [0,0,0,0,0,0,0,0]) && eq(bdash.weekly.won, [0,0,0,0,0,0,0,0]));
  check("fresh tenant sources all zero", bdash.sources.every((s) => s.count === 0) && bdash.sources.length === 5);
  check("fresh tenant stale + activity empty", bdash.stale.length === 0 && bdash.activity.length === 0);
  check("fresh tenant win-rate inputs zero (n=0)", bdash.kpis.won_all === 0 && bdash.kpis.lost_all === 0);
  check("isolation: B sees none of A's leads in activity", !bdash.activity.some((e) => /Lead|StaleTarget/.test(e.lead_name || "")));

  console.log(out.join("\n"));
  console.log(`\n${pass} passed, ${fail} failed.`);
  process.exit(fail ? 1 : 0);
}

main().catch((e) => { console.error("FATAL", e); process.exit(2); });
