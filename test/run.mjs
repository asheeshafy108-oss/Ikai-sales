// End-to-end tests against a running dev server (default http://localhost:8787).
// Stateful: each Client keeps its own cookie jar (simulates a browser session).
const BASE = process.env.BASE_URL || "http://localhost:8787";

let pass = 0, fail = 0;
const results = [];
function check(name, cond, detail = "") {
  if (cond) { pass++; results.push(`  ✅ ${name}`); }
  else { fail++; results.push(`  ❌ ${name}${detail ? " — " + detail : ""}`); }
}
function section(t) { results.push(`\n▶ ${t}`); }

class Client {
  constructor() { this.cookie = null; }
  async req(method, path, body) {
    const headers = { "content-type": "application/json" };
    if (this.cookie) headers.cookie = this.cookie;
    const r = await fetch(BASE + path, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      redirect: "manual",
    });
    const setCookie = r.headers.get("set-cookie");
    if (setCookie) {
      const sid = setCookie.split(";")[0];
      if (sid.startsWith("sid=") && !sid.endsWith("sid=")) this.cookie = sid;
      if (/sid=;/.test(setCookie)) this.cookie = null; // logout
    }
    let data = null;
    try { data = await r.json(); } catch {}
    return { status: r.status, data };
  }
  get(p) { return this.req("GET", p); }
  post(p, b) { return this.req("POST", p, b); }
  patch(p, b) { return this.req("PATCH", p, b); }
}

const uniq = Date.now() + "-" + Math.floor(Math.random() * 1e6);

async function main() {
  // ---- Test 1: register business ikai ----
  section("Test 1 — Register business + auto-seeded stages");
  const owner = new Client();
  const ownerEmail = `owner-${uniq}@ikai.test`;
  let r = await owner.post("/api/auth/register", {
    business_name: "ikai", name: "Owner One", email: ownerEmail, password: "supersecret1",
  });
  check("register returns 200", r.status === 200, `status ${r.status} ${JSON.stringify(r.data)}`);
  const me = await owner.get("/api/me");
  check("owner role is owner", me.data.role === "owner");
  check("tenant name is ikai", me.data.tenant?.name === "ikai");
  const stagesRes = await owner.get("/api/stages");
  const stageNames = (stagesRes.data.stages || []).map((s) => s.name);
  check("6 stages seeded in order",
    JSON.stringify(stageNames) === JSON.stringify(["New", "Contacted", "Consult booked", "Proposal", "Won", "Lost"]),
    JSON.stringify(stageNames));
  const leads0 = await owner.get("/api/leads");
  check("dashboard loads empty", (leads0.data.leads || []).length === 0);
  const stages = stagesRes.data.stages;
  const byName = (n) => stages.find((s) => s.name === n);

  // ---- Test 2: create 8 leads across stages with values ----
  section("Test 2 — Create 8 leads, verify counts/totals");
  const spec = [
    ["Alice", "Acme", "New", 100000],
    ["Bob", "Beta", "New", 250000],
    ["Carol", "Cirrus", "Contacted", 50000],
    ["Dan", "Delta", "Contacted", null],
    ["Eve", "Echo", "Consult booked", 300000],
    ["Frank", "Foxtrot", "Proposal", 500000],
    ["Grace", "Gamma", "Won", 750000],
    ["Heidi", "Helix", "Lost", 20000],
  ];
  const created = [];
  for (const [name, company, stageN, valueCents] of spec) {
    const res = await owner.post("/api/leads", {
      name, company, source: "manual", stage_id: byName(stageN).id,
      value_cents: valueCents,
    });
    if (res.status === 201) created.push(res.data.lead);
    else check(`create lead ${name}`, false, JSON.stringify(res.data));
  }
  check("8 leads created", created.length === 8);
  const board = await owner.get("/api/leads");
  const inStage = (n) => board.data.leads.filter((l) => l.stage_id === byName(n).id).length;
  check("New has 2", inStage("New") === 2, "got " + inStage("New"));
  check("Contacted has 2", inStage("Contacted") === 2);
  check("Won has 1", inStage("Won") === 1);
  const totalPipeline = board.data.leads.reduce((s, l) => s + (l.value_cents || 0), 0);
  check("total pipeline value = 1,970,000c", totalPipeline === 1970000, "got " + totalPipeline);

  // ---- Test 3: move a lead New -> Contacted -> Consult booked, events recorded ----
  section("Test 3 — Stage moves write lead_events");
  const alice = created.find((l) => l.name === "Alice");
  let mv = await owner.patch(`/api/leads/${alice.id}`, { stage_id: byName("Contacted").id });
  check("move 1 ok (stage=Contacted)", mv.data.lead?.stage_id === byName("Contacted").id);
  // Ensure the two moves get distinct created_at timestamps (nowISO is ms-precision)
  // so newest-first ordering is well-defined rather than a same-ms tie.
  await new Promise((r) => setTimeout(r, 50));
  mv = await owner.patch(`/api/leads/${alice.id}`, { stage_id: byName("Consult booked").id });
  check("move 2 ok (stage=Consult booked)", mv.data.lead?.stage_id === byName("Consult booked").id);
  const detail = await owner.get(`/api/leads/${alice.id}`);
  const evs = detail.data.events;
  // The endpoint returns events newest-first (ORDER BY created_at DESC), so the
  // most recent stage change (Contacted->Consult booked) is index 0. Sort by
  // created_at DESC defensively so the assertion never depends on DB tie-order.
  const stageChanges = evs
    .filter((e) => e.type === "stage_change")
    .sort((a, b) => (a.created_at < b.created_at ? 1 : a.created_at > b.created_at ? -1 : 0));
  check("has created event", evs.some((e) => e.type === "created"));
  check("2 stage_change events", stageChanges.length === 2, "got " + stageChanges.length);
  check("latest change Contacted->Consult booked",
    stageChanges[0].from_stage === byName("Contacted").id && stageChanges[0].to_stage === byName("Consult booked").id);
  check("earlier change New->Contacted",
    stageChanges[1].from_stage === byName("New").id && stageChanges[1].to_stage === byName("Contacted").id);

  // ---- Test 4: invite + join as member ----
  section("Test 4 — Invite flow, member joins same tenant, owner-only enforced");
  const inv = await owner.post("/api/invites", {});
  check("owner can create invite", inv.status === 201 && !!inv.data.link, JSON.stringify(inv.data));
  const token = new URL(inv.data.link).searchParams.get("token");
  const member = new Client();
  const memberEmail = `member-${uniq}@ikai.test`;
  const joinRes = await member.post("/api/join", {
    token, name: "Member Mary", email: memberEmail, password: "memberpass1",
  });
  check("join returns 200", joinRes.status === 200, JSON.stringify(joinRes.data));
  const memberMe = await member.get("/api/me");
  check("member role is member", memberMe.data.role === "member");
  check("member same tenant as owner", memberMe.data.tenant?.id === me.data.tenant?.id);
  const memberLeads = await member.get("/api/leads");
  check("member sees the 8 leads", memberLeads.data.leads.length === 8, "got " + memberLeads.data.leads.length);
  const memberInvite = await member.post("/api/invites", {});
  check("member CANNOT create invite (403)", memberInvite.status === 403, "got " + memberInvite.status);

  // ---- Test 5: tenant isolation ----
  section("Test 5 — Tenant isolation");
  const owner2 = new Client();
  await owner2.post("/api/auth/register", {
    business_name: "OtherCorp", name: "Owner Two", email: `owner2-${uniq}@other.test`, password: "othersecret1",
  });
  const o2leads = await owner2.get("/api/leads");
  check("second tenant sees zero leads", o2leads.data.leads.length === 0, "got " + o2leads.data.leads.length);
  const crossGet = await owner2.get(`/api/leads/${alice.id}`);
  check("cross-tenant GET lead returns 404", crossGet.status === 404, "got " + crossGet.status);
  const crossPatch = await owner2.patch(`/api/leads/${alice.id}`, { name: "hacked" });
  check("cross-tenant PATCH lead returns 404", crossPatch.status === 404, "got " + crossPatch.status);
  // confirm not mutated
  const stillAlice = await owner.get(`/api/leads/${alice.id}`);
  check("victim lead not mutated", stillAlice.data.lead.name === "Alice");

  // ---- Test 6: auth errors + rate limit + session ----
  section("Test 6 — Wrong password, rate limit, session persistence, logout");
  const wrong = await new Client().post("/api/auth/login", { email: ownerEmail, password: "nope" });
  check("wrong password 401 generic", wrong.status === 401 && /invalid/i.test(wrong.data.error || ""), JSON.stringify(wrong.data));
  // hammer: emails must be a fresh account so we don't lock the owner used later
  const rlEmail = `rl-${uniq}@ikai.test`;
  const rlClient = new Client();
  await rlClient.post("/api/auth/register", { business_name: "RL", name: "RL", email: rlEmail, password: "rlpassword1" });
  await rlClient.post("/api/auth/logout", {});
  let got429 = false, statuses = [];
  for (let i = 0; i < 6; i++) {
    const a = await new Client().post("/api/auth/login", { email: rlEmail, password: "badpass" });
    statuses.push(a.status);
    if (a.status === 429) got429 = true;
  }
  check("6th wrong attempt returns 429", got429, "statuses: " + statuses.join(","));
  // session persistence: reuse cookie
  const persist = await owner.get("/api/me");
  check("session survives reuse", persist.status === 200 && persist.data.role === "owner");
  // logout kills session
  const logoutClient = new Client();
  await logoutClient.post("/api/auth/register", { business_name: "LO", name: "LO", email: `lo-${uniq}@ikai.test`, password: "lopassword1" });
  const beforeLogout = await logoutClient.get("/api/me");
  await logoutClient.post("/api/auth/logout", {});
  const afterLogout = await logoutClient.get("/api/me");
  check("logout invalidates session", beforeLogout.status === 200 && afterLogout.status === 401, `before ${beforeLogout.status} after ${afterLogout.status}`);

  // ---- Test 7: CSV import ----
  section("Test 7 — CSV import (rows[])");
  const importRows = [
    { name: "Iris", company: "Iceberg", email: "iris@x.com", phone: "123", value: "1234.50", notes: "hot" },
    { name: "Jack", company: "Juno", email: "", phone: "", value: "999", notes: "" },
    { name: "", company: "NoName", email: "", phone: "", value: "1", notes: "should skip" },
  ];
  const imp = await owner.post("/api/leads/import", { rows: importRows });
  check("import reports 2 imported (nameless skipped)", imp.data.imported === 2, JSON.stringify(imp.data));
  const afterImport = await owner.get("/api/leads");
  const csvLeads = afterImport.data.leads.filter((l) => l.source === "csv");
  check("2 csv-source leads exist", csvLeads.length === 2, "got " + csvLeads.length);
  const iris = csvLeads.find((l) => l.name === "Iris");
  check("Iris value = 123450 cents", iris && iris.value_cents === 123450, iris ? iris.value_cents : "missing");
  const badImport = await owner.post("/api/leads/import", { notrows: true });
  check("malformed import rejected", badImport.status === 400);

  // ---- summary ----
  console.log(results.join("\n"));
  console.log(`\n${pass} passed, ${fail} failed.`);
  process.exit(fail ? 1 : 0);
}

main().catch((e) => { console.error("FATAL", e); process.exit(2); });
