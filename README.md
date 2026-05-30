# portfolio-etf-index

한국 ETF 구성종목 역색인 — 매일 자동 빌드, JSON 공개.

`portfolio-web` 본 앱의 종속 데이터 서비스로,
"이 종목이 포함된 ETF" 검색을 위한 정적 인덱스를 제공합니다.

## 데이터 소스

- **ETF 목록**: 네이버 금융 `finance.naver.com/api/sise/etfItemList.nhn` (EUC-KR)
- **구성종목**: 토스 `wts-info-api.tossinvest.com/api/v2/stock-infos/A{code}/compositions`

매일 06:00 KST(=21:00 UTC) GitHub Actions cron으로 크롤·갱신.

## 출력 파일 (`data/`)

| 파일 | 용도 | 형태 |
|---|---|---|
| `etf-list.json` | ETF 메타(코드→이름) | `{ "069500": { "name": "KODEX 200" }, ... }` |
| `etf-index.json` | 역색인(종목→ETF) | `{ "005930": [["069500", 32.27], ...], ... }` |
| `etf-compositions.json` | 정방향(ETF→구성종목) | `{ "069500": [["005930","삼성전자",32.27], ...], ... }` |

모두 `meta: { version, builtAt, etfCount, stockCount }` 포함.

## API URL (raw.githubusercontent.com — CDN)

```
https://raw.githubusercontent.com/hanjungwoo3/portfolio-etf-index/main/data/etf-index.json
https://raw.githubusercontent.com/hanjungwoo3/portfolio-etf-index/main/data/etf-list.json
https://raw.githubusercontent.com/hanjungwoo3/portfolio-etf-index/main/data/etf-compositions.json
```

CORS 없음(GitHub raw 는 `Access-Control-Allow-Origin: *`). 브라우저에서 직접 fetch 가능.

## 로컬 실행

```bash
node scripts/crawl.js
# 옵션
CONCURRENCY=8 node scripts/crawl.js          # 동시 fetch 수 (기본 6)
MAX_ETFS=10 node scripts/crawl.js            # 처음 N개만 (테스트용)
```

Node 20+ 필요. 외부 의존성 없음 (내장 fetch + TextDecoder).

## 라이선스

데이터 자체의 저작권은 원 출처(네이버/토스)에 있습니다.
스크립트와 가공물은 개인·비상업적 용도 가정.
