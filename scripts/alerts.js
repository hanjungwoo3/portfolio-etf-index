// 시장경보 종목 — 투자경고·투자위험(지금 지정 중) + 투자주의(오늘 지정).
//   portfolio-web 지수 탭 카드의 경고 책갈피용. 종목마다 토스 뱃지를 부르면 한국 종목 180장에 180콜이라
//   여기서 하루 1회 한국거래소 공시(KIND) 목록으로 받아 둔다(프론트 0콜, 프록시 화이트리스트 변경 없음).
//
//   KIND investattentwarnrisky: menuIndex 1=투자주의, 2=투자경고, 3=투자위험. 응답은 EUC-KR HTML 표
//   (번호·종목명·종목코드·공시일·지정일·해제일). 해제일이 "-" 면 지금도 지정 중이다.
//   투자주의는 하루짜리 지정이라 해제일이 늘 "-" — 지정일이 오늘인 것만 쓴다.
//   (실측 2026-10-13: 투자경고 19종 — 피에스케이 319660 은 9/28 지정·미해제)
//
//   실패하면 **아무것도 쓰지 않는다** — 빈 파일로 덮으면 경고가 전부 풀린 것처럼 보인다(어제 파일 유지).
//
//   + 매매거래정지(2026-10-27 추가, 사용자: "투자경고랑 같은 로직") — KIND tradinghaltissue 목록(오늘 기준 정지 중인 종목, 이름·사유).
//     목록에 종목코드가 없어 KIND 상장법인목록(회사명→종목코드)으로 바꾼다. ETF·스팩 등 목록에 없는 이름은 건너뛴다.
//     marketType=0(전체) 을 꼭 넣는다 — 빈 값이면 빈 응답이 온다(실측). 응답은 UTF-8.
//     정지 목록만 실패하면 경고 3단계는 그대로 쓰고 정지만 뺀다(하루 동안 정지 책갈피만 없음).
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const DATA_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "data");
const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126 Safari/537.36";
const KIND_URL = "https://kind.krx.co.kr/investwarn/investattentwarnrisky.do";
const LOOKBACK_DAYS = 120;   // 투자경고는 길게 이어질 수 있다 — 지정일이 넉넉히 들어오게

const kstYmd = (d = new Date()) => new Date(d.getTime() + 9 * 3600_000).toISOString().slice(0, 10);

async function fetchKind(menuIndex) {
  const today = new Date();
  const body = new URLSearchParams({
    method: "investattentwarnriskySub",
    currentPageSize: "3000", pageIndex: "1",
    orderMode: "4", orderStat: "D",
    menuIndex: String(menuIndex),
    forward: "invstwarnisu_down",
    marketType: "",
    startDate: kstYmd(new Date(today.getTime() - LOOKBACK_DAYS * 86400_000)),
    endDate: kstYmd(today),
  });
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 20_000);
  try {
    const resp = await fetch(KIND_URL, {
      method: "POST", signal: ctrl.signal,
      headers: { "User-Agent": UA, "Content-Type": "application/x-www-form-urlencoded",
                 "Referer": `${KIND_URL}?method=investattentwarnriskyMain` },
      body: body.toString(),
    });
    if (!resp.ok) throw new Error(`KIND HTTP ${resp.status} (menuIndex ${menuIndex})`);
    const html = new TextDecoder("euc-kr").decode(await resp.arrayBuffer());
    const rows = [];
    for (const tr of html.match(/<tr[^>]*>[\s\S]*?<\/tr>/g) ?? []) {
      const c = (tr.match(/<td[^>]*>[\s\S]*?<\/td>/g) ?? []).map((x) => x.replace(/<[^>]+>/g, "").trim());
      // 번호·종목명·종목코드·공시일·지정일·해제일
      if (c.length >= 6 && /^[\dA-Za-z]{6}$/.test(c[2])) rows.push({ name: c[1], code: c[2], from: c[4], to: c[5] });
    }
    // 표 머리는 있는데 행이 0이면 '지정 종목 없음' 일 수 있다 — 머리조차 없으면 응답이 깨진 것
    if (!/종목코드/.test(html)) throw new Error(`KIND 응답에 표가 없다 (menuIndex ${menuIndex})`);
    return rows;
  } finally {
    clearTimeout(t);
  }
}

async function kindPost(url, form, referer, enc) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 30_000);
  try {
    const resp = await fetch(url, {
      method: form ? "POST" : "GET", signal: ctrl.signal,
      headers: { "User-Agent": UA, "Referer": referer, ...(form ? { "Content-Type": "application/x-www-form-urlencoded" } : {}) },
      body: form ? new URLSearchParams(form).toString() : undefined,
    });
    if (!resp.ok) throw new Error(`KIND HTTP ${resp.status} ${url}`);
    return new TextDecoder(enc).decode(await resp.arrayBuffer());
  } finally { clearTimeout(t); }
}
const cells = (tr) => (tr.match(/<t[dh][^>]*>[\s\S]*?<\/t[dh]>/g) ?? []).map((x) => x.replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim());

// 매매거래정지 중인 종목 → [{ code, name, reason }]
async function fetchHalts() {
  const HALT_URL = "https://kind.krx.co.kr/investwarn/tradinghaltissue.do";
  const html = await kindPost(HALT_URL, {
    method: "searchTradingHaltIssueSub", currentPageSize: "3000", pageIndex: "1", searchMode: "", searchCodeType: "",
    searchCorpName: "", forward: "tradinghaltissue_sub", paxreq: "", outsvcno: "", marketType: "0", repIsuSrtCd: "",
  }, `${HALT_URL}?method=searchTradingHaltIssueMain`, "utf-8");
  if (!/사유/.test(html)) throw new Error("KIND 정지 목록 응답에 표가 없다");
  const rows = (html.match(/<tr[^>]*>[\s\S]*?<\/tr>/g) ?? []).map(cells).filter((c) => c.length >= 3 && /^\d+$/.test(c[0]));
  // 회사명 → 종목코드 (상장법인목록, EUC-KR 표)
  const corp = await kindPost("https://kind.krx.co.kr/corpgeneral/corpList.do?method=download&searchType=13", null,
    "https://kind.krx.co.kr/corpgeneral/corpList.do?method=loadInitPage", "euc-kr");
  const codeOf = new Map();
  for (const tr of corp.match(/<tr[^>]*>[\s\S]*?<\/tr>/g) ?? []) {
    const c = cells(tr);
    if (c.length >= 3 && /^[\dA-Za-z]{6}$/.test(c[2])) codeOf.set(c[0], c[2]);
  }
  if (codeOf.size < 1000) throw new Error(`상장법인목록이 너무 적다(${codeOf.size})`);
  const out = [];
  for (const [, name, reason] of rows) { const code = codeOf.get(name); if (code) out.push({ code, name, reason }); }
  return { halts: out, total: rows.length };
}

async function main() {
  const today = kstYmd();
  const [caution, warning, danger] = await Promise.all([fetchKind(1), fetchKind(2), fetchKind(3)]);
  let halt = { halts: [], total: 0 };
  try { halt = await fetchHalts(); } catch (e) { console.error(`⚠ 거래정지 목록 실패 — 경고 3단계만 쓴다: ${e.message}`); }
  const active = (rows) => rows.filter((r) => r.to === "-" || r.to === "");
  // 높은 단계가 이긴다: 투자주의 < 투자경고 < 투자위험
  const alerts = {};
  for (const r of caution.filter((x) => x.from === today)) alerts[r.code] = { level: "투자주의", from: r.from, name: r.name };
  for (const r of active(warning)) alerts[r.code] = { level: "투자경고", from: r.from, name: r.name };
  // 거래정지는 투자경고보다 위, 투자위험보다 아래(토스 뱃지 우선순위와 같다)
  for (const r of halt.halts) if (alerts[r.code]?.level !== "투자위험") alerts[r.code] = { level: "거래정지", from: today, name: r.name, reason: r.reason };
  for (const r of active(danger)) alerts[r.code] = { level: "투자위험", from: r.from, name: r.name };

  const count = (lv) => Object.values(alerts).filter((a) => a.level === lv).length;
  const meta = { version: today, builtAt: new Date().toISOString(),
                 warning: count("투자경고"), danger: count("투자위험"), caution: count("투자주의"),
                 halt: count("거래정지"), haltListed: halt.total };
  await fs.mkdir(DATA_DIR, { recursive: true });
  await fs.writeFile(path.join(DATA_DIR, "market-alerts.json"), JSON.stringify({ meta, alerts }, null, 0) + "\n");
  console.log(`시장경보: 투자경고 ${meta.warning} · 투자위험 ${meta.danger} · 투자주의(오늘) ${meta.caution} · 거래정지 ${meta.halt}/${meta.haltListed} → data/market-alerts.json`);
}

main().catch((e) => { console.error(`⚠ 시장경보 수집 실패 — 어제 파일을 그대로 둔다: ${e.message}`); process.exit(1); });
