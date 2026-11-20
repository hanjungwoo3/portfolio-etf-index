// 미국 종목 일별 공매도 거래 비중 — FINRA Reg SHO 일별 파일(CNMSshvol, 장외·거래소 보고분 합산). 키 없이 받는다.
//   portfolio-web '반도체 수급(미국)' 탭(사용자 2026-11-21). 하루 한 파일(그날 미국 장 마감 뒤 저녁에 올라온다), 휴일은 404.
//   주의: '공매도 잔고'가 아니라 그날 체결 중 공매도로 보고된 **거래량 비중** — 시장조성 물량이 섞여 평소에도 30~50% 다.
//   추이(평소보다 높아졌나)로 본다. 이미 받은 날은 다시 받지 않는다(빠진 날만). 실패하면 어제 파일 그대로.
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const DATA_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "data");
const OUT = path.join(DATA_DIR, "us-short-volume.json");
// 볼 종목 — 반도체(미국) 탭 + 반도체 대표. 늘리려면 여기에(웹 쪽 목록과 따로)
const TICKERS = ["MU", "NVDA", "TSM", "AVGO", "AMD", "SNDK", "WDC", "INTC", "QCOM", "ARM", "AMAT", "LRCX", "ASML", "SOXX", "SMH", "SOXL", "SOXS"];
const KEEP = 70;        // 영업일 약 3달
const LOOKBACK = 100;   // 달력일 — 이 안의 평일 중 없는 날만 받는다

const ymd = d => d.toISOString().slice(0, 10).replace(/-/g, "");

async function get(url) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 30_000);
  try {
    const r = await fetch(url, { signal: ctrl.signal, headers: { "User-Agent": "Mozilla/5.0" } });
    if (r.status === 404 || r.status === 403) return null;   // 휴일·아직 안 올라옴
    if (!r.ok) throw new Error(`FINRA HTTP ${r.status}`);
    return await r.text();
  } finally { clearTimeout(t); }
}

async function main() {
  let old = { days: [] };
  try { old = JSON.parse(await fs.readFile(OUT, "utf8")); } catch { /* 처음 */ }
  const have = new Map((old.days ?? []).map(d => [d.date, d]));
  const want = [];
  for (let i = 0; i < LOOKBACK; i++) {
    const d = new Date(Date.now() - i * 86400_000);
    const wd = d.getUTCDay();
    if (wd === 0 || wd === 6) continue;
    const key = ymd(d);
    const iso = `${key.slice(0, 4)}-${key.slice(4, 6)}-${key.slice(6, 8)}`;
    if (!have.has(iso) || i < 4) want.push([key, iso]);   // 최근 며칠은 다시(늦게 올라온 날)
  }
  let got = 0;
  for (const [key, iso] of want) {
    const text = await get(`https://cdn.finra.org/equity/regsho/daily/CNMSshvol${key}.txt`);
    if (!text) continue;
    const rows = {};
    for (const line of text.split("\n")) {
      const [, sym, sv, , tv] = line.split("|");
      if (TICKERS.includes(sym) && Number(tv) > 0) rows[sym] = [Math.round(Number(sv)), Math.round(Number(tv))];
    }
    if (Object.keys(rows).length) { have.set(iso, { date: iso, rows }); got++; }
  }
  const days = [...have.values()].sort((a, b) => a.date.localeCompare(b.date)).slice(-KEEP);
  if (days.length < 5) throw new Error(`날이 너무 적다(${days.length}) — 어제 파일 유지`);
  await fs.mkdir(DATA_DIR, { recursive: true });
  await fs.writeFile(OUT, JSON.stringify({ meta: { builtAt: new Date().toISOString(), source: "FINRA Reg SHO daily (CNMSshvol)", tickers: TICKERS, note: "rows[t] = [공매도 거래량, 전체 보고 거래량]" }, days }));
  console.log("us-short", days.length, "days, new", got, "last", days.at(-1)?.date);
}
main().catch(e => { console.error(e); process.exit(1); });
