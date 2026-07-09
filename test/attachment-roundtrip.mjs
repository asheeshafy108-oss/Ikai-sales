// Attachment R2 roundtrip test against a running dev server (default :8787).
// Registers a tenant, creates a lead, uploads a REAL PDF, downloads it back and
// byte-compares, then confirms the file route requires a session (no cookie -> 401).
const BASE = process.env.BASE_URL || "http://localhost:8787";

let pass = 0, fail = 0;
const log = [];
function check(name, cond, detail = "") {
  if (cond) { pass++; log.push(`  ✅ ${name}`); }
  else { fail++; log.push(`  ❌ ${name}${detail ? " — " + detail : ""}`); }
}

// Build a minimal but structurally valid, openable single-page PDF with a correct
// xref table (byte offsets computed as we go).
function makePdf() {
  const enc = (s) => Buffer.from(s, "latin1");
  const objs = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>",
    null, // stream object built below
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  ];
  const streamContent = "BT /F1 24 Tf 72 700 Td (ikai-sales attachment roundtrip) Tj ET";
  objs[3] = `<< /Length ${streamContent.length} >>\nstream\n${streamContent}\nendstream`;

  let pdf = Buffer.from("%PDF-1.4\n", "latin1");
  const offsets = [];
  objs.forEach((body, i) => {
    offsets[i] = pdf.length;
    pdf = Buffer.concat([pdf, enc(`${i + 1} 0 obj\n${body}\nendobj\n`)]);
  });
  const xrefStart = pdf.length;
  let xref = `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n`;
  for (let i = 0; i < objs.length; i++) xref += String(offsets[i]).padStart(10, "0") + " 00000 n \n";
  const trailer = `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xrefStart}\n%%EOF\n`;
  return Buffer.concat([pdf, enc(xref), enc(trailer)]);
}

function grabCookie(res) {
  const sc = res.headers.get("set-cookie");
  if (!sc) return null;
  const sid = sc.split(";")[0];
  return sid.startsWith("sid=") ? sid : null;
}

async function main() {
  const uniq = Date.now() + "-" + Math.floor(Math.random() * 1e6);
  const pdf = makePdf();
  check("generated a real PDF (%PDF header + %%EOF)",
    pdf.subarray(0, 5).toString() === "%PDF-" && pdf.subarray(-6).toString().trim() === "%%EOF",
    `head=${pdf.subarray(0,8)} size=${pdf.length}`);

  // 1) register -> session cookie
  const reg = await fetch(BASE + "/api/auth/register", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ business_name: "ikai-r2", name: "R2 Tester", email: `r2-${uniq}@ikai.test`, password: "supersecret1" }),
    redirect: "manual",
  });
  const cookie = grabCookie(reg);
  check("register 200 + session cookie", reg.status === 200 && !!cookie, `status ${reg.status}`);

  // 2) create a lead (needs a stage_id)
  const stagesRes = await fetch(BASE + "/api/stages", { headers: { cookie } });
  const stages = (await stagesRes.json()).stages || [];
  const leadRes = await fetch(BASE + "/api/leads", {
    method: "POST", headers: { "content-type": "application/json", cookie },
    body: JSON.stringify({ name: "Attachment Lead", company: "Acme", source: "manual", stage_id: stages[0]?.id }),
  });
  const lead = (await leadRes.json()).lead;
  check("lead created (201)", leadRes.status === 201 && !!lead?.id, `status ${leadRes.status}`);

  // 3) upload the PDF (multipart, field "file")
  const fd = new FormData();
  fd.append("file", new Blob([pdf], { type: "application/pdf" }), "roundtrip.pdf");
  const up = await fetch(`${BASE}/api/leads/${lead.id}/files`, { method: "POST", headers: { cookie }, body: fd });
  const upData = await up.json().catch(() => ({}));
  check("upload 201 + ok", up.status === 201 && upData.ok === true, `status ${up.status} ${JSON.stringify(upData)}`);
  check("upload reports correct size", upData.size === pdf.length, `got ${upData.size} want ${pdf.length}`);
  const aid = upData.id;

  // 4) download it back and byte-compare
  const dl = await fetch(`${BASE}/api/files/${aid}`, { headers: { cookie } });
  const back = Buffer.from(await dl.arrayBuffer());
  check("download 200", dl.status === 200, `status ${dl.status}`);
  check("download content-type is application/pdf", (dl.headers.get("content-type") || "").includes("application/pdf"));
  check("download content-disposition attachment; filename", /attachment; filename="roundtrip\.pdf"/.test(dl.headers.get("content-disposition") || ""));
  check("downloaded bytes are byte-for-byte identical", back.length === pdf.length && back.equals(pdf),
    `back=${back.length} orig=${pdf.length}`);

  // 5) NO SESSION -> 401 on the file route
  const noAuth = await fetch(`${BASE}/api/files/${aid}`, { redirect: "manual" });
  const noAuthBody = await noAuth.json().catch(() => ({}));
  check("no-session GET file route -> 401", noAuth.status === 401, `status ${noAuth.status} ${JSON.stringify(noAuthBody)}`);

  // also confirm no-session upload is blocked
  const fd2 = new FormData();
  fd2.append("file", new Blob([pdf], { type: "application/pdf" }), "x.pdf");
  const noAuthUp = await fetch(`${BASE}/api/leads/${lead.id}/files`, { method: "POST", body: fd2 });
  check("no-session POST upload -> 401", noAuthUp.status === 401, `status ${noAuthUp.status}`);

  console.log("\n" + log.join("\n"));
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}
main().catch((e) => { console.error("FATAL", e); process.exit(2); });
