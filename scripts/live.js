// 장중 공용 데이터 — portfolio-web 의 ETF 랭킹·종목찾기(눌림목)·실적 일정·히트맵을 서버에서 한 번만 받는다
//   (사용자 요청 2026-10-29 "ETF 랭킹, 종목찾기(눌림목), 실적 일정, 히트맵까지 다 하자").
//   사용자마다 프록시로 부르던 것을 여기 한 곳(2분마다 — 자주 보는 것만 매번, 나머지 10분)으로 — 웹은 이 파일만 읽는다. 사용자 수와 상관없이 호출 수가 고정된다.
//   깨우기는 Cloudflare 워커(portfolio-web/workers/dart-cron)가 workflow_dispatch 로. 장 시간 거르기는 여기서 한 번 더.
//   출력: <OUT>/data/live/
//     etf-ranking.json  { fetchedAt, rows:[[code, close, base(직전 거래일 종가), volume, tradeDate(KST)]] } — 토스 시세 전수(6콜)
//     screener.json     { fetchedAt, cols, kospi:[d], kosdaq:[d] } — TradingView 스캐너 원본 행(웹이 같은 파서로 읽는다)
//     earnings.json     { fetchedAt, cols, from, to, us:[d], kr:[d] } — 다음·최근 실적일이 창(오늘-7 ~ +28일) 안인 시총 상위
//     heatmap/<소스>.json { fetchedAt, cols, rows:[d] } — 히트맵 소스 19개
//     index.json        { 이름: fetchedAt } — 웹 '갱신 시각' 표시용
//   실패한 항목은 그 파일을 덮지 않는다(어제·직전 파일이 남는다). 0건도 덮지 않는다(일시적 0건이 굳는다).
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const OUT = path.resolve(process.argv[2] ?? path.join(ROOT, "live-out"));
const DIR = path.join(OUT, "data", "live");
const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126 Safari/537.36";
const FORCE = process.env.FORCE === "1";   // 수동 실행 — 장 시간과 상관없이 전부
// 토스는 _browserId 쿠키가 없으면 400(2026-10-22~, portfolio-web local-proxy 와 같은 처리) — 실행마다 무작위 32자
const TOSS_BROWSER_ID = Array.from({ length: 32 }, () => Math.floor(Math.random() * 16).toString(16)).join("");

const kstYmd = (ms = Date.now()) => new Date(ms + 9 * 3600_000).toISOString().slice(0, 10);
function zoned(tz, d = new Date()) {
  const p = Object.fromEntries(new Intl.DateTimeFormat("en-US", { timeZone: tz, hour12: false, weekday: "short", hour: "2-digit", minute: "2-digit" })
    .formatToParts(d).map(x => [x.type, x.value]));
  return { dow: ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(p.weekday), min: (Number(p.hour) % 24) * 60 + Number(p.minute) };
}
// 국내: 평일 08:00~20:20(NXT 애프터 20:00 + 마감 뒤 한 번) / 미국: 뉴욕 평일 04:00~20:20(프리~애프터)
const krOpen = () => { const z = zoned("Asia/Seoul"); return z.dow >= 1 && z.dow <= 5 && z.min >= 8 * 60 && z.min <= 20 * 60 + 20; };
const usOpen = () => { const z = zoned("America/New_York"); return z.dow >= 1 && z.dow <= 5 && z.min >= 4 * 60 && z.min <= 20 * 60 + 20; };

async function req(url, init = {}) {
  const ctrl = new AbortController(); const t = setTimeout(() => ctrl.abort(), 30_000);
  try {
    const r = await fetch(url, { ...init, headers: { "User-Agent": UA, ...(init.headers ?? {}) }, signal: ctrl.signal });
    if (!r.ok) throw new Error(`HTTP ${r.status} ${url.slice(0, 80)}`);
    return r;
  } finally { clearTimeout(t); }
}

async function readJson(file) {
  try { return JSON.parse(await fs.readFile(file, "utf8")); } catch { return null; }
}
const index = {};
async function save(name, obj) {
  const file = path.join(DIR, `${name}.json`);
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, JSON.stringify(obj));
  index[name] = obj.fetchedAt;
  console.log(`  ✓ ${name}`);
}
// 장 밖이어도 파일이 없거나 오래됐으면(6시간) 한 번 받는다 — 주말을 건너 월요일 첫 화면이 비지 않게
const age = (name) => (index[name] ? Date.now() - index[name] : Infinity);
// 장중 주기 — 워커가 2분마다 깨운다(사용자 2026-10-29 "2분으로"). 자주 보는 것(ETF 랭킹·대표 히트맵 4개)은 매번,
//   나머지는 10분(조금 일찍 — 깨우는 시각이 몇 초씩 밀려도 10분 칸을 건너뛰지 않게 9분 30초)
const HOT = new Set(["etf-ranking", "heatmap/kospi200", "heatmap/kosdaq150", "heatmap/us_sp500", "heatmap/us_ndx"]);
const EVERY = 9.5 * 60_000;
const due = (name, open, maxAgeMs = 6 * 3600_000) => FORCE || (open && (HOT.has(name) || age(name) >= EVERY)) || age(name) > maxAgeMs;

// ─── TradingView 스캐너 ───────────────────────────────────────────────
async function scan(endpoint, body) {
  const r = await req(`https://scanner.tradingview.com/${endpoint}/scan`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
  });
  const j = await r.json();
  if (typeof j.error === "string" && j.error) throw new Error(j.error);
  return (Array.isArray(j.data) ? j.data : []).map(x => x.d);
}

// ─── 히트맵 — portfolio-web src/lib/api.ts HEATMAP_META·HEAT_COLUMNS 와 같은 정의(바꾸면 양쪽) ─────
const HEAT_COLUMNS = ["name", "description", "logoid", "change", "close", "volume", "Value.Traded",
  "market_cap_basic", "Perf.W", "Perf.1M", "Perf.3M", "Perf.6M", "Perf.YTD", "Perf.Y", "sector",
  "premarket_change", "postmarket_change", "aum"];
const HEAT = {
  kospi200: ["kr", "SYML:KRX;KOSPI200"], kospi: ["kr", "SYML:KRX;KOSPI"], kosdaq150: ["kr", "SYML:KRX;KOSDAQ150"],
  kosdaq: ["kr", "SYML:KRX;KOSDAQ", 700], all: ["kr", null, 700], kr_valueup: ["kr", "valueup"],
  us_sp500: ["us", "SYML:SP;SPX"], us_ndx: ["us", "SYML:NASDAQ;NDX"], us_nasdaq: ["us", "SYML:NASDAQ;IXIC", 1000],
  us_dow: ["us", "SYML:DJ;DJI"], us_dowcomp: ["us", "SYML:DJ;DJA"], us_dowtrans: ["us", "SYML:DJ;DJT"], us_dowutil: ["us", "SYML:DJ;DJU"],
  us_kbwbank: ["us", "SYML:NASDAQ;BKX"], us_r1000: ["us", "SYML:TVC;RUI"], us_r2000: ["us", "SYML:TVC;RUT", 1000],
  us_r3000: ["us", "SYML:TVC;RUA", 1000], us_all: ["us", null, 1000], us_tech: ["us", "sector:Electronic Technology", 500],
};
// 코리아 밸류업 — symbolset 이 없어 네이버 편입종목(100종) 코드를 tickers 로.
//   finance.naver entryJongmok 은 410 폐기(2026-10-29 실측) → m.stock enrollStocks(pageSize 50 까지, 100 은 빈 응답)
async function valueupTickers() {
  const codes = new Set();
  for (let page = 1; page <= 4; page++) {
    const j = await (await req(`https://m.stock.naver.com/api/index/KVALUE/enrollStocks?page=${page}&pageSize=50`)).json();
    if (!Array.isArray(j) || j.length === 0) break;
    for (const s of j) if (/^[\dA-Za-z]{6}$/.test(s.itemCode ?? "")) codes.add(s.itemCode);
  }
  if (codes.size === 0) throw new Error("밸류업 구성종목 0건");   // 비면 tickers 없이 한국 전체가 잡힌다
  return [...codes].map(c => `KRX:${c}`);
}
async function heatmap(src) {
  const [region, set, limit = 400] = HEAT[src];
  const body = { columns: HEAT_COLUMNS, sort: { sortBy: "market_cap_basic", sortOrder: "desc" }, range: [0, limit] };
  if (set === "valueup") body.symbols = { tickers: await valueupTickers() };
  else if (set?.startsWith("sector:")) body.filter = [{ left: "sector", operation: "equal", right: set.slice(7) }];
  else if (set) body.symbols = { symbolset: [set] };
  return scan(region === "us" ? "america" : "korea", body);
}

// ─── 눌림목 스크리너 — portfolio-web src/lib/stockScreener.ts COLUMNS 와 같은 열 ─────
const SCREEN_COLUMNS = ["name", "description", "logoid", "close", "change", "volume", "Value.Traded",
  "market_cap_basic", "RSI", "BB.lower", "SMA200", "net_income", "price_52_week_high", "sector"];
const screenBody = (set) => ({ symbols: { symbolset: [set] }, columns: SCREEN_COLUMNS,
  sort: { sortBy: "market_cap_basic", sortOrder: "desc" }, range: [0, 2000] });

// ─── 실적 일정 — portfolio-web src/lib/earnings.ts COLS 와 같은 열. 내 관심종목(시총 작은 것)은 웹이 따로 부른다 ─────
const EARN_COLS = ["name", "description", "earnings_release_next_date", "earnings_release_next_time", "market_cap_basic", "is_primary", "typespecs", "type", "exchange",
  "earnings_release_date", "earnings_release_time", "logoid"];
async function earnings() {
  const from = new Date(Date.parse(`${kstYmd()}T00:00:00Z`) - 7 * 86400_000).toISOString().slice(0, 10);
  const to = new Date(Date.parse(`${kstYmd()}T00:00:00Z`) + 28 * 86400_000).toISOString().slice(0, 10);
  const lo = Date.parse(`${from}T00:00:00Z`) / 1000 - 2 * 86400, hi = Date.parse(`${to}T23:59:59Z`) / 1000 + 86400;
  const q = (endpoint, field, cap, n) => scan(endpoint, { columns: EARN_COLS, options: { lang: "ko" },
    filter: [{ left: field, operation: "in_range", right: [lo, hi] }, { left: "market_cap_basic", operation: "greater", right: cap }],
    sort: { sortBy: "market_cap_basic", sortOrder: "desc" }, range: [0, n] });
  const [usN, krN, usL, krL] = await Promise.all([
    q("america", "earnings_release_next_date", 40e9, 600), q("korea", "earnings_release_next_date", 3e12, 400),
    q("america", "earnings_release_date", 40e9, 600), q("korea", "earnings_release_date", 3e12, 400),
  ]);
  const uniq = (rows) => { const seen = new Set(); return rows.filter(d => !seen.has(d[0]) && seen.add(d[0])); };
  return { from, to, us: uniq([...usN, ...usL]), kr: uniq([...krN, ...krL]) };
}

// ─── ETF 랭킹 — 토스 시세 전수. 등락률·섹터 집계는 웹이(같은 규칙 한 벌) ─────
async function etfRanking() {
  const list = await readJson(path.join(ROOT, "data", "etf-list.json"));
  const codes = Object.keys(list?.etfs ?? {});
  if (codes.length === 0) throw new Error("etf-list.json 비어 있음");
  const rows = [];
  for (let i = 0; i < codes.length; i += 200) {   // 토스 상한 200종/콜
    const chunk = codes.slice(i, i + 200);
    const r = await req(`https://wts-info-api.tossinvest.com/api/v3/stock-prices/details?productCodes=${chunk.map(c => `A${c}`).join(",")}`,
      { headers: { Referer: "https://tossinvest.com/", Origin: "https://tossinvest.com", Cookie: `_browserId=${TOSS_BROWSER_ID}` } });
    const j = await r.json();
    for (const it of j.result ?? []) {
      if (!it.code || !(it.close > 0)) continue;
      rows.push([it.code.replace(/^A/, ""), it.close, it.base, it.volume ?? 0, it.tradeDateTime ? kstYmd(Date.parse(it.tradeDateTime)) : ""]);
    }
  }
  return rows;
}

async function job(name, fn) {
  try { await fn(); } catch (e) { console.error(`  ✗ ${name}: ${e.message}`); }
}

async function main() {
  await fs.mkdir(DIR, { recursive: true });
  Object.assign(index, (await readJson(path.join(DIR, "index.json"))) ?? {});
  const kr = krOpen(), us = usOpen();
  console.log(`KR ${kr ? "open" : "closed"} · US ${us ? "open" : "closed"}${FORCE ? " · FORCE" : ""}`);

  if (due("etf-ranking", kr)) await job("etf-ranking", async () => {
    const rows = await etfRanking();
    if (rows.length > 0) await save("etf-ranking", { fetchedAt: Date.now(), rows });
  });
  if (due("screener", kr)) await job("screener", async () => {
    const [kospi, kosdaq] = await Promise.all([scan("korea", screenBody("SYML:KRX;KOSPI")), scan("korea", screenBody("SYML:KRX;KOSDAQ"))]);
    if (kospi.length + kosdaq.length > 0) await save("screener", { fetchedAt: Date.now(), cols: SCREEN_COLUMNS, kospi, kosdaq });
  });
  // 실적 일정은 하루 몇 번 바뀌는 정도 — 1시간에 한 번
  if (FORCE || age("earnings") > 3600_000) await job("earnings", async () => {
    const e = await earnings();
    if (e.us.length + e.kr.length > 0) await save("earnings", { fetchedAt: Date.now(), cols: EARN_COLS, ...e });
  });
  for (const src of Object.keys(HEAT)) {
    const name = `heatmap/${src}`;
    if (!due(name, HEAT[src][0] === "us" ? us : kr)) continue;
    await job(name, async () => {
      const rows = await heatmap(src);
      if (rows.length > 0) await save(name, { fetchedAt: Date.now(), cols: HEAT_COLUMNS, rows });
    });
  }
  await fs.writeFile(path.join(DIR, "index.json"), JSON.stringify(index));
}

main().catch(e => { console.error(e); process.exit(1); });
