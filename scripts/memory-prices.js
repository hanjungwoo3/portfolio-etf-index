// 메모리 반도체 현물가 — DRAMeXchange(트렌드포스) 첫 화면의 공개 시세를 하루 1번 읽어 **이력을 직접 쌓는다**.
//   portfolio-web 지수(한국) 반도체 페이지 '메모리 가격' 줄이 이 JSON 을 읽는다(화면은 0콜).
//   과거 시세(History 차트)는 유료 회원 전용이라 받을 수 없다 — 그래서 매일 저장해 그래프를 만든다(2026-10-20 시작).
//
// 값 = 세션 평균가(Session Average, USD). DRAM 칩은 매일, 모듈·낸드 웨이퍼·GDDR 은 주 1회 갱신된다.
//   같은 '갱신 날짜' 는 한 번만 저장한다(주간 품목이 매일 중복 저장되지 않게).
//
// 실행: node scripts/memory-prices.js → data/memory-prices.json
//   { meta, items: { key: { name, unit, updated, avg, chg, hist: [[YYYY-MM-DD, avg], ...] } } }

import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FILE = path.resolve(__dirname, "..", "data", "memory-prices.json");
const UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) " +
  "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36";
const KEEP = 800;   // 품목당 최대 저장 수(일 단위면 3년)

// 첫 화면 표의 행 이름(앞부분 일치) → 저장 키
const ITEMS = [
  { key: "ddr5",  match: "DDR5 16Gb (2Gx8) 4800/5600", name: "DDR5 16Gb", unit: "USD" },
  { key: "ddr4",  match: "DDR4 16Gb (2Gx8) 3200",      name: "DDR4 16Gb", unit: "USD" },
  { key: "rdimm", match: "DDR5 RDIMM 32GB",            name: "DDR5 RDIMM 32GB", unit: "USD" },
  { key: "nand",  match: "512Gb TLC",                  name: "NAND 512Gb TLC 웨이퍼", unit: "USD" },
  { key: "gddr6", match: "GDDR6 8Gb",                  name: "GDDR6 8Gb", unit: "USD" },
];

const MONTHS = { Jan: 1, Feb: 2, Mar: 3, Apr: 4, May: 5, Jun: 6, Jul: 7, Aug: 8, Sep: 9, Oct: 10, Nov: 11, Dec: 12 };
const text = (h) => h.replace(/<[^>]+>/g, " ").replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/\s+/g, " ").trim();

async function main() {
  const resp = await fetch("https://www.dramexchange.com/", { headers: { "User-Agent": UA, "Accept-Language": "en-US,en;q=0.9" } });
  if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
  const html = await resp.text();
  // 표의 행을 위에서부터 훑으며, 직전에 나온 'Last Update: Oct.19 2026' 을 그 행의 갱신일로 쓴다(섹션마다 다르다).
  const rows = [...html.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/g)].map((m) => text(m[1]));
  let updated = null;
  const found = {};
  for (const r of rows) {
    const u = /Last ?Update:?\s*([A-Z][a-z]{2})\.?\s*(\d{1,2})\s+(\d{4})/.exec(r);
    if (u) { updated = `${u[3]}-${String(MONTHS[u[1]]).padStart(2, "0")}-${u[2].padStart(2, "0")}`; continue; }
    for (const it of ITEMS) {
      if (found[it.key] || !r.startsWith(it.match)) continue;
      // 이름 뒤 숫자들: 고·저·세션고·세션저·세션평균·변동%  → 끝에서 두 번째가 평균, 마지막이 변동
      const nums = r.slice(it.match.length).match(/-?\d+(?:\.\d+)?/g)?.map(Number) ?? [];
      if (nums.length < 6 || !updated) continue;
      found[it.key] = { avg: nums[nums.length - 2], chg: nums[nums.length - 1], updated };
    }
  }
  const n = Object.keys(found).length;
  console.log(`[memory] ${n}/${ITEMS.length} 품목`, found);
  if (n < 3) throw new Error(`품목을 거의 못 찾았다(${n}) — 페이지 구조 확인`);   // 빈 결과로 어제 파일을 덮지 않는다

  let prev = { items: {} };
  try { prev = JSON.parse(await fs.readFile(FILE, "utf8")); } catch { /* 첫 실행 */ }
  const items = {};
  for (const it of ITEMS) {
    const old = prev.items?.[it.key];
    const f = found[it.key];
    const hist = [...(old?.hist ?? [])];
    if (f && f.avg > 0 && !hist.some(([d]) => d === f.updated)) hist.push([f.updated, f.avg]);
    hist.sort((a, b) => a[0].localeCompare(b[0]));
    items[it.key] = {
      name: it.name, unit: it.unit,
      updated: f?.updated ?? old?.updated ?? null,
      avg: f?.avg ?? old?.avg ?? null,
      chg: f?.chg ?? old?.chg ?? null,       // 사이트가 낸 직전 세션 대비 %(이력이 짧을 때도 등락을 보여주려고)
      hist: hist.slice(-KEEP),
    };
  }
  const out = { meta: { builtAt: new Date().toISOString(), source: "DRAMeXchange 공개 현물가(세션 평균)" }, items };
  await fs.writeFile(FILE, JSON.stringify(out));
  console.log("[memory] 저장 data/memory-prices.json");
}

main().catch((e) => { console.error("[memory] 실패:", e); process.exit(1); });
