// 투자자별 매집 집계 — 외국인 · 기관(금융투자 제외) · 연기금의 5/20/60일 누적 순매수.
//   portfolio-web '수급 매집' 탭이 이 JSON 을 그대로 읽는다(화면은 0콜).
//   종목마다 토스 투자자 수급 1콜 — 화면에서 부르면 1,000콜이 넘어서 여기서 하루 한 번 계산한다.
//
// 왜 이 셋, 왜 '시총 대비' 인가 (portfolio-web 백테스트 2026-10-01, 2026-01~09 160거래일, 999종):
//   - 셋 다 20일 매집 상위 30% → 5·10·20일 뒤 시장 대비 +0.36 / +0.75 / +1.72%p, 앞·뒤 절반 모두 +.
//   - 한 주체만(특히 외국인 단독)·며칠 연속 순매수·'매집했는데 주가는 안 오름' 은 오히려 나빴다.
//   - 금액을 **그날 시총**으로 나눠야 종목 크기와 상관없이 비교된다. (현재 시총으로 나누면
//     나중에 떨어진 종목이 부풀려진다 — 백테스트에서 실제로 걸렸던 미래 정보 오류)
//   - 기관은 금융투자를 뺀다 — ETF 설정·차익·헤지가 섞여 방향이 정반대로 희석된다.
//
// 실행: node scripts/flows.js   (환경변수 CONCURRENCY 기본 6, MAX_STOCKS 테스트용)
//   결과: data/investor-flows.json
//   종목마다: 5/20/60일 집계 · 연속 매수일 · 60일 시계열(종가·일별 순매수) · 외국인 지분율 · 네이버 업종

import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.resolve(__dirname, "..", "data");

const UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) " +
  "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36";
const NAVER_MARKET_VALUE = (market, page) =>
  `https://m.stock.naver.com/api/stocks/marketValue/${market}?page=${page}&pageSize=100`;
const TOSS_TREND = (code) =>
  `https://wts-info-api.tossinvest.com/api/v1/stock-infos/trade/trend/trading-trend?productCode=A${code}&size=${DAYS}`;

const NAVER_INDUSTRY_LIST =
  "https://stock.naver.com/api/stockSecurity/rankings/v2/domestic/industries?sortType=changeRate&size=100&period=daily";
const NAVER_INDUSTRY_STOCKS = (id, page) =>
  `https://stock.naver.com/api/domestic/market/upjong/${id}/stocklist?marketType=ALL&orderType=priceTop&startIdx=${page}&pageSize=200`;

const DAYS = 60;                  // 60일 창까지 — 토스 상한 200
const WINDOWS = [5, 20, 60];
const MIN_CAP_EOK = 1000;         // 시총 1,000억 미만은 뺀다(순매수 몇 억에 비율이 튄다)
const CONCURRENCY = Number(process.env.CONCURRENCY ?? "6");
const MAX_STOCKS = process.env.MAX_STOCKS ? Number(process.env.MAX_STOCKS) : Infinity;

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

const num = (s) => Number(String(s ?? "").replace(/,/g, ""));
const PREFERRED = /우[A-C]?$|우\(전환\)$/;

// 보통주 목록 + 시총(억원). 우선주·ETF·스팩은 뺀다.
async function fetchUniverse() {
  const out = [];
  for (const market of ["KOSPI", "KOSDAQ"]) {
    for (let page = 1; page <= 40; page++) {
      const j = await getJson(NAVER_MARKET_VALUE(market, page));
      const stocks = j?.stocks ?? [];
      if (stocks.length === 0) break;
      for (const s of stocks) {
        const code = String(s.itemCode ?? "");
        const name = String(s.stockName ?? "");
        const cap = num(s.marketValue);
        if (s.stockEndType !== "stock" || !/^[0-9A-Za-z]{6}$/.test(code)) continue;
        if (PREFERRED.test(name) || /스팩|SPAC/i.test(name)) continue;
        if (!(cap >= MIN_CAP_EOK)) continue;
        out.push({ code, name, market: market === "KOSPI" ? "코스피" : "코스닥", capEok: cap });
      }
      if (stocks.length < 100) break;
    }
  }
  return out;
}

// 종목코드 → 네이버 업종명. 업종 목록 1콜 + 업종마다 구성종목(200개씩 페이지).
async function fetchIndustries() {
  const map = {};
  const list = await getJson(NAVER_INDUSTRY_LIST);
  const items = (list?.items ?? []).map((x) => ({ id: String(x?.code ?? ""), name: String(x?.name ?? "").trim() }))
    .filter((x) => x.id && x.name);
  for (const it of items) {
    for (let page = 0; page < 10; page++) {
      const rows = await getJson(NAVER_INDUSTRY_STOCKS(it.id, page));
      if (!Array.isArray(rows) || rows.length === 0) break;
      for (const r of rows) {
        const code = String(r?.itemcode ?? "").trim();
        if (/^[0-9A-Za-z]{6}$/.test(code) && !map[code]) map[code] = it.name;
      }
      if (rows.length < 200) break;
    }
  }
  return map;
}

// 한 종목 집계. 토스 수급은 최신 → 과거 순. 오늘 줄이 장중(inMarketTime)이면 버린다 —
//   크롤러는 06:00 KST 에 돌아 보통 어제가 맨 위지만, 수동 실행이 장중일 수 있다.
async function aggregate(st) {
  const j = await getJson(TOSS_TREND(st.code));
  let rows = j?.result?.body ?? [];
  rows = rows.filter((r) => !r.inMarketTime && r.close > 0);
  if (rows.length < 20) return null;
  const last = rows[0].close;
  const shares = (st.capEok * 1e8) / last;              // 주식 수 — 그날 시총 = 주식 수 × 그날 종가
  const day = rows.map((r) => ({
    fo: r.netForeignerBuyVolume * r.close,
    in: (r.netInstitutionBuyVolume - r.netFinancialInvestmentBuyVolume) * r.close,
    pe: r.netPensionFundBuyVolume * r.close,
    close: r.close,
  }));
  const w = {};
  for (const n of WINDOWS) {
    if (day.length < n) continue;
    const s = day.slice(0, n);
    const cap = shares * s[n - 1].close;                  // 창 시작일 시총 기준 (비율이 미래 가격에 안 끌려가게)
    const sum = (k) => s.reduce((a, d) => a + d[k], 0);
    const f = sum("fo"), i = sum("in"), p = sum("pe");
    w[n] = {
      fo: Math.round(f / 1e8), in: Math.round(i / 1e8), pe: Math.round(p / 1e8),             // 억원
      foR: +(f / cap * 100).toFixed(3), inR: +(i / cap * 100).toFixed(3), peR: +(p / cap * 100).toFixed(3),  // 시총 대비 %
      ret: +((s[0].close / s[n - 1].close - 1) * 100).toFixed(2),                             // 그 기간 주가 등락
    };
  }
  const streak = (k) => { let c = 0; for (const d of day) { if (d[k] > 0) c++; else break; } return c; };
  // 60일 미니 차트용 시계열 — **과거 → 최근** 순. 순매수는 0.1억(천만원) 정수로 줄여 파일 크기를 아낀다.
  const asc = [...day].reverse();
  const tenth = (v) => Math.round(v / 1e7);
  const fr = rows.map((r) => Number(r.foreignerRatio)).filter((v) => Number.isFinite(v) && v > 0);
  return {
    code: st.code, name: st.name, market: st.market, capEok: st.capEok, close: last,
    date: rows[0].baseDate, w,
    streak: { fo: streak("fo"), in: streak("in"), pe: streak("pe") },
    s: { c: asc.map((d) => d.close), fo: asc.map((d) => tenth(d.fo)), in: asc.map((d) => tenth(d.in)), pe: asc.map((d) => tenth(d.pe)) },
    // 외국인 지분율 — 지금 / 60일 전 (같은 응답에 들어 있다)
    fr: fr.length ? [fr[0], fr[fr.length - 1]] : null,
  };
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
  const uni = (await fetchUniverse()).slice(0, MAX_STOCKS);
  console.log(`[flows] 대상 ${uni.length}종 (시총 ${MIN_CAP_EOK}억+ 보통주)`);
  if (uni.length < 100) throw new Error(`대상이 너무 적다 (${uni.length}) — 네이버 응답 확인`);
  const [res0, industry] = await Promise.all([
    pmap(uni, aggregate, CONCURRENCY),
    fetchIndustries().catch(() => ({})),
  ]);
  const res = res0.filter(Boolean);
  for (const r of res) r.ind = industry[r.code] ?? null;
  console.log(`[flows] 업종 ${Object.keys(industry).length}종 매핑 · 집계 중 업종 있음 ${res.filter((r) => r.ind).length}`);
  console.log(`[flows] 집계 ${res.length}종 · ${((Date.now() - t0) / 1000).toFixed(0)}초`);
  // 빈·부분 결과로 어제 파일을 덮지 않는다 — 대상의 80% 미만이면 실패로 본다.
  if (res.length < uni.length * 0.8) throw new Error(`집계 실패가 많다 (${res.length}/${uni.length})`);
  const dates = res.map((r) => r.date).sort();
  const asOf = dates[Math.floor(dates.length / 2)];      // 대부분 종목의 최신일(중앙값)
  const out = {
    meta: { builtAt: new Date().toISOString(), asOf, count: res.length, windows: WINDOWS, minCapEok: MIN_CAP_EOK },
    stocks: res,
  };
  await fs.writeFile(path.join(DATA_DIR, "investor-flows.json"), JSON.stringify(out));
  console.log(`[flows] 저장 data/investor-flows.json (기준일 ${asOf})`);
}

main().catch((e) => { console.error("[flows] 실패:", e); process.exit(1); });
