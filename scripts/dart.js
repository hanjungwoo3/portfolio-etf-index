// DART 오늘의 공시(유가·코스닥) → 날짜별 JSON — portfolio-web '📋 최신공시' 페이지가 읽는다(사용자 제안 2026-10-28:
//   "조회하면 서버에 저장하고 다른 조회들은 서버에서 가져가게, 일정 시간으로 갱신").
//   사용자 수와 상관없이 DART 호출은 여기 한 곳(10분마다), 웹은 이 파일만 읽어 프록시가 필요 없다.
//   GET dart.fss.or.kr/dsac001/search.ax?selectDate=YYYY.MM.DD&currentPage=N&pageGrouping=Y|K — 한 쪽 100건·최신순,
//   전체 건수 <input id="totalCnt">. 종목코드는 없어 KIND 상장사 표(data/listed-corps.json, alerts.js 가 매일)로 붙인다.
//   출력: <OUT>/data/dart/YYYY-MM-DD.json { meta:{date,builtAt,count,final}, rows:[{rcpNo,time,market,corp,code,title,submitter}] }
//   전날 파일은 다음 날 첫 실행 때 한 번 더 받아 final:true 로 닫는다. 40일 지난 파일은 지운다. 실패하면 그 날 파일을 덮지 않는다.
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const OUT = path.resolve(process.argv[2] ?? path.join(ROOT, "dart-out"));
const DIR = path.join(OUT, "data", "dart");
const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126 Safari/537.36";
const KEEP_DAYS = 40, PAGE = 100, MAX_PAGES = 20;
const kst = (d = new Date()) => new Date(d.getTime() + 9 * 3600_000).toISOString().slice(0, 10);
const shift = (ymd, n) => new Date(Date.parse(`${ymd}T00:00:00Z`) + n * 86400_000).toISOString().slice(0, 10);
const text = (h) => h.replace(/<[^>]+>/g, " ").replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/\s+/g, " ").trim();
const norm = (n) => n.replace(/\(주\)|㈜|주식회사|\s+/g, "").toUpperCase();
const MARKET = { kospi: "유가", kosdaq: "코스닥" };

function parse(html) {
  const total = Number(/id="totalCnt"[^>]*value="(\d+)"/.exec(html)?.[1] ?? 0);
  const rows = [];
  for (const tr of html.match(/<tr>[\s\S]*?<\/tr>/g) ?? []) {
    const tds = tr.match(/<td[^>]*>[\s\S]*?<\/td>/g) ?? [];
    const rcp = /rcpNo=(\d+)/.exec(tr)?.[1];
    if (tds.length < 4 || !rcp) continue;
    const mk = /tagCom_(kospi|kosdaq|konex|etc)"/.exec(tds[1])?.[1] ?? "etc";
    const corpA = /<a[^>]*openCorpInfoNew\('(\d+)'[^>]*>([\s\S]*?)<\/a>/.exec(tds[1]);
    const titleA = /<a[^>]*rcpNo=\d+[^>]*>([\s\S]*?)<\/a>/.exec(tds[2]);
    rows.push({ rcpNo: rcp, time: text(tds[0]).slice(0, 5), market: MARKET[mk] ?? "기타", corp: text(corpA?.[2] ?? ""),
      title: text(titleA?.[1] ?? ""), submitter: /title="([^"]*)"/.exec(tds[3])?.[1] ?? text(tds[3]) });
  }
  return { rows, total };
}

async function get(url) {
  const ctrl = new AbortController(); const t = setTimeout(() => ctrl.abort(), 30_000);
  try {
    const r = await fetch(url, { headers: { "User-Agent": UA, Referer: "https://dart.fss.or.kr/dsac001/mainAll.do" }, signal: ctrl.signal });
    if (!r.ok) throw new Error(`DART HTTP ${r.status}`);
    return await r.text();
  } finally { clearTimeout(t); }
}

async function day(ymd) {
  const sel = ymd.replace(/-/g, ".");
  const url = (g, n) => `https://dart.fss.or.kr/dsac001/search.ax?currentPage=${n}&maxResults=${PAGE}&maxLinks=10&sort=&series=&mdayCnt=0&selectDate=${sel}&pageGrouping=${g}`;
  const out = [];
  for (const g of ["Y", "K"]) {                     // 유가 → 코스닥, 쪽은 차례로(DART 에 몰아치지 않게)
    const first = parse(await get(url(g, 1)));
    out.push(...first.rows);
    const pages = Math.min(MAX_PAGES, Math.ceil(first.total / PAGE));
    for (let n = 2; n <= pages; n++) out.push(...parse(await get(url(g, n))).rows);
  }
  const seen = new Set();
  return out.filter(r => !seen.has(r.rcpNo) && seen.add(r.rcpNo)).sort((a, b) => b.time.localeCompare(a.time) || b.rcpNo.localeCompare(a.rcpNo));
}

async function corpCodes() {
  try {
    const j = JSON.parse(await fs.readFile(path.join(ROOT, "data", "listed-corps.json"), "utf8"));
    return new Map(Object.entries(j.corps ?? {}).map(([n, c]) => [norm(n), c]));
  } catch { return new Map(); }   // 표가 없으면 code 없이(웹이 보유 종목 이름으로 맞춘다)
}

async function readMeta(ymd) {
  try { return JSON.parse(await fs.readFile(path.join(DIR, `${ymd}.json`), "utf8")).meta ?? null; } catch { return null; }
}

async function main() {
  await fs.mkdir(DIR, { recursive: true });
  const codes = await corpCodes();
  const today = kst(), yday = shift(today, -1);
  const targets = [today];
  const ym = await readMeta(yday);
  if (!ym?.final) targets.push(yday);              // 전날은 한 번 더 받아 마감
  // 빠진 지난 날짜 메우기 — 실행마다 BACKFILL 일(기본 3)씩, 최근 KEEP_DAYS 일 중 파일이 없는 날(사용자 2026-10-28 "2일치만 되는거야?").
  //   수동 실행에서 BACKFILL=40 이면 한 번에 다 채운다.
  const backfill = Number(process.env.BACKFILL ?? 3);
  for (let i = 2, added = 0; i <= KEEP_DAYS && added < backfill; i++) {
    const d = shift(today, -i);
    if (await readMeta(d)) continue;   // 주말·휴장일도 한 번 받아 0건 파일로 — 웹이 그 날짜를 골라도 직접 조회로 안 넘어가게
    targets.push(d); added++;
  }
  for (const ymd of targets) {
    try {
      const rows = (await day(ymd)).map(r => ({ ...r, code: codes.get(norm(r.corp)) }));
      const meta = { date: ymd, builtAt: new Date().toISOString(), count: rows.length, final: ymd !== today };
      await fs.writeFile(path.join(DIR, `${ymd}.json`), JSON.stringify({ meta, rows }) + "\n");
      console.log(`DART ${ymd}: ${rows.length}건 (종목코드 ${rows.filter(r => r.code).length}건)${meta.final ? " · 마감" : ""}`);
    } catch (e) { console.error(`⚠ DART ${ymd} 실패 — 이전 파일 그대로: ${e.message}`); }
  }
  // 날짜 목록 + 오래된 파일 정리
  const keepFrom = shift(today, -KEEP_DAYS);
  const files = (await fs.readdir(DIR)).filter(f => /^\d{4}-\d{2}-\d{2}\.json$/.test(f));
  for (const f of files) if (f.slice(0, 10) < keepFrom) await fs.rm(path.join(DIR, f));
  const dates = (await fs.readdir(DIR)).filter(f => /^\d{4}-\d{2}-\d{2}\.json$/.test(f)).map(f => f.slice(0, 10)).sort().reverse();
  await fs.writeFile(path.join(DIR, "index.json"), JSON.stringify({ builtAt: new Date().toISOString(), dates }) + "\n");
}

main().catch(e => { console.error(e); process.exit(1); });
