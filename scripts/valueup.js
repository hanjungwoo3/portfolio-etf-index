// 기업 밸류업 꼬리표 — 거래소 KIND 밸류업 메뉴의 세 명단(사용자 2026-11-02 "저PBR 종목 정보가 나온다는데" → 꼬리표).
//   1) 저PBR기업   /valueup/lowpbr.do     — 2026-11-02 첫 공표 151곳(유가 96·코스닥 55), 매년 5월·11월. 종목코드·PBR·GICS 업종·기준일이 표에 있다(EUC-KR).
//   2) 고배당기업   /valueup/dividend.do   — '기업가치 제고 계획' 공시의 고배당기업 여부 '해당'(조특법 104조의27). 회사명만(UTF-8).
//   3) 밸류업 우수기업 /valueup/excntcorp.do — 연도별 시상(거래소 이사장상·금융위원장상 등). 회사명만(UTF-8).
//   회사명 → 종목코드는 alerts.js 가 같은 실행에서 써 둔 listed-corps.json(KIND 상장법인목록).
//
//   명단 하나가 실패하면 그 명단만 어제 값 그대로 둔다 — 빈 값으로 덮으면 꼬리표가 다 떨어진 것처럼 보인다.
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const DATA_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "data");
const OUT = path.join(DATA_DIR, "valueup-tags.json");
const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126 Safari/537.36";
const KIND = "https://kind.krx.co.kr/valueup";

async function kindPost(page, mainMethod, form, enc) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 30_000);
  try {
    const resp = await fetch(`${KIND}/${page}`, {
      method: "POST", signal: ctrl.signal,
      headers: { "User-Agent": UA, "Content-Type": "application/x-www-form-urlencoded",
                 "Referer": `${KIND}/${page}?method=${mainMethod}` },
      body: new URLSearchParams({ currentPageSize: "3000", pageIndex: "1", orderMode: "", orderStat: "", marketType: "", ...form }).toString(),
    });
    if (!resp.ok) throw new Error(`KIND HTTP ${resp.status} ${page}`);
    return new TextDecoder(enc).decode(await resp.arrayBuffer());
  } finally { clearTimeout(t); }
}
const rowsOf = (html) => (html.match(/<tr[^>]*>[\s\S]*?<\/tr>/g) ?? [])
  .map((tr) => (tr.match(/<td[^>]*>[\s\S]*?<\/td>/g) ?? []).map((x) => x.replace(/<[^>]+>/g, "").replace(/&nbsp;/g, " ").replace(/\s+/g, " ").trim()))
  .filter((c) => c.length >= 3 && /^\d+$/.test(c[0]));
const numOr = (s) => { const n = Number(String(s).replace(/,/g, "")); return Number.isFinite(n) ? n : undefined; };

// 번호·시장·종목코드·회사명·공표일자·PBR·GICS업종·PBR기준일·결산월
async function fetchLowPbr() {
  const html = await kindPost("lowpbr.do", "valueupLowpbrMain",
    { method: "valueupLowpbrSub", forward: "valueupLowpbr_down", searchCorpName: "" }, "euc-kr");
  const out = {};
  for (const c of rowsOf(html)) {
    if (c.length < 9 || !/^[\dA-Za-z]{6}$/.test(c[2])) continue;
    out[c[2]] = { name: c[3], pbr: numOr(c[5]), sector: c[6] || undefined, base: c[7], pub: c[4] };
  }
  if (Object.keys(out).length < 20) throw new Error(`저PBR 명단이 너무 적다(${Object.keys(out).length})`);
  return out;
}

// 번호·회사명·공시제목·사업연도·결산월·(지표 둘)
async function fetchHighDiv(codeOf) {
  const html = await kindPost("dividend.do", "valueupHighDividendMain",
    { method: "valueupHighDividendSub", forward: "valueupHighDividend_sub", selYear: "" }, "utf-8");
  const out = {}; let miss = 0;
  for (const c of rowsOf(html)) {
    const code = codeOf.get(c[1]);
    if (!code) { miss++; continue; }
    const year = c[3];
    if (!out[code] || String(out[code].year) < year) out[code] = { name: c[1], year };
  }
  if (Object.keys(out).length < 20) throw new Error(`고배당 명단이 너무 적다(${Object.keys(out).length})`);
  return { list: out, miss };
}

// 번호·회사명·연도·상
async function fetchExcellent(codeOf) {
  const html = await kindPost("excntcorp.do", "valueupExcntCorpMain",
    { method: "valueupExcntCorpSub", forward: "valueupExcntCorp_sub", awardYear: "all" }, "utf-8");
  const out = {}; let miss = 0;
  for (const c of rowsOf(html)) {
    const code = codeOf.get(c[1]);
    if (!code) { miss++; continue; }
    (out[code] ??= { name: c[1], awards: [] }).awards.push({ year: c[2], award: c[3] });
  }
  for (const v of Object.values(out)) v.awards.sort((a, b) => b.year.localeCompare(a.year));
  if (Object.keys(out).length < 5) throw new Error(`밸류업 우수기업 명단이 너무 적다(${Object.keys(out).length})`);
  return { list: out, miss };
}

async function main() {
  let prev = {};
  try { prev = JSON.parse(await fs.readFile(OUT, "utf-8")); } catch { /* 첫 실행 */ }
  const corps = JSON.parse(await fs.readFile(path.join(DATA_DIR, "listed-corps.json"), "utf-8")).corps ?? {};
  const codeOf = new Map(Object.entries(corps));
  if (codeOf.size < 1000) throw new Error(`listed-corps.json 이 너무 적다(${codeOf.size})`);

  const [low, div, exc] = await Promise.allSettled([fetchLowPbr(), fetchHighDiv(codeOf), fetchExcellent(codeOf)]);
  const pick = (r, key, label) => {
    if (r.status === "fulfilled") return r.value.list ?? r.value;
    console.error(`⚠ ${label} 실패 — 어제 값 유지: ${r.reason?.message}`);
    return prev[key] ?? {};
  };
  const lowpbr = pick(low, "lowpbr", "저PBR"), highdiv = pick(div, "highdiv", "고배당"), excellent = pick(exc, "excellent", "밸류업 우수기업");
  if (![low, div, exc].some((r) => r.status === "fulfilled")) throw new Error("세 명단 모두 실패");

  const meta = { builtAt: new Date().toISOString(),
                 lowpbr: Object.keys(lowpbr).length, highdiv: Object.keys(highdiv).length, excellent: Object.keys(excellent).length,
                 highdivMiss: div.value?.miss, excellentMiss: exc.value?.miss };
  await fs.writeFile(OUT, JSON.stringify({ meta, lowpbr, highdiv, excellent }) + "\n");
  console.log(`밸류업 꼬리표: 저PBR ${meta.lowpbr} · 고배당 ${meta.highdiv}(이름 못 찾음 ${meta.highdivMiss ?? "-"}) · 우수기업 ${meta.excellent}(${meta.excellentMiss ?? "-"}) → data/valueup-tags.json`);
}

main().catch((e) => { console.error(`⚠ 밸류업 꼬리표 수집 실패 — 어제 파일 그대로: ${e.message}`); process.exit(1); });
