// สร้างหน้าแบบฝังภาพนิ่งข้อมูล (สำหรับ Artifact ที่ดึงข้อมูลสดเองไม่ได้)
// ใช้: /opt/homebrew/opt/node@24/bin/node build.mjs  → dist/flood-home.html
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

const dir = path.dirname(fileURLToPath(import.meta.url));
const page = await readFile(path.join(dir, "page.html"), "utf8");
const coreSrc = page.match(/<script id="core">([\s\S]*?)<\/script>/)[1];
const Core = new Function(coreSrc + "; return Core;")();

const getJson = async url => {
  const ctl = new AbortController(); const to = setTimeout(() => ctl.abort(), 30000);
  try {
    const r = await fetch(url, { signal: ctl.signal, headers: { "User-Agent": "floodwatch-home/1.0" } });
    if (!r.ok) throw new Error(`${r.status} ${url}`);
    return await r.json();
  } finally { clearTimeout(to); }
};

const raw = await Core.collect(getJson);
if (raw.errors.length) console.error("errors:", raw.errors);
const json = JSON.stringify(raw).replace(/</g, "\\u003c");
const out = page.replace("/*SNAPSHOT*/null/*END*/", json);
await mkdir(path.join(dir, "dist"), { recursive: true });
await writeFile(path.join(dir, "dist", "flood-home.html"), out);
const vm = Core.analyze(raw);
console.log(JSON.stringify({ bytes: out.length, level: vm.level, reasons: vm.reasons, roads: vm.roads.map(r => [r.name, r.km.toFixed(1), r.depth, r.d1h, r.stale]), rivers: vm.rivers.map(r => [r.name, r.level, r.d1h, r.margin, r.stale, r.why && r.why.text]), rain: vm.rain.map(r => [r.name, r.last, r.prev, r.stale]), forecast: vm.forecast && [vm.forecast.past2h, vm.forecast.next3h], tide: vm.tide && [vm.tide.rising, vm.tide.next.map(e => e.kind + " " + new Date(e.t).toISOString())] }, null, 1));
