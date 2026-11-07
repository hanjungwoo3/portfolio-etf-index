// 미국 하이일드 스프레드(ICE BofA US High Yield OAS, FRED BAMLH0A0HYM2) — 일별, 하루 늦게 나온다(사용자 2026-11-07 "하이일드 스프레드?").
//   FRED 그래프 CSV 는 키 없이 받는다. 브라우저에서 바로 받으려면 프록시 허용 목록 11곳을 고쳐야 해서 여기서 받아 파일로 둔다.
//   실패하면 어제 파일 그대로(빈 값으로 덮지 않는다).
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const DATA_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "data");
const OUT = path.join(DATA_DIR, "hy-spread.json");
const SERIES = "BAMLH0A0HYM2";
const KEEP_DAYS = 800;   // 약 2년 — 1년 그래프 + 여유

async function main() {
  const start = new Date(Date.now() - KEEP_DAYS * 86400_000).toISOString().slice(0, 10);
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 30_000);
  let text;
  try {
    const r = await fetch(`https://fred.stlouisfed.org/graph/fredgraph.csv?id=${SERIES}&cosd=${start}`, { signal: ctrl.signal, headers: { "User-Agent": "Mozilla/5.0" } });
    if (!r.ok) throw new Error(`FRED HTTP ${r.status}`);
    text = await r.text();
  } finally { clearTimeout(t); }
  const points = text.trim().split("\n").slice(1)
    .map(l => l.split(","))
    .filter(([d, v]) => /^\d{4}-\d{2}-\d{2}$/.test(d) && v && v !== "." && Number.isFinite(Number(v)))
    .map(([d, v]) => [d, Number(v)]);
  if (points.length < 50) throw new Error(`점이 너무 적다(${points.length}) — 어제 파일 유지`);
  await fs.mkdir(DATA_DIR, { recursive: true });
  await fs.writeFile(OUT, JSON.stringify({ meta: { builtAt: new Date().toISOString(), series: SERIES, unit: "%", source: "FRED" }, points }));
  console.log("hy-spread", points.length, points.at(-1));
}
main().catch(e => { console.error("hy-spread 실패:", e.message); process.exit(1); });
