import puppeteer from "puppeteer-core";
const BASE = "http://localhost:8787";
const CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const uniq = Date.now();
const browser = await puppeteer.launch({ executablePath: CHROME, headless: "new", args: ["--no-sandbox"] });
const page = await browser.newPage();
await page.setViewport({ width: 1280, height: 800, deviceScaleFactor: 2 });
await page.goto(BASE + "/", { waitUntil: "networkidle0" });
await page.screenshot({ path: "/tmp/ikai-login.png" });
await page.click("#showRegister");
await page.type("#rg-business", "ikai");
await page.type("#rg-name", "Shaheer");
await page.type("#rg-email", `shot-${uniq}@ikai.test`);
await page.type("#rg-password", "shotpassword1");
await Promise.all([page.waitForNavigation({ waitUntil: "networkidle0" }), page.click("#registerForm button[type=submit]")]);
await page.waitForSelector(".col");
// seed a handful of leads across stages
const stages = await page.evaluate(async () => (await (await fetch("/api/stages")).json()).stages);
const specs = [["Alice","Acme","New",1200],["Bob","Beta","New",3400],["Carol","Cirrus","Contacted",800],["Eve","Echo","Consult booked",5000],["Frank","Foxtrot","Proposal",9000],["Grace","Gamma","Won",7500]];
for (const [name,company,sn,val] of specs) {
  const sid = stages.find(s=>s.name===sn).id;
  await page.evaluate(async (b) => { await fetch("/api/leads",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify(b)}); }, {name,company,source:"manual",stage_id:sid,value:val});
}
await page.reload({ waitUntil: "networkidle0" });
// Dashboard tab (default) — desktop
await page.waitForSelector("#funnelChart .funnel-row");
await page.screenshot({ path: "/tmp/ikai-dashboard.png" });
// Pipeline tab — desktop
await page.click("#tabPipeline");
await page.waitForSelector(".card");
await page.screenshot({ path: "/tmp/ikai-board.png" });
// Dashboard — mobile 390px
await page.setViewport({ width: 390, height: 900, deviceScaleFactor: 2 });
await page.reload({ waitUntil: "networkidle0" });
await page.waitForSelector("#funnelChart .funnel-row");
await page.screenshot({ path: "/tmp/ikai-dash-mobile.png", fullPage: true });
console.log("screenshots written");
await browser.close();
