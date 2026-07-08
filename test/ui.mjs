// Browser smoke test: renders app.html, drives the board, checks 390px scroll.
// Fails on any console error or page error.
import puppeteer from "puppeteer-core";

const BASE = process.env.BASE_URL || "http://localhost:8787";
const CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";

const results = [];
let fail = 0;
function check(name, cond, detail = "") {
  if (cond) results.push(`  ✅ ${name}`);
  else { fail++; results.push(`  ❌ ${name}${detail ? " — " + detail : ""}`); }
}

const uniq = Date.now();

const browser = await puppeteer.launch({ executablePath: CHROME, headless: "new", args: ["--no-sandbox"] });
const page = await browser.newPage();

const consoleErrors = [];
page.on("console", (m) => { if (m.type() === "error") consoleErrors.push(m.text()); });
page.on("pageerror", (e) => consoleErrors.push("pageerror: " + e.message));

try {
  // 1. register via the UI
  await page.goto(BASE + "/", { waitUntil: "networkidle0" });
  await page.click("#showRegister");
  await page.type("#rg-business", "ikai UI");
  await page.type("#rg-name", "UI Owner");
  await page.type("#rg-email", `ui-${uniq}@ikai.test`);
  await page.type("#rg-password", "uipassword1");
  await Promise.all([
    page.waitForNavigation({ waitUntil: "networkidle0" }),
    page.click("#registerForm button[type=submit]"),
  ]);
  check("register redirects to /app", page.url().endsWith("/app"), page.url());

  // 1b. Dashboard is the default tab and renders empty-state widgets (fresh tenant).
  await page.waitForSelector("#dashboardView:not(.hidden)", { timeout: 5000 });
  await page.waitForFunction(() => document.querySelectorAll("#kpiRow .kpi-card").length === 4, { timeout: 5000 });
  const winRate = await page.$$eval("#kpiRow .k-value", (e) => e.map((x) => x.textContent));
  check("dashboard default: 4 KPI cards, win-rate shows — when no closed deals", winRate.length === 4 && winRate.includes("—"), JSON.stringify(winRate));
  const emptyStates = await page.$$eval("#dashboardView .panel-empty", (e) => e.length);
  check("empty-state text renders in funnel/source/stale panels", emptyStates >= 3, "empties=" + emptyStates);
  const dashErrors = consoleErrors.length;
  check("dashboard renders with no console errors", dashErrors === 0, consoleErrors.join(" | "));

  // 2. Pipeline tab → board renders 6 columns
  await page.click("#tabPipeline");
  await page.waitForSelector("#pipelineView:not(.hidden)", { timeout: 5000 });
  await page.waitForSelector(".col", { timeout: 5000 });
  const cols = await page.$$eval(".col .col-head .name", (els) => els.map((e) => e.textContent));
  check("board renders 6 stage columns", cols.length === 6, JSON.stringify(cols));

  // 3. add a lead through the modal
  await page.click("#addLeadBtn");
  await page.waitForSelector("#addOverlay:not(.hidden)");
  await page.type("#a-name", "Smoke Lead");
  await page.type("#a-company", "Smokestack");
  await page.type("#a-value", "4200");
  await page.click("#addForm button[type=submit]");
  await page.waitForFunction(() => document.querySelectorAll(".card").length >= 1, { timeout: 5000 });
  const cardCount = await page.$$eval(".card", (c) => c.length);
  check("lead card appears on board", cardCount >= 1, "cards=" + cardCount);
  const valueShown = await page.$$eval(".lead-value", (e) => e.map((x) => x.textContent).join("|"));
  check("lead value renders as $4,200", /\$4,200/.test(valueShown), valueShown);

  // 4. open drawer
  await page.click(".card .open-lead");
  await page.waitForSelector("#drawerOverlay:not(.hidden)", { timeout: 5000 });
  const drawerName = await page.$eval("#d-name", (e) => e.value);
  check("drawer opens with lead data", drawerName === "Smoke Lead", drawerName);
  // add a note
  await page.type("#d-note-input", "smoke note");
  await page.click("#d-add-note");
  await page.waitForFunction(() => document.querySelectorAll("#d-events .event").length >= 2, { timeout: 5000 });
  const events = await page.$$eval("#d-events .event", (e) => e.length);
  check("note appears in timeline", events >= 2, "events=" + events);
  await page.click('[data-close="drawerOverlay"]');

  // 5. move lead right via ▶
  const beforeMove = await page.$$eval(".col", (cols) =>
    cols.map((c) => c.querySelectorAll(".card").length));
  await page.click(".card .move-next");
  await page.waitForFunction(
    (before) => JSON.stringify([...document.querySelectorAll(".col")].map((c) => c.querySelectorAll(".card").length)) !== JSON.stringify(before),
    { timeout: 5000 },
    beforeMove,
  );
  check("move ▶ shifts card to next column", true);

  // 6. settings modal + invite
  await page.click("#settingsBtn");
  await page.waitForSelector("#settingsOverlay:not(.hidden)");
  const stageItems = await page.$$eval("#stageList li", (e) => e.length);
  check("settings shows 6 stages", stageItems === 6, "got " + stageItems);
  await page.click("#genInvite");
  await page.waitForFunction(() => !document.getElementById("inviteResult").classList.contains("hidden"), { timeout: 5000 });
  const link = await page.$eval("#inviteLink", (e) => e.value);
  check("invite link generated", /\/join\?token=/.test(link), link);
  await page.click('[data-close="settingsOverlay"]');

  // 6b. Dashboard tab now populated: funnel bars + charts render (SVG), activity feed non-empty.
  await page.click("#tabDashboard");
  await page.waitForSelector("#dashboardView:not(.hidden)", { timeout: 5000 });
  await page.waitForFunction(() => document.querySelectorAll("#funnelChart .funnel-row").length === 6, { timeout: 5000 });
  const funnelBars = await page.$$eval("#funnelChart svg.bar", (e) => e.length);
  check("dashboard funnel renders 6 SVG bars once populated", funnelBars === 6, "bars=" + funnelBars);
  const flowLines = await page.$$eval("#flowChart svg polyline", (e) => e.length);
  check("flow chart renders 2 SVG polylines (created + won)", flowLines === 2, "lines=" + flowLines);
  const feed = await page.$$eval("#activityFeed .feed-item", (e) => e.length);
  check("activity feed shows events", feed >= 1, "feed=" + feed);

  // 7. 390px mobile: dashboard usable, then board horizontally scrollable
  await page.setViewport({ width: 390, height: 800 });
  const kpiStack = await page.$eval("#kpiRow", (r) => r.scrollWidth <= r.clientWidth + 1);
  check("390px: KPI row fits (no horizontal overflow)", kpiStack);
  await page.click("#tabPipeline");
  await page.waitForSelector("#pipelineView:not(.hidden)", { timeout: 5000 });
  await page.waitForFunction(() => {
    const b = document.getElementById("board");
    return b && b.scrollWidth > b.clientWidth;
  }, { timeout: 5000 }).then(() => check("board scrolls horizontally at 390px", true))
    .catch(() => {
      check("board scrolls horizontally at 390px", false, "scrollWidth not > clientWidth");
    });
  const scrollInfo = await page.$eval("#board", (b) => ({ sw: b.scrollWidth, cw: b.clientWidth }));
  check("390px board overflow confirmed", scrollInfo.sw > scrollInfo.cw, JSON.stringify(scrollInfo));
  // modal usable at 390px
  await page.click("#addLeadBtn");
  await page.waitForSelector("#addOverlay:not(.hidden)");
  const modalFits = await page.$eval(".modal", (m) => m.getBoundingClientRect().width <= 390);
  check("add-lead modal fits within 390px", modalFits);

  check("no console/page errors", consoleErrors.length === 0, consoleErrors.join(" | "));
} catch (e) {
  check("UI script ran without exception", false, e.message);
  console.error(e);
} finally {
  console.log(results.join("\n"));
  console.log(`\n${results.length - fail}/${results.length} UI checks passed.`);
  await browser.close();
  process.exit(fail ? 1 : 0);
}
