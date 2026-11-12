// 서학개미(미국 주식에 투자하는 한국 개인) — 예탁결제원 세이브로 해외주식 결제·보관 상위 50(사용자 2026-11-03 "셋다").
//   portfolio-web 이 읽는다: 지수 탭 '서학개미' 상자(순매수·보유 TOP), 미국 종목 카드 꼬리표, 레버리지 쏠림 지표.
//
//   출처: seibro.or.kr 화면 BIP_CNTS10013V(해외주식 → 국가별·종목별 현황).
//     - 결제 getImptFrcurStkSetlAmtList — D_TYPE 1 매수 · 2 매도 · 3 매수+매도 · 4 순매수, 금액은 달러.
//     - 보관 getImptFrcurStkCusRemaList — 그날 보관 잔액, 달러.
//     ⚠ MENU_NO·W2XPATH 를 빼면 오류 없이 빈 결과(result="0")가 온다. 페이지를 넘겨도 상위 50 까지만 준다.
//     ⚠ 결제는 미국 T+1 이라 하루 이틀 늦다. 보관은 직전 영업일까지.
//   ISIN → 티커는 OpenFIGI(무키 10건/요청). 한 번 찾은 건 파일에 쌓아 다시 묻지 않는다.
//   실패하면 어제 파일 그대로(빈 값으로 덮지 않는다 — 상자가 통째로 비어 보인다).
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const DATA_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "data");
const OUT = path.join(DATA_DIR, "seohak.json");
const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126 Safari/537.36";
const SEIBRO = "https://seibro.or.kr/websquare/engine/proworks/callServletService.jsp";
const LEV_DAYS = 30;          // 쏠림 추이로 남길 결제일 수

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ymd = (d) => d.toISOString().slice(0, 10).replace(/-/g, "");
const kstToday = () => new Date(Date.now() + 9 * 3600_000);
const addDays = (d, n) => new Date(d.getTime() + n * 86400_000);
const isWeekend = (d) => d.getUTCDay() === 0 || d.getUTCDay() === 6;

async function seibro(action, params) {
  const fields = Object.entries({ MENU_NO: "921", W2XPATH: "/IPORTAL/user/ovsSec/BIP_CNTS10013V.xml", PG_START: "1", PG_END: "50", S_COUNTRY: "US", ...params })
    .map(([k, v]) => `<${k} value="${v}"/>`).join("");
  const body = `<reqParam action="${action}" task="ksd.safe.bip.cnts.OvsSec.process.OvsSecIsinPTask">${fields}</reqParam>`;
  for (let i = 0; i < 3; i++) {
    try {
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), 30_000);
      const resp = await fetch(SEIBRO, {
        method: "POST", signal: ctrl.signal, body,
        headers: { "User-Agent": UA, "Content-Type": 'application/xml; charset="UTF-8"', "Referer": "https://seibro.or.kr/" },
      }).finally(() => clearTimeout(t));
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      const xml = await resp.text();
      if (xml.includes("<WARNING>")) throw new Error(`세이브로 경고 ${xml.match(/msg[^>]*value='([^']*)'/)?.[1] ?? ""}`);
      return [...xml.matchAll(/<result>([\s\S]*?)<\/result>/g)].map((m) => {
        const o = {};
        for (const f of m[1].matchAll(/<(\w+) value="([^"]*)"\/>/g)) o[f[1]] = f[2];
        return o;
      });
    } catch (e) {
      if (i === 2) throw e;
      await sleep(1500 * (i + 1));
    }
  }
  return [];
}

const num = (s) => { const n = Number(s); return Number.isFinite(n) ? n : 0; };
const setlRow = (o) => ({ isin: o.ISIN, n: o.KOR_SECN_NM, buy: num(o.SUM_FRSEC_BUY_AMT), sell: num(o.SUM_FRSEC_SELL_AMT), net: num(o.SUM_FRSEC_NET_BUY_AMT) });
const setl = async (from, to, dType) => (await seibro("getImptFrcurStkSetlAmtList", { START_DT: from, END_DT: to, S_TYPE: "2", D_TYPE: String(dType) })).map(setlRow);
const hold = async (day) => (await seibro("getImptFrcurStkCusRemaList", { START_DT: day, END_DT: day, S_TYPE: "1" }))
  .map((o) => ({ isin: o.ISIN, n: o.KOR_SECN_NM, amt: num(o.SUM_FRSEC_AMT) }));

/** 오늘부터 거꾸로 — 자료가 있는 가장 최근 날(주말 건너뜀, 최대 10일) */
async function latestDay(probe, from = kstToday()) {
  for (let i = 0; i < 10; i++) {
    const d = addDays(from, -i);
    if (isWeekend(d)) continue;
    const rows = await probe(ymd(d));
    if (rows.length) return { day: ymd(d), rows };
    await sleep(300);
  }
  return null;
}

// ── ISIN → 티커(OpenFIGI). securityType 'ETP' 면 ETF·ETN.
async function figiMap(isins, cache) {
  const need = [...new Set(isins)].filter((x) => x && !cache[x]);
  for (let i = 0; i < need.length; i += 10) {
    const chunk = need.slice(i, i + 10);
    try {
      const resp = await fetch("https://api.openfigi.com/v3/mapping", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify(chunk.map((v) => ({ idType: "ID_ISIN", idValue: v, exchCode: "US" }))),
      });
      if (resp.status === 429) { await sleep(10_000); i -= 10; continue; }
      if (!resp.ok) throw new Error(`OpenFIGI HTTP ${resp.status}`);
      const arr = await resp.json();
      arr.forEach((r, j) => {
        const d = r.data?.[0];
        if (d?.ticker) cache[chunk[j]] = { t: d.ticker.replace("/", "."), etp: d.securityType === "ETP" || undefined, fn: d.name };
      });
    } catch (e) { console.error(`⚠ OpenFIGI: ${e.message}`); }
    await sleep(2600);   // 무키 25회/분
  }
  return cache;
}

// ── 티커 → 토스 한글 이름·로고(자동완성 검색). _browserId·deviceId 쿠키 둘 다 없으면 400. ETF 는 이름이 티커 그대로라 ko 를 비운다.
//   실패해도 그만(화면은 로고 대체 주소·영문 이름으로) — 한 번 찾은 건 캐시.
async function tossMeta(cache) {
  const todo = Object.values(cache).filter((c) => c.t && c.ko === undefined && !c.tossTried);
  for (const c of todo) {
    try {
      const resp = await fetch("https://wts-info-api.tossinvest.com/api/v3/search-all/wts-auto-complete", {
        method: "POST",
        headers: { "Content-Type": "application/json", "User-Agent": UA, "Cookie": "_browserId=seohak0crawler; deviceId=WTS-seohak0crawler; BTK=seohak0crawler" },
        body: JSON.stringify({ query: c.t, sections: [{ type: "PRODUCT", option: { addIntegratedSearchResult: true } }] }),
      });
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      const j = await resp.json();
      const it = (j.result?.[0]?.data?.items ?? []).find((x) => (x.symbol ?? "").toUpperCase() === c.t.toUpperCase());
      c.tossTried = true;
      if (it) {
        if (it.productName && it.productName !== it.symbol) c.ko = it.productName;
        if (it.logoImageUrl) c.logo = it.logoImageUrl;
        if (it.productCode) c.toss = it.productCode;
      }
    } catch (e) { console.error(`⚠ 토스 이름·로고 ${c.t}: ${e.message}`); if (/HTTP 4/.test(e.message)) break; }
    await sleep(150);
  }
}

// 레버리지·인버스 — ETP 이름으로. OpenFIGI 이름은 약어투성이(DIREX DAI SEMI BE 3X = SOXS, DIR DLY 20+YR TR BL3X = TMF, PLTR BEA 1X = PLTD)
//   배수 표기·ULTRA·BULL/BEAR 가 있으면 레버리지 상품, 방향은 BEAR/BE/BEA/SHORT/INVERSE/VIX 면 하락(인버스) 쪽 — VIX 매수는 하락에 거는 것
const LEV_RE = /\d(\.\d)?X\b|BL3X|\bULTRA|LEVERAGED|\b(BULL?|BU|BEAR?|BE|SHORT|SHRT|INVERSE)\b/i;
const BEAR_RE = /\b(BEAR?|BE|SHORT|SHRT|ULTRASHORT|INVERSE)\b|-[123]X|\bVIX\b/i;
function levKind(isin, name, cache) {
  const c = cache[isin];
  const s = `${name} ${c?.fn ?? ""}`;
  if (!c?.etp && !/\bETF\b|\bETN\b/i.test(s)) return undefined;
  if (!LEV_RE.test(s)) return undefined;
  return BEAR_RE.test(s) ? "bear" : "bull";
}

async function main() {
  let prev = {};
  try { prev = JSON.parse(await fs.readFile(OUT, "utf-8")); } catch { /* 첫 실행 */ }
  const cache = prev.isin ?? {};

  // 1) 결제 — 가장 최근 결제일과 그 앞 1주
  const last = await latestDay((d) => setl(d, d, 4));
  if (!last) throw new Error("최근 10일 결제 자료 없음");
  const lastD = new Date(`${last.day.slice(0, 4)}-${last.day.slice(4, 6)}-${last.day.slice(6)}T00:00:00Z`);
  const weekFrom = ymd(addDays(lastD, -6));
  const dayNet = last.rows;
  const daySell = await setl(last.day, last.day, 2);
  const weekNet = await setl(weekFrom, last.day, 4);
  const weekSell = await setl(weekFrom, last.day, 2);
  if (weekNet.length < 10) throw new Error(`주간 순매수가 너무 적다(${weekNet.length})`);

  // 2) 보관 — 가장 최근 날과 그 1주 전
  const h = await latestDay(hold);
  if (!h) throw new Error("최근 10일 보관 자료 없음");
  const hD = new Date(`${h.day.slice(0, 4)}-${h.day.slice(4, 6)}-${h.day.slice(6)}T00:00:00Z`);
  const hp = await latestDay(hold, addDays(hD, -7));

  // 3) 쏠림 추이 — 결제일마다 매수+매도 상위 50 의 레버리지·인버스 매수·매도. 이미 있는 날은 다시 안 부른다(최근 3일은 정정 대비 다시)
  const levPrev = new Map((prev.lev ?? []).map((x) => [x.date, x]));
  const levRows = new Map();   // date → rows
  for (let i = 0, got = 0; got < LEV_DAYS && i < LEV_DAYS * 2; i++) {
    const d = addDays(lastD, -i);
    if (isWeekend(d)) continue;
    const k = ymd(d);
    if (levPrev.has(k) && i > 3) { got++; continue; }
    const rows = await setl(k, k, 3);
    if (rows.length) { levRows.set(k, rows); got++; }
    await sleep(300);
  }

  // 티커
  const allIsins = [...dayNet, ...daySell, ...weekNet, ...weekSell, ...h.rows, ...(hp?.rows ?? []), ...[...levRows.values()].flat()].map((r) => r.isin);
  await figiMap(allIsins, cache);
  await tossMeta(cache);

  const lev = new Map(levPrev);
  for (const [date, rows] of levRows) {
    const s = { date, buy: 0, sell: 0, bullBuy: 0, bullSell: 0, bearBuy: 0, bearSell: 0, top: [] };
    for (const r of rows) {
      s.buy += r.buy; s.sell += r.sell;
      const k = levKind(r.isin, r.n, cache);
      if (k === "bull") { s.bullBuy += r.buy; s.bullSell += r.sell; }
      if (k === "bear") { s.bearBuy += r.buy; s.bearSell += r.sell; }
    }
    // 그날 레버리지 상위 3(티커·순매수) — 상자 설명용
    s.top = rows.filter((r) => levKind(r.isin, r.n, cache)).sort((a, b) => (b.buy + b.sell) - (a.buy + a.sell)).slice(0, 3)
      .map((r) => ({ t: cache[r.isin]?.t ?? r.n, net: r.net, kind: levKind(r.isin, r.n, cache) }));
    lev.set(date, s);
  }
  const levArr = [...lev.values()].sort((a, b) => a.date.localeCompare(b.date)).slice(-LEV_DAYS);

  const tag = (r) => { const c = cache[r.isin]; return { ...r, t: c?.t, ko: c?.ko, logo: c?.logo, fn: c?.fn, toss: c?.toss, lev: levKind(r.isin, r.n, cache) }; };
  const prevRank = new Map((hp?.rows ?? []).map((r, i) => [r.isin, { rank: i + 1, amt: r.amt }]));
  const out = {
    meta: { builtAt: new Date().toISOString(), setlDate: last.day, weekFrom, holdDate: h.day, holdPrevDate: hp?.day },
    day: { net: dayNet.map(tag), sell: daySell.map(tag) },
    week: { net: weekNet.map(tag), sell: weekSell.map(tag) },
    hold: h.rows.map((r, i) => ({ ...tag(r), rank: i + 1, prevRank: prevRank.get(r.isin)?.rank, prevAmt: prevRank.get(r.isin)?.amt })),
    lev: levArr,
    isin: cache,
  };
  await fs.writeFile(OUT, JSON.stringify(out) + "\n");
  const noT = [...out.week.net, ...out.hold].filter((r) => !r.t).length;
  console.log(`서학개미: 결제 ${last.day}(주간 ${weekFrom}~) · 보관 ${h.day}(전주 ${hp?.day ?? "-"}) · 쏠림 ${levArr.length}일 · 티커 못 찾음 ${noT} → data/seohak.json`);
}

main().catch((e) => { console.error(`⚠ 서학개미 수집 실패 — 어제 파일 그대로: ${e.message}`); process.exit(1); });
