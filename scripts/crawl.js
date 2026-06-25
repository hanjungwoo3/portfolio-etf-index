// 한국 ETF 구성종목 크롤러
//   1. 네이버 finance API 로 전체 ETF 목록 (코드 + 이름) — EUC-KR 디코드.
//   2. 각 ETF 의 구성종목을 토스 v2 endpoint 로 fetch.
//   3. 역색인(stock → [{etfCode, ratio}]) + 정방향(etf → [{stockCode, name, ratio}]) 생성.
//   4. data/etf-list.json, data/etf-index.json, data/etf-compositions.json 으로 저장.
//
// 실행: node scripts/crawl.js
//   환경변수: CONCURRENCY(기본 6), MAX_ETFS(테스트용 제한, 기본 무제한)

import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.resolve(__dirname, "..", "data");

const NAVER_ETF_LIST = "https://finance.naver.com/api/sise/etfItemList.nhn?etfType=0";
const TOSS_COMPOSITIONS = (code) =>
  `https://wts-info-api.tossinvest.com/api/v2/stock-infos/A${code}/compositions`;

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

// ─── 1) 네이버 ETF 목록 ──────────────────────────────────────────
async function fetchEtfList() {
  const resp = await fetchWithTimeout(NAVER_ETF_LIST, {
    headers: {
      "User-Agent": UA,
      "Referer": "https://finance.naver.com/",
      "Accept-Language": "ko-KR,ko;q=0.9",
    },
  });
  if (!resp.ok) throw new Error(`Naver ETF list HTTP ${resp.status}`);
  const buf = await resp.arrayBuffer();
  // 네이버는 EUC-KR 로 한글 인코딩 → Node 20+ TextDecoder 지원
  const text = new TextDecoder("euc-kr").decode(buf);
  const json = JSON.parse(text);
  const items = json?.result?.etfItemList ?? [];
  // 코드 + 이름만 추출, 중복 제거
  const seen = new Set();
  const out = [];
  for (const it of items) {
    const code = String(it.itemcode ?? "").padStart(6, "0");
    const name = String(it.itemname ?? "").trim();
    if (!/^\d{6}$/.test(code) || !name) continue;
    if (seen.has(code)) continue;
    seen.add(code);
    out.push({ code, name });
  }
  return out;
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
  console.log("[1/3] 네이버 ETF 목록 fetch...");
  const list = await fetchEtfList();
  console.log(`  → ${list.length} 개 ETF`);

  const targets = list.slice(0, Math.min(list.length, MAX_ETFS));
  console.log(`[2/3] 토스 구성종목 fetch (동시 ${CONCURRENCY}, 대상 ${targets.length})...`);

  let okCount = 0, failCount = 0;
  const compositions = {};  // { etfCode: [{stockCode, name, ratio}, ...] }
  const startedAt = Date.now();

  await pmap(targets, async (etf, i) => {
    const items = await fetchCompositions(etf.code);
    if (items && items.length > 0) {
      compositions[etf.code] = items;
      okCount++;
    } else {
      failCount++;
    }
    if ((i + 1) % 50 === 0 || i + 1 === targets.length) {
      const elapsed = ((Date.now() - startedAt) / 1000).toFixed(1);
      console.log(`  ${i + 1}/${targets.length} (성공 ${okCount}, 실패 ${failCount}, ${elapsed}s)`);
    }
  }, CONCURRENCY);

  console.log("[3/3] 역색인·파일 저장...");

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

  console.log("\n=== 완료 ===");
  console.log(`  ETF: ${meta.etfCount}, 종목: ${meta.stockCount}`);
  console.log(`  성공: ${okCount}, 실패: ${failCount}`);
  console.log(`  파일: data/etf-list.json, data/etf-index.json, data/etf-compositions.json`);
}

main().catch((e) => {
  console.error("[FATAL]", e);
  process.exit(1);
});
