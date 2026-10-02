// ดึงระดับน้ำ + ฝนจาก ThaiWater ฝั่งเซิร์ฟเวอร์ (รันใน GitHub Actions ทุก 5 นาที)
// ThaiWater ตอบ 429 ให้หน้าเว็บที่เปิดจากโดเมนภายนอก หน้าบน GitHub Pages เลยอ่านไฟล์นี้แทน
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const page = await readFile(path.join(root, "page.html"), "utf8");
const Core = new Function(page.match(/<script id="core">([\s\S]*?)<\/script>/)[1] + "; return Core;")();

const getJson = async url => {
  if (!url.includes("thaiwater.net")) throw new Error("skip"); // ไฟล์นี้เก็บเฉพาะ ThaiWater
  const ctl = new AbortController(); const to = setTimeout(() => ctl.abort(), 30000);
  try {
    const r = await fetch(url, { signal: ctl.signal });
    if (!r.ok) throw new Error(`${r.status} ${url}`);
    return await r.json();
  } finally { clearTimeout(to); }
};

const raw = await Core.collect(getJson);
if (!raw.tw && !raw.rain) { console.error("ThaiWater ดึงไม่ได้:", raw.errors); process.exit(1); }
await mkdir(path.join(root, "docs", "data"), { recursive: true });
await writeFile(path.join(root, "docs", "data", "thaiwater.json"), JSON.stringify({ at: raw.at, tw: raw.tw || null, rain: raw.rain || null }));
console.log("ok", new Date(raw.at).toISOString(), (raw.tw || []).map(s => s.name + " " + s.level));
