// ตัวแจ้งเตือน LINE รันบน NAS (อยู่ในไทย จึงดึงเซ็นเซอร์ถนน กทม. ได้ — กทม. ตอบ 403 ให้เซิร์ฟเวอร์ GitHub)
// ใช้กฎชุดเดียวกับหน้าเว็บ: อ่าน Core จาก /site/index.html (ไฟล์เดียวกับที่ nginx เสิร์ฟ)
// ส่งเฉพาะตอนสถานการณ์เปลี่ยน · สถานะเก็บที่ /data/state.json
import { readFile, writeFile } from "node:fs/promises";

const SITE = "https://sucharttsp-cloud.github.io/floodwatch/";
const TOKEN = (process.env.LINE_CHANNEL_ACCESS_TOKEN || "").trim();
const EVERY = (+process.env.CHECK_MINUTES || 5) * 60e3;
const COOLDOWN = 3 * 3600e3; // เงื่อนไขเดิมกลับมาภายใน 3 ชม. ไม่ส่งซ้ำ
const STATE = process.env.STATE_FILE || "/data/state.json";
const PAGE = process.env.PAGE_FILE || "/site/index.html";
// สั่งให้ GitHub Actions ดึง ThaiWater + deploy หน้าเว็บสาธารณะ (งานตั้งเวลาของ GitHub ไม่ค่อยรันตามเวลา)
// ทุก 10 นาที = 6 ครั้ง/ชม. ต่ำกว่าเพดาน deploy ของ GitHub Pages
const GH_TOKEN = (process.env.GITHUB_DISPATCH_TOKEN || "").trim();
const GH_EVERY = 10 * 60e3;
let lastDispatch = 0;

const log = (...a) => console.log(new Date().toLocaleString("th-TH", { timeZone: "Asia/Bangkok" }), ...a);
const hm = t => new Date(t).toLocaleTimeString("th-TH", { hour: "2-digit", minute: "2-digit", timeZone: "Asia/Bangkok" });

async function loadCore() {
  const page = await readFile(PAGE, "utf8"); // อ่านใหม่ทุกรอบ อัปหน้าใหม่แล้วกฎตามทันที
  return new Function(page.match(/<script id="core">([\s\S]*?)<\/script>/)[1] + "; return Core;")();
}

async function getJson(url) {
  const ctl = new AbortController(); const to = setTimeout(() => ctl.abort(), 30000);
  try {
    const r = await fetch(url, { signal: ctl.signal });
    if (!r.ok) throw new Error(`${r.status} ${url}`);
    return await r.json();
  } finally { clearTimeout(to); }
}

async function readState() {
  try { return JSON.parse(await readFile(STATE, "utf8")); } catch (e) { return null; }
}

async function sendLine(text) {
  if (!TOKEN) { log("ยังไม่ได้ใส่ LINE_CHANNEL_ACCESS_TOKEN — ข้อความที่จะส่ง:\n" + text); return false; }
  const r = await fetch("https://api.line.me/v2/bot/message/broadcast", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: "Bearer " + TOKEN },
    body: JSON.stringify({ messages: [{ type: "text", text }] })
  });
  log("LINE", r.status, await r.text());
  return r.ok;
}

function activeAlerts(vm) {
  const active = {};
  for (const r of vm.roads) {
    if (!r.stale && r.depth != null && r.km <= 3.5 && r.depth > 10)
      active["road:" + r.code] = `🔴 ${r.name} น้ำท่วม ${r.depth.toFixed(0)} ซม.${r.d1h ? ` (${r.d1h > 0 ? "+" : ""}${r.d1h.toFixed(0)} ซม./ชม.)` : ""} · ห่างบ้าน ${r.km.toFixed(1)} กม.`;
  }
  for (const r of vm.rivers) {
    if (!r.stale && r.why && r.why.cls === "alert")
      active["river:" + r.id] = `⚠️ ${r.name} น้ำขึ้น +${r.d1h} ซม./ชม. ทั้งที่น้ำทะเลกำลังลง (ผิดปกติ) · ระดับ ${r.level.toFixed(2)} ม.`;
  }
  if (vm.forecast && vm.forecast.next3h >= 20)
    active["rain"] = `🌧 คาดว่าฝนแถวบ้านจะตก ${vm.forecast.next3h.toFixed(0)} มม. ใน 3 ชม.ข้างหน้า`;
  return active;
}

async function check() {
  const Core = await loadCore();
  const raw = await Core.collect(getJson);
  if (raw.errors.length) log("ดึงไม่ได้:", raw.errors.join(" | "));
  const vm = Core.analyze(raw);
  const active = activeAlerts(vm);
  const now = Date.now();
  const prev = await readState();

  // เริ่มครั้งแรก: ส่งข้อความยืนยันว่าต่อ LINE ได้
  if (!prev) {
    const word = { ok: "ปกติ", watch: "เฝ้าระวัง", alert: "มีน้ำท่วมใกล้บ้าน", stale: "ข้อมูลไม่สด" }[vm.level];
    const ok = await sendLine(`เริ่มแจ้งเตือนน้ำรอบบ้าน สุขสวัสดิ์ 64 แล้ว ✅\nสถานะตอนนี้: ${word} (${hm(now)})\nจะส่งข้อความเฉพาะตอนถนนใกล้บ้านน้ำท่วมเกิน 10 ซม. น้ำในคลองขึ้นผิดปกติ หรือคาดว่าฝนหนัก\n${SITE}`);
    if (!ok) return; // ไม่บันทึกสถานะ รอบหน้าลองใหม่
  }

  const prevActive = (prev && prev.active) || {};
  const sent = { ...((prev && prev.sent) || {}) };
  const fresh = Object.keys(active).filter(k => !(k in prevActive) && !(sent[k] && now - sent[k] < COOLDOWN));
  const cleared = Object.keys(prevActive).length > 0 && Object.keys(active).length === 0;

  let text = null;
  if (fresh.length) text = `แจ้งเตือนน้ำรอบบ้าน สุขสวัสดิ์ 64 (${hm(now)})\n\n${fresh.map(k => active[k]).join("\n")}\n\nดูรายละเอียด: ${SITE}`;
  else if (cleared) text = `✅ น้ำรอบบ้านกลับมาปกติแล้ว (${hm(now)})\n${SITE}`;
  if (text) {
    if (await sendLine(text)) for (const k of fresh) sent[k] = now;
    else for (const k of fresh) delete active[k]; // ส่งไม่สำเร็จ รอบหน้าลองใหม่
  }
  await writeFile(STATE, JSON.stringify({ at: now, level: vm.level, active, sent }));
  log("level", vm.level, "active", Object.keys(active).join(",") || "-", fresh.length ? "ส่งใหม่ " + fresh.join(",") : "");
}

async function dispatchPages() {
  if (!GH_TOKEN || Date.now() - lastDispatch < GH_EVERY) return;
  lastDispatch = Date.now();
  const r = await fetch("https://api.github.com/repos/sucharttsp-cloud/floodwatch/actions/workflows/pages.yml/dispatches", {
    method: "POST",
    headers: { Accept: "application/vnd.github+json", Authorization: "Bearer " + GH_TOKEN, "X-GitHub-Api-Version": "2022-11-28", "User-Agent": "floodwatch-nas" },
    body: JSON.stringify({ ref: "main" })
  });
  if (r.status !== 204) log("สั่ง GitHub อัปเดตไม่สำเร็จ", r.status, (await r.text()).slice(0, 200));
}

log(`เริ่มทำงาน เช็คทุก ${EVERY / 60e3} นาที · LINE token ${TOKEN ? "มีแล้ว" : "ยังไม่ได้ใส่"} · GitHub token ${GH_TOKEN ? "มีแล้ว (สั่งอัปเดตหน้าเว็บทุก 10 นาที)" : "ยังไม่ได้ใส่"}`);
for (;;) {
  try { await dispatchPages(); } catch (e) { log("สั่ง GitHub ผิดพลาด:", e && e.message || e); }
  try { await check(); } catch (e) { log("ผิดพลาด:", e && e.message || e); }
  await new Promise(r => setTimeout(r, EVERY));
}
