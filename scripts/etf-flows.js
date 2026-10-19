// ETF 투자자별 순매수 — 외국인 · 개인의 1/5/20/60거래일 누적(억원).
//   portfolio-web 'ETF 랭킹' 의 수급 순위(외국인 순매수 순 · 개인 순매수 순)가 이 JSON 을 그대로 읽는다(화면은 0콜).
//   ETF 마다 토스 투자자 수급 1콜 — 화면에서 부르면 1,100콜이 넘어서 여기서 하루 한 번 계산한다.
//
// 왜 기관은 없나 — ETF 의 기관 수치엔 LP(유동성공급자, 증권사) 호가 대응 물량이 섞인다.
//   개인이 사면 LP 가 팔아 주는 구조라 '개인 +, 기관 −' 가 거울처럼 나온다 → 신호로 못 읽는다(사용자 결정 2026-10-19).
//
// 실행: node scripts/etf-flows.js   (환경변수 CONCURRENCY 기본 6, MAX_ETFS 테스트용)
//   입력: data/etf-list.json (같은 워크플로의 crawl.js 가 먼저 갱신)
//   결과: data/etf-flows.json  { meta, flows: { 코드: [외1, 개1, 외5, 개5, 외20, 개20, 외60, 개60] } }  — 억원, 소수 1자리
//         배열로 둔 건 파일 크기 때문(1,100종 × 키 8개면 키 이름만 수백 KB).

import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.resolve(__dirname, "..", "data");

const UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) " +
  "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36";
const DAYS = 60;
const WINDOWS = [1, 5, 20, 60];
const TOSS_TREND = (code) =>
  `https://wts-info-api.tossinvest.com/api/v1/stock-infos/trade/trend/trading-trend?productCode=A${code}&size=${DAYS}`;
const CONCURRENCY = Number(process.env.CONCURRENCY ?? "6");
const MAX_ETFS = process.env.MAX_ETFS ? Number(process.env.MAX_ETFS) : Infinity;

async function getJson(url) {
  for (let t = 0; t < 3; t++) {
    try {
      const ctl = new AbortController();
      const timer = setTimeout(() => ctl.abort(), 15_000);
      const resp = await fetch(url, {
        headers: { "User-Agent": UA, Accept: "application/json", Referer: "https://www.tossinvest.com/" },
        signal: ctl.signal,
      });
      clearTimeout(timer);
      if (resp.ok) return await resp.json();
    } catch { /* 재시도 */ }
    await new Promise((r) => setTimeout(r, 800 * (t + 1)));
  }
  return null;
}

// 한 ETF 집계. 토스 수급은 최신 → 과거 순. 장중(inMarketTime) 줄은 버린다 — 수동 실행이 장중일 수 있다.
//   금액 = 그날 순매수 수량 × 그날 종가.
async function aggregate(code) {
  const j = await getJson(TOSS_TREND(code));
  let rows = j?.result?.body ?? [];
  rows = rows.filter((r) => !r.inMarketTime && r.close > 0);
  if (rows.length === 0) return null;
  const fo = rows.map((r) => (Number(r.netForeignerBuyVolume) || 0) * r.close);
  const pe = rows.map((r) => (Number(r.netIndividualsBuyVolume) || 0) * r.close);
  const eok = (v) => Math.round(v / 1e7) / 10;           // 원 → 억원, 소수 1자리
  const out = [];
  for (const n of WINDOWS) {
    if (rows.length < n) { out.push(null, null); continue; }   // 신규 상장 — 그 창만 비운다
    const sum = (a) => a.slice(0, n).reduce((s, v) => s + v, 0);
    out.push(eok(sum(fo)), eok(sum(pe)));
  }
  return { code, date: rows[0].baseDate, v: out };
}

async function pmap(items, fn, n) {
  const out = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: n }, async () => {
    for (;;) {
      const i = next++;
      if (i >= items.length) return;
      try { out[i] = await fn(items[i]); } catch { out[i] = null; }
    }
  }));
  return out;
}

async function main() {
  const t0 = Date.now();
  const list = JSON.parse(await fs.readFile(path.join(DATA_DIR, "etf-list.json"), "utf8"));
  const codes = Object.keys(list.etfs ?? {}).filter((c) => /^[0-9A-Za-z]{6}$/.test(c)).slice(0, MAX_ETFS);
  console.log(`[etf-flows] 대상 ${codes.length}종`);
  if (codes.length < 100 && MAX_ETFS === Infinity) throw new Error(`대상이 너무 적다 (${codes.length}) — etf-list.json 확인`);
  const res = (await pmap(codes, aggregate, CONCURRENCY)).filter(Boolean);
  console.log(`[etf-flows] 집계 ${res.length}종 · ${((Date.now() - t0) / 1000).toFixed(0)}초`);
  // 빈·부분 결과로 어제 파일을 덮지 않는다 — 대상의 80% 미만이면 실패로 본다.
  if (res.length < codes.length * 0.8) throw new Error(`집계 실패가 많다 (${res.length}/${codes.length})`);
  const dates = res.map((r) => r.date).sort();
  const asOf = dates[Math.floor(dates.length / 2)];      // 대부분 ETF 의 최신일(중앙값)
  const flows = {};
  for (const r of res) flows[r.code] = r.v;
  const out = {
    meta: { builtAt: new Date().toISOString(), asOf, count: res.length, windows: WINDOWS, unit: "억원", order: "외국인,개인 × windows" },
    flows,
  };
  await fs.writeFile(path.join(DATA_DIR, "etf-flows.json"), JSON.stringify(out));
  console.log(`[etf-flows] 저장 data/etf-flows.json (기준일 ${asOf})`);
}

main().catch((e) => { console.error("[etf-flows] 실패:", e); process.exit(1); });
