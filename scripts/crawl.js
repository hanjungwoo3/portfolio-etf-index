// 한국 ETF 구성종목 크롤러 + 테마 카드 빌더
//   1. 네이버 finance API 로 전체 ETF 목록 (코드 + 이름) — EUC-KR 디코드.
//   2. 네이버 '테마' 를 카드 단위로 묶는다 (지수 탭 섹터 흐름용, ETF 와 무관한 종목 바스켓).
//   3. 각 ETF 의 구성종목을 토스 v2 endpoint 로 fetch.
//   4. 역색인(stock → [{etfCode, ratio}]) + 정방향(etf → [{stockCode, name, ratio}]) 생성.
//   5. data/etf-list.json, data/etf-index.json, data/etf-compositions.json,
//      data/theme-cards.json 으로 저장.
//
// 실행: node scripts/crawl.js
//   환경변수: CONCURRENCY(기본 6), MAX_ETFS(테스트용 제한, 기본 무제한)

import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { THEME_CARDS } from "./theme-cards.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.resolve(__dirname, "..", "data");

const NAVER_ETF_LIST = "https://finance.naver.com/api/sise/etfItemList.nhn?etfType=0";
const TOSS_COMPOSITIONS = (code) =>
  `https://wts-info-api.tossinvest.com/api/v2/stock-infos/A${code}/compositions`;
const TOSS_CANDLES = (code) =>
  `https://wts-info-api.tossinvest.com/api/v1/c-chart/kr-s/A${code}/day:1?count=${CANDLE_COUNT}`;
// 기간 수익률용 일봉 개수. 1년(약 252 거래일)을 덮으려면 260이면 넉넉하다.
//   토스 c-chart count 상한은 450 이라 여유가 있다. 콜 수는 그대로(ETF 당 1콜), 응답만 커진다.
const CANDLE_COUNT = 260;
// 기간 → 거래일 수. 달력일이 아니라 거래일로 센다(휴장 때문에 달력일은 들쭉날쭉하다).
//   이력이 짧은 신규 상장 ETF 는 그 기간만 건너뛴다(fetchReturns 안에서 처리).
const RETURN_PERIODS = { w1: 5, m1: 21, m3: 63, m6: 126, y1: 252 };

// ★ 2026-09-12: finance.naver.com/sise/theme.naver 와 sise_group_detail 이 모두
//   stock.naver.com 새 사이트로 302 된다. 따라가면 Next.js SPA 껍데기라 테마가 0건이 된다.
//   → m.stock JSON 으로 갈아탔다. 목록·상세가 같은 계열이고 EUC-KR 디코드도 필요 없다.
const NAVER_THEME_LIST = (page) =>
  `https://m.stock.naver.com/api/stocks/theme?page=${page}&pageSize=100`;
const NAVER_THEME_DETAIL = (no) =>
  `https://m.stock.naver.com/api/stocks/theme/${no}?pageSize=100`;
const THEME_PAGES = 5;   // 266개 테마 → 100개씩 3쪽. totalCount 로 끊고 여유만 둔다

// ─── 업종·테마 '분류' 그대로 가져오기 ───────────────────────────
//   THEME_CARDS 는 우리가 손으로 고른 38개다. 그것과 별개로 네이버 전체 분류
//   (업종 79 · 테마 266)를 통째로 담아, 앱이 같은 계산(시총 하한 + 중앙값 + 프리·애프터)을
//   그 분류에도 적용할 수 있게 한다. 네이버가 계산해 둔 등락률은 쓰지 않는다 —
//   계산 기준이 공개돼 있지 않고 잡주 필터도 없어서 우리 카드와 숫자가 섞이면 안 된다.
//
//   ★ stocklist 는 pageSize=200 까지 받고(300 은 400) **marketSum 을 같이 준다**.
//     그래서 시총을 따로 긁을 필요가 없다 — 한 업종/테마당 1콜이면 끝난다.
const NAVER_INDUSTRY_LIST =
  "https://stock.naver.com/api/stockSecurity/rankings/v2/domestic/industries?sortType=changeRate&size=100&period=daily";
const NAVER_GROUP_STOCKS = (kind, id) =>
  `https://stock.naver.com/api/domestic/market/${kind}/${id}/stocklist`
  + "?marketType=ALL&orderType=priceTop&startIdx=0&pageSize=200";
// KRX 주가지수 공지 — 지수 정기변경(CAP Factor·섹터지수 구성종목 등) 안내가 여기 올라온다.
//   예: "26년 9월 CAP Factor 정기변경" → 종목당 20% 상한을 넘은 비중을 덜어내는 리밸런싱.
//       실제로 2026-09-10 에 SK하이닉스 1.2조·삼성전자 0.2조 매도 수요가 나왔다.
//   ★ data.krx.co.kr 의 getJsonData.cmd 는 로그인이 필요하지만, 이 게시판 엔드포인트는
//     세션 없이 된다(실측). 파라미터 이름이 특이하다 — curPage/condTp/titleContn.
const KRX_NOTICE_LIST = "https://data.krx.co.kr/contents/MDC/COMS/board/MDCCOMS010_S1D1.cmd";
const KRX_NOTICE_REFERER =
  "https://data.krx.co.kr/contents/MDC/COMS/board/MDCCOMS010_S1.cmd?boardId=MDCINFO005";
const KRX_NOTICE_DETAIL = "https://data.krx.co.kr/contents/MDC/COMS/board/MDCCOMS010_S2D1.cmd";
const KRX_NOTICE_URL = (seq) =>
  "https://data.krx.co.kr/contents/MDC/COMS/board/MDCCOMS010_S2.cmd"
  + `?boardId=MDCINFO005&cmBbsId=MKD01040000&bbsSeq=${seq}`;
const KRX_NOTICE_KEEP = 30;   // 최근 30건이면 반년치는 덮는다

const NAVER_MARKET_VALUE = (market, page) =>
  `https://m.stock.naver.com/api/stocks/marketValue/${market}?page=${page}&pageSize=100`;
// 시가총액 하한(억원). 테마 종목의 절반이 1,300억 미만이라 안 거르면 잡주 몇 개가
//   중앙값을 흔든다.
//   5,000억으로 정한 근거(2026-09-09 실측) — 올릴수록 섹터 구분력(최고카드-최저카드 폭)이
//   좋아진다: 2천억 7.6%p → 3천억 9.4%p → 5천억 11.6%p. 광통신·CPO 가 +5.84% → +9.75% 로
//   선명해지는 식이다. 순위 자체는 임계값을 올려도 거의 바뀌지 않는다.
//   2조까지 올리면 광통신·CPO 가 표본 2종으로 무너지므로 그 앞에서 멈춘다.
//   ★ 대가 — 표본이 작은 카드(양자컴퓨팅 4종 등)는 중앙값이 한두 종목에 좌우된다.
//     그래서 프론트가 8종 미만 카드의 종수를 주황색으로 띄워 경고한다.
const MIN_CAP = 5000;

const UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) " +
  "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36";

// 색인 대상 종목코드 — 국내 6자리 OR 해외 토스코드(US/NAS/NYS/AMX...).
//   선물·현금성·"그 외"(stockCode=null)·"기타" 등은 제외.
const isIndexableCode = (c) =>
  typeof c === "string" && (/^\d{6}$/.test(c) || /^(US|NAS|NSQ|NYS|AMX|AMS)\w+$/.test(c));

const CONCURRENCY = Number(process.env.CONCURRENCY ?? "6");
const MAX_ETFS = process.env.MAX_ETFS ? Number(process.env.MAX_ETFS) : Infinity;
const REQUEST_TIMEOUT_MS = 15_000;

async function fetchWithTimeout(url, init = {}) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), REQUEST_TIMEOUT_MS);
  try {
    return await fetch(url, { ...init, signal: ctrl.signal });
  } finally {
    clearTimeout(t);
  }
}

// finance.naver.com 은 레거시라 JSON 도 HTML 도 EUC-KR 로 준다 → 반드시 디코드해서 읽는다.
//   (Node 20+ TextDecoder 가 euc-kr 을 지원한다)
async function fetchNaverEucKr(url) {
  const resp = await fetchWithTimeout(url, {
    headers: {
      "User-Agent": UA,
      "Referer": "https://finance.naver.com/",
      "Accept-Language": "ko-KR,ko;q=0.9",
    },
  });
  if (!resp.ok) throw new Error(`Naver HTTP ${resp.status} — ${url}`);
  return new TextDecoder("euc-kr").decode(await resp.arrayBuffer());
}

// m.stock API 는 UTF-8 JSON 이다 — EUC-KR 디코드가 필요 없다.
async function fetchNaverJson(url) {
  const resp = await fetchWithTimeout(url, {
    headers: {
      "User-Agent": UA,
      "Referer": "https://m.stock.naver.com/",
      "Accept": "application/json",
      "Accept-Language": "ko-KR,ko;q=0.9",
    },
  });
  if (!resp.ok) throw new Error(`Naver HTTP ${resp.status} — ${url}`);
  return resp.json();
}

// ─── 1) 네이버 ETF 목록 ──────────────────────────────────────────
async function fetchEtfList() {
  const json = JSON.parse(await fetchNaverEucKr(NAVER_ETF_LIST));
  const items = json?.result?.etfItemList ?? [];
  // 코드 + 이름만 추출, 중복 제거
  const seen = new Set();
  const out = [];
  for (const it of items) {
    const code = String(it.itemcode ?? "").padStart(6, "0");
    const name = String(it.itemname ?? "").trim();
    // ★ 코드를 숫자로 좁히면 안 된다 — 2024년 이후 상장분은 "0167A0" 같은 영숫자다.
    //   숫자만 받던 동안 343종(그중 신형 영숫자 304종)이 통째로 빠져 있었다.
    if (!/^[\dA-Za-z]{6}$/.test(code) || !name) continue;
    if (seen.has(code)) continue;
    seen.add(code);
    out.push({ code, name });
  }
  return out;
}

// ─── 1-b) 네이버 테마 → 카드 ────────────────────────────────────
// 지수 탭의 '섹터 흐름' 은 ETF 가 아니라 이 종목 바스켓으로 그린다.
//   ETF 로 그리면 상품이 있는 테마만 보인다 — 광통신·CPO 처럼 ETF 가 없는 테마는
//   아예 안 보이고, 채권·미국 ETF 같은 시장 흐름과 무관한 칸이 자리를 차지한다.
//
// 테마는 이름으로 찾는다 — 번호는 불투명해서 바뀌면 조용히 엉뚱한 걸 집는다.
//   이름이면 못 찾을 때 경고가 뜨고 그 카드만 비어서 눈에 띈다.
async function fetchThemeCards() {
  const index = new Map();          // 테마 이름 → no
  for (let page = 1; page <= THEME_PAGES; page++) {
    const json = await fetchNaverJson(NAVER_THEME_LIST(page));
    const groups = json?.groups ?? [];
    if (groups.length === 0) break;
    for (const g of groups) {
      const name = String(g?.name ?? "").trim();
      if (name && g?.no != null) index.set(name, String(g.no));
    }
    if (index.size >= (json?.totalCount ?? 0)) break;
  }
  // 시가총액 — 코스피·코스닥 전 종목(약 3,800종, 100종/쪽). 잡주를 걷어내는 기준이다.
  const cap = new Map();            // 종목코드 → 시총(억원)
  for (const market of ["KOSPI", "KOSDAQ"]) {
    for (let page = 1; page <= 30; page++) {
      const resp = await fetchWithTimeout(NAVER_MARKET_VALUE(market, page), {
        headers: { "User-Agent": UA, "Accept": "application/json" },
      });
      if (!resp.ok) break;
      const stocks = (await resp.json())?.stocks ?? [];
      if (stocks.length === 0) break;
      for (const st of stocks) {
        const v = Number(String(st.marketValue ?? "").replace(/,/g, ""));
        if (Number.isFinite(v) && v > 0) cap.set(st.itemCode, v);
      }
    }
  }

  const members = new Map();        // 테마 이름 → [[code, name], ...]
  const missing = [];
  for (const theme of [...new Set(Object.values(THEME_CARDS).flat())]) {
    const no = index.get(theme);
    if (!no) { missing.push(theme); continue; }
    const json = await fetchNaverJson(NAVER_THEME_DETAIL(no));
    members.set(theme, (json?.stocks ?? [])
      .map((st) => [String(st?.itemCode ?? "").trim(), String(st?.stockName ?? "").trim()])
      .filter(([code, name]) => /^[0-9A-Za-z]{6}$/.test(code) && name));
  }
  // 카드 = 테마 합집합. 종목명은 카드마다 중복 저장하지 않고 한 곳에 모은다(파일 크기).
  const names = {};
  const caps = {};
  const cards = {};
  let dropped = 0;
  for (const [card, themes] of Object.entries(THEME_CARDS)) {
    const codes = new Set();
    for (const t of themes) {
      for (const [code, name] of members.get(t) ?? []) {
        const c = cap.get(code) ?? 0;
        if (c < MIN_CAP) { dropped++; continue; }   // 잡주 제외
        codes.add(code);
        names[code] = name;
        caps[code] = c;
      }
    }
    // 표본이 3종 미만이면 중앙값이 한 종목에 좌우된다 — 카드를 아예 만들지 않는다.
    if (codes.size >= 3) cards[card] = [...codes];
  }
  return { cards, names, caps, themeCount: index.size, missing, dropped, minCap: MIN_CAP };
}

// ─── 1-d) 업종·테마 분류(구성종목) ───────────────────────────────
async function fetchGroupMembers() {
  const names = {};   // 종목코드 → 이름
  const caps = {};    // 종목코드 → 시총(억원)

  const collect = async (kind, id, label) => {
    const rows = await fetchNaverJson(NAVER_GROUP_STOCKS(kind, id)).catch(() => []);
    const codes = [];
    for (const r of Array.isArray(rows) ? rows : []) {
      const code = String(r?.itemcode ?? "").trim();
      const name = String(r?.itemname ?? "").trim();
      if (!/^[0-9A-Za-z]{6}$/.test(code) || !name) continue;
      // marketSum 은 원 단위 → 억원. 잡주는 여기서 걸러 카드가 한 종목에 휘둘리지 않게 한다.
      const cap = Math.round(Number(r?.marketSum ?? 0) / 1e8);
      if (!Number.isFinite(cap) || cap < MIN_CAP) continue;
      codes.push(code);
      names[code] = name;
      caps[code] = cap;
    }
    return { id: String(id), name: label, codes };
  };

  // 업종 — 목록 1콜로 코드·이름을 얻고, 각 업종마다 구성종목 1콜.
  const indList = await fetchNaverJson(NAVER_INDUSTRY_LIST).catch(() => ({}));
  const indItems = (indList?.items ?? [])
    .map((x) => ({ id: String(x?.code ?? ""), name: String(x?.name ?? "").trim() }))
    .filter((x) => x.id && x.name);
  const industries = [];
  for (const x of indItems) {
    const g = await collect("upjong", x.id, x.name);
    if (g.codes.length >= 3) industries.push(g);   // 표본 3 미만은 중앙값이 무의미
  }

  // 테마 — 목록은 fetchThemeCards 와 같은 경로지만 여기서 따로 읽는다(의존 방향을 단순하게).
  const themeIndex = [];
  for (let page = 1; page <= THEME_PAGES; page++) {
    const json = await fetchNaverJson(NAVER_THEME_LIST(page)).catch(() => ({}));
    const groups = json?.groups ?? [];
    if (groups.length === 0) break;
    for (const g of groups) {
      const id = String(g?.no ?? "");
      const name = String(g?.name ?? "").trim();
      if (id && name && !themeIndex.some((t) => t.id === id)) themeIndex.push({ id, name });
    }
    if (themeIndex.length >= (json?.totalCount ?? 0)) break;
  }
  const themes = [];
  for (const x of themeIndex) {
    const g = await collect("theme", x.id, x.name);
    if (g.codes.length >= 3) themes.push(g);
  }

  return { industries, themes, names, caps, minCap: MIN_CAP };
}

// ─── 1-e) KRX 주가지수 공지 ──────────────────────────────────────
// 제목·날짜·링크만 담는다. 본문/첨부는 형식이 정형화돼 있지 않아 파싱 품질을 장담 못 한다 —
//   원문으로 보내는 편이 정직하다.
async function fetchKrxNotices() {
  const today = new Date();
  const from = new Date(today.getTime() - 400 * 86400_000);   // 넉넉히 400일
  const ymd = (d) => d.toISOString().slice(0, 10).replace(/-/g, "");
  const body = new URLSearchParams({
    curPage: "1",
    pageSize: String(KRX_NOTICE_KEEP),
    mktId: "",
    condTp: "2",
    titleContn: "",
    strtDd: ymd(from),
    endDd: ymd(today),
    boardId: "MDCINFO005",
  });
  const resp = await fetchWithTimeout(KRX_NOTICE_LIST, {
    method: "POST",
    headers: {
      "User-Agent": UA,
      "Referer": KRX_NOTICE_REFERER,
      "X-Requested-With": "XMLHttpRequest",
      "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
    },
    body: body.toString(),
  });
  if (!resp.ok) return [];
  const rows = (await resp.json())?.output?.OutBlock_1 ?? [];
  const seen = new Set();
  const out = [];
  for (const r of rows) {
    const seq = String(r.BBS_SEQ ?? "").trim();
    const title = String(r.TITLE ?? "").trim();
    if (!seq || !title || seen.has(seq)) continue;   // 상단 고정 공지가 목록에 두 번 나온다
    seen.add(seq);
    out.push({ seq, title, date: String(r.REG_DT ?? "").trim(), url: KRX_NOTICE_URL(seq) });
  }
  // 본문도 받아 둔다 — 앱에서 팝업으로 보여주려면 필요하다.
  //   프론트가 직접 부르면 CORS 때문에 프록시를 타야 하는데, data.krx.co.kr 은 워커
  //   화이트리스트에 없어서 개인 워커까지 전부 갱신해야 한다. 여기서 받으면 그럴 일이 없다.
  for (const n of out) {
    n.body = await fetchKrxNoticeBody(n.seq).catch(() => "");
  }
  // 최신순 — 고정 공지가 위로 끼어들어 날짜 순서가 흐트러져 있다.
  out.sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));
  return out;
}

// 공지 본문 — HTML 태그를 걷어내고 줄바꿈만 남긴다. 원문 링크는 그대로 두므로
//   여기서는 읽을 수 있으면 충분하다.
async function fetchKrxNoticeBody(seq) {
  const resp = await fetchWithTimeout(KRX_NOTICE_DETAIL, {
    method: "POST",
    headers: {
      "User-Agent": UA,
      "Referer": KRX_NOTICE_REFERER,
      "X-Requested-With": "XMLHttpRequest",
      "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
    },
    body: new URLSearchParams({
      boardId: "MDCINFO005", cmBbsId: "MKD01040000", bbsSeq: seq,
    }).toString(),
  });
  if (!resp.ok) return "";
  const html = (await resp.json())?.output?.MAINDOC_CONTN ?? "";
  return String(html)
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|li|tr)>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .split("\n").map(l => l.trim()).filter(Boolean).join("\n")
    .slice(0, 4000);   // 아주 긴 공지는 잘라 둔다 — 원문 링크가 있다
}

// ─── 2) 토스 구성종목 ────────────────────────────────────────────
async function fetchCompositions(code) {
  const resp = await fetchWithTimeout(TOSS_COMPOSITIONS(code), {
    headers: {
      "User-Agent": UA,
      "Origin": "https://tossinvest.com",
      "Referer": "https://tossinvest.com/",
      "Accept": "application/json",
    },
  });
  if (!resp.ok) return null;
  const data = await resp.json();
  const items = data?.result?.items ?? [];
  return items
    .map((it) => ({
      stockCode: typeof it.stockCode === "string"
        ? it.stockCode.replace(/^A(?=\d{6}$)/, "")   // 국내 A005930→005930, 해외 US.../NAS...는 보존
        : "",
      name: String(it.name ?? "").trim(),
      ratio: typeof it.ratio === "number" ? it.ratio : 0,
    }))
    .filter((it) => it.name);
}

// ─── 2-b) 기간 수익률 ────────────────────────────────────────────
// 1주·1개월·3개월·6개월·1년 수익률은 과거 시세가 필요해서 ETF 당 1콜이다(1,100콜 이상).
//   프론트에서는 불가능한 비용이라 여기서 하루 1회 계산해 심어 둔다 → 프론트는 0콜.
//   '오늘' 등락률만 프론트가 실시간으로 구한다(그건 이미 6콜짜리 배치가 있다).
async function fetchReturns(code) {
  const resp = await fetchWithTimeout(TOSS_CANDLES(code), {
    headers: {
      "User-Agent": UA,
      "Origin": "https://tossinvest.com",
      "Referer": "https://tossinvest.com/",
      "Accept": "application/json",
    },
  });
  if (!resp.ok) return null;
  const data = await resp.json();
  // 최신이 앞이다(내림차순). close 가 없는 봉은 버린다.
  const closes = (data?.result?.candles ?? [])
    .map((c) => (typeof c.close === "number" ? c.close : 0))
    .filter((v) => v > 0);
  if (closes.length < 2) return null;
  const latest = closes[0];
  const out = {};
  for (const [key, back] of Object.entries(RETURN_PERIODS)) {
    // 이력이 짧으면(신규 상장) 그 기간은 건너뛴다 — 있는 것만 보여준다.
    if (closes.length <= back) continue;
    const past = closes[back];
    if (past > 0) out[key] = Math.round(((latest / past - 1) * 100) * 100) / 100;
  }
  return Object.keys(out).length > 0 ? out : null;
}

// ─── 동시성 제어된 map ────────────────────────────────────────────
async function pmap(items, fn, concurrency) {
  const out = new Array(items.length);
  let idx = 0;
  const workers = Array.from({ length: concurrency }, async () => {
    while (true) {
      const i = idx++;
      if (i >= items.length) return;
      out[i] = await fn(items[i], i);
    }
  });
  await Promise.all(workers);
  return out;
}

// ─── 메인 ──────────────────────────────────────────────────────
async function main() {
  console.log("[1/4] 네이버 ETF 목록 fetch...");
  const list = await fetchEtfList();
  console.log(`  → ${list.length} 개 ETF`);

  console.log("[2/4] 네이버 테마 카드 + KRX 공지 fetch...");
  const notices = await fetchKrxNotices().catch(() => []);
  console.log(`  → KRX 주가지수 공지 ${notices.length}건`);
  const theme = await fetchThemeCards();
  const groups = await fetchGroupMembers().catch((e) => {
    console.warn(`  ⚠ 업종·테마 분류 수집 실패: ${e.message}`);
    return { industries: [], themes: [], names: {}, caps: {}, minCap: MIN_CAP };
  });
  console.log(`  → 업종 ${groups.industries.length}개 · 테마 ${groups.themes.length}개`
            + ` · 종목 ${Object.keys(groups.names).length}종(시총 ${MIN_CAP}억 이상)`);
  // 네이버가 테마 이름을 바꾸면 그 카드가 조용히 작아진다 — 로그로 드러나게 한다.
  if (theme.missing.length > 0) console.warn(`  ⚠ 못 찾은 테마: ${theme.missing.join(", ")}`);
  console.log(`  → 카드 ${Object.keys(theme.cards).length}개, 종목 ${Object.keys(theme.names).length}종`
              + ` (전체 테마 ${theme.themeCount}개 중 사용, 시총 ${theme.minCap}억 미만 제외)`);

  const targets = list.slice(0, Math.min(list.length, MAX_ETFS));
  console.log(`[3/4] 토스 구성종목 fetch (동시 ${CONCURRENCY}, 대상 ${targets.length})...`);

  let okCount = 0, failCount = 0, retCount = 0;
  const compositions = {};  // { etfCode: [{stockCode, name, ratio}, ...] }
  const returns = {};       // { etfCode: {w1, m1, m3, m6, y1} }
  const startedAt = Date.now();

  await pmap(targets, async (etf, i) => {
    // 구성종목과 일봉은 서로 독립이다 — 한쪽이 실패해도 다른 쪽은 남긴다.
    const [items, ret] = await Promise.all([
      fetchCompositions(etf.code).catch(() => null),
      fetchReturns(etf.code).catch(() => null),
    ]);
    if (ret) { returns[etf.code] = ret; retCount++; }
    if (items && items.length > 0) {
      compositions[etf.code] = items;
      okCount++;
    } else {
      failCount++;
    }
    if ((i + 1) % 100 === 0 || i + 1 === targets.length) {
      const elapsed = ((Date.now() - startedAt) / 1000).toFixed(1);
      console.log(`  ${i + 1}/${targets.length} (구성 ${okCount}/실패 ${failCount}, 수익률 ${retCount}, ${elapsed}s)`);
    }
  }, CONCURRENCY);

  console.log("[4/4] 역색인·파일 저장...");

  // etf-list.json — 메타
  const etfList = {};
  for (const e of list) {
    if (compositions[e.code]) etfList[e.code] = { name: e.name };
  }

  // etf-index.json — 역색인 (종목 → [[ETF코드, 비중], ...])
  const stockIndex = {};
  for (const [etfCode, items] of Object.entries(compositions)) {
    for (const it of items) {
      if (!isIndexableCode(it.stockCode)) continue;   // 선물·현금성·"기타"(null) 제외, 해외 토스코드는 포함
      (stockIndex[it.stockCode] ??= []).push([etfCode, it.ratio]);
    }
  }
  // 각 종목의 ETF 목록을 비중 내림차순 정렬
  for (const arr of Object.values(stockIndex)) arr.sort((a, b) => b[1] - a[1]);

  // etf-compositions.json — 정방향 (ETF → 구성종목 전체)
  const compactCompositions = {};
  for (const [code, items] of Object.entries(compositions)) {
    compactCompositions[code] = items
      .filter((it) => isIndexableCode(it.stockCode))
      .map((it) => [it.stockCode, it.name, it.ratio]);
  }

  const meta = {
    version: new Date().toISOString().slice(0, 10),
    builtAt: new Date().toISOString(),
    etfCount: Object.keys(etfList).length,
    stockCount: Object.keys(stockIndex).length,
    returnCount: Object.keys(returns).length,
    themeCardCount: Object.keys(theme.cards).length,
    themeStockCount: Object.keys(theme.names).length,
    themeMinCap: theme.minCap,
    noticeCount: notices.length,
    okCount, failCount,
  };

  await fs.mkdir(DATA_DIR, { recursive: true });
  await fs.writeFile(
    path.join(DATA_DIR, "etf-list.json"),
    JSON.stringify({ meta, etfs: etfList }, null, 0) + "\n",
  );
  await fs.writeFile(
    path.join(DATA_DIR, "etf-index.json"),
    JSON.stringify({ meta, stocks: stockIndex }, null, 0) + "\n",
  );
  await fs.writeFile(
    path.join(DATA_DIR, "etf-compositions.json"),
    JSON.stringify({ meta, compositions: compactCompositions }, null, 0) + "\n",
  );
  // etf-returns.json — ETF랭킹 탭의 기간(1주·1개월·3개월·6개월·1년) 전용.
  //   '오늘' 은 프론트가 실시간으로 구하므로 여기 없다.
  await fs.writeFile(
    path.join(DATA_DIR, "etf-returns.json"),
    JSON.stringify({ meta, returns }, null, 0) + "\n",
  );
  // krx-notices.json — 지수 정기변경 공지. 제목·링크만이라 몇 KB 다.
  await fs.writeFile(
    path.join(DATA_DIR, "krx-notices.json"),
    JSON.stringify({ meta, notices }, null, 0) + "\n",
  );
  // theme-cards.json — 지수 탭 전용. ETF 색인과 쓰임이 달라 파일을 나눠 둔다
  //   (ETF 색인은 어디서나 읽히고, 이건 지수 탭에서만 받는다).
  await fs.writeFile(
    path.join(DATA_DIR, "theme-cards.json"),
    JSON.stringify({ meta, cards: theme.cards, names: theme.names, caps: theme.caps }, null, 0) + "\n",
  );

  // group-members.json — 네이버 업종·테마 '분류' 원본. 등락률은 앱이 직접 계산한다.
  await fs.writeFile(
    path.join(DATA_DIR, "group-members.json"),
    JSON.stringify({
      meta: {
        version: meta.version, builtAt: meta.builtAt, minCap: groups.minCap,
        industryCount: groups.industries.length, themeCount: groups.themes.length,
        stockCount: Object.keys(groups.names).length,
      },
      industries: groups.industries, themes: groups.themes,
      names: groups.names, caps: groups.caps,
    }, null, 0) + "\n",
  );

  console.log("\n=== 완료 ===");
  console.log(`  ETF: ${meta.etfCount}, 종목: ${meta.stockCount}`);
  console.log(`  기간 수익률: ${meta.returnCount}종`);
  console.log(`  KRX 공지: ${meta.noticeCount}건`);
  console.log(`  테마 카드: ${meta.themeCardCount}, 테마 종목: ${meta.themeStockCount}`);
  console.log(`  성공: ${okCount}, 실패: ${failCount}`);
  console.log("  파일: data/etf-list.json, data/etf-index.json, data/etf-compositions.json, data/etf-returns.json,");
  console.log(`  업종·테마 분류: 업종 ${groups.industries.length} · 테마 ${groups.themes.length}`);
  console.log("        data/krx-notices.json, data/theme-cards.json, data/group-members.json");
}

main().catch((e) => {
  console.error("[FATAL]", e);
  process.exit(1);
});
