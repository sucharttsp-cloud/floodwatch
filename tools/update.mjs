// รันใน GitHub Actions ทุก 5 นาที
// 1) ดึง ThaiWater ฝั่งเซิร์ฟเวอร์ → docs/data/thaiwater.json (ThaiWater ตอบ 429 ให้หน้าเว็บจากโดเมนภายนอก)
// 2) เช็คเงื่อนไขแจ้งเตือน → ส่ง LINE เฉพาะตอนสถานการณ์เปลี่ยน → docs/data/alert-state.json
//    สถานะรอบก่อนอ่านจากไฟล์ที่ publish ไว้บน Pages รอบที่แล้ว
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const SITE = "https://sucharttsp-cloud.github.io/floodwatch/";
const TOKEN = process.env.LINE_CHANNEL_ACCESS_TOKEN || "";
const TEST = process.env.ALERT_TEST === "true";
const COOLDOWN = 3 * 3600e3; // เงื่อนไขเดิมกลับมาภายใน 3 ชม. ไม่ส่งซ้ำ

const page = await readFile(path.join(root, "page.html"), "utf8");
const Core = new Function(page.match(/<script id="core">([\s\S]*?)<\/script>/)[1] + "; return Core;")();

const getJson = async url => {
  const ctl = new AbortController(); const to = setTimeout(() => ctl.abort(), 30000);
  try {
    const r = await fetch(url, { signal: ctl.signal });
    if (!r.ok) throw new Error(`${r.status} ${url}`);
    return await r.json();
  } finally { clearTimeout(to); }
};

const raw = await Core.collect(getJson);
if (raw.errors.length) console.log("errors:", raw.errors);
await mkdir(path.join(root, "docs", "data"), { recursive: true });
if (raw.tw || raw.rain) {
  await writeFile(path.join(root, "docs", "data", "thaiwater.json"), JSON.stringify({ at: raw.at, tw: raw.tw || null, rain: raw.rain || null }));
}

// ---- เงื่อนไขแจ้งเตือน (ไม่รวมน้ำเกินตลิ่งตอนน้ำหนุนปกติ — ดูที่หน้าเว็บอย่างเดียว) ----
const vm = Core.analyze(raw);
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

let prev = { active: {}, sent: {} };
try { const r = await fetch(SITE + "data/alert-state.json?t=" + Date.now()); if (r.ok) prev = await r.json(); } catch (e) { /* รอบแรก */ }
const now = Date.now();
const sent = { ...(prev.sent || {}) };
const fresh = Object.keys(active).filter(k => !(k in (prev.active || {})) && !(sent[k] && now - sent[k] < COOLDOWN));
const cleared = Object.keys(prev.active || {}).length > 0 && Object.keys(active).length === 0;

const hm = t => new Date(t).toLocaleTimeString("th-TH", { hour: "2-digit", minute: "2-digit", timeZone: "Asia/Bangkok" });
let text = null;
if (TEST) text = `ทดสอบแจ้งเตือนน้ำรอบบ้าน ✅\nสถานะตอนนี้: ${{ ok: "ปกติ", watch: "เฝ้าระวัง", alert: "มีน้ำท่วมใกล้บ้าน", stale: "ข้อมูลไม่สด" }[vm.level]} (${hm(now)})\n${SITE}`;
else if (fresh.length) text = `แจ้งเตือนน้ำรอบบ้าน สุขสวัสดิ์ 64 (${hm(now)})\n\n${fresh.map(k => active[k]).join("\n")}\n\nดูรายละเอียด: ${SITE}`;
else if (cleared) text = `✅ น้ำรอบบ้านกลับมาปกติแล้ว (${hm(now)})\n${SITE}`;

if (text) {
  if (!TOKEN) console.log("ไม่มี LINE token — ข้อความที่จะส่ง:\n" + text);
  else {
    const r = await fetch("https://api.line.me/v2/bot/message/broadcast", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer " + TOKEN },
      body: JSON.stringify({ messages: [{ type: "text", text }] })
    });
    console.log("LINE", r.status, await r.text());
    // ส่งไม่สำเร็จ: ไม่ทำให้ทั้งงานล้ม (ข้อมูล ThaiWater ยังต้อง deploy) แต่ไม่บันทึกว่าแจ้งแล้ว รอบหน้าจะลองใหม่
    if (r.ok) for (const k of fresh) sent[k] = now;
    else { console.error("::warning::ส่ง LINE ไม่สำเร็จ"); for (const k of fresh) delete active[k]; }
  }
}
await writeFile(path.join(root, "docs", "data", "alert-state.json"), JSON.stringify({ at: now, level: vm.level, active, sent }));
console.log("level", vm.level, "active", Object.keys(active), "fresh", fresh, "cleared", cleared);
