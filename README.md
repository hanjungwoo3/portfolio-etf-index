# portfolio-etf-index

한국 ETF 구성종목 역색인 + 테마 카드 — 매일 자동 빌드, JSON 공개.

`portfolio-web` 본 앱의 종속 데이터 서비스로,
"이 종목이 포함된 ETF" 검색용 정적 인덱스와,
지수 탭 '섹터 흐름' 용 테마별 종목 바스켓을 제공합니다.

## 데이터 소스

- **ETF 목록**: 네이버 금융 `finance.naver.com/api/sise/etfItemList.nhn` (EUC-KR)
  - ⚠️ 종목코드는 **영숫자 6자리**다(`0167A0`). 숫자로 좁히면 2024년 이후 상장분이 통째로 빠진다
- **구성종목**: 토스 `wts-info-api.tossinvest.com/api/v2/stock-infos/A{code}/compositions`
  - 상위 10 + "그 외" 만 온다. 전종목이 아니다
- **테마**: 네이버 `finance.naver.com/sise/theme.naver` (266개, 7쪽) + 테마별 종목
- **시가총액**: 네이버 `m.stock.naver.com/api/stocks/marketValue/{KOSPI|KOSDAQ}` (100종/쪽)

매일 06:00 KST(=21:00 UTC) GitHub Actions cron으로 크롤·갱신.

## 출력 파일 (`data/`)

| 파일 | 용도 | 형태 |
|---|---|---|
| `etf-list.json` | ETF 메타(코드→이름) | `{ "069500": { "name": "KODEX 200" }, ... }` |
| `etf-index.json` | 역색인(종목→ETF) | `{ "005930": [["069500", 32.27], ...], ... }` |
| `etf-compositions.json` | 정방향(ETF→구성종목) | `{ "069500": [["005930","삼성전자",32.27], ...], ... }` |
| `theme-cards.json` | 테마 카드(지수 탭 섹터 흐름) | 아래 참조 |

모두 `meta: { version, builtAt, etfCount, stockCount, themeCardCount, themeStockCount, themeMinCap }` 포함.

### `theme-cards.json`

```jsonc
{
  "cards": { "반도체 소부장": ["005930", "042700", ...], ... },   // 카드 → 종목코드
  "names": { "042700": "한미반도체", ... },                       // 종목코드 → 이름
  "caps":  { "042700": 78000, ... }                              // 종목코드 → 시총(억원)
}
```

카드 정의는 `scripts/theme-cards.js` 에 있다. 네이버 테마 여러 개를 하나로 묶는다
(예: `반도체 소부장` = 반도체 장비 + 반도체 재료/부품 + 반도체 기판 + 유리 기판).

- **ETF 가 아니라 종목 바스켓**이다. ETF 로 섹터를 보면 상품이 있는 테마만 보이고
  (광통신·CPO 는 ETF 가 없다), 채권·미국 ETF 처럼 시장 흐름과 무관한 칸이 자리를 차지한다.
- **시총 하한**(`meta.themeMinCap`, 현재 5,000억) 미만은 제외한다. 테마 종목의 절반이
  1,300억 미만이라 안 거르면 잡주 몇 개가 중앙값을 흔든다. 1,835 → 419종으로 줄어
  프론트 시세 조회도 10콜 → 3콜이 된다.
- **카드끼리 종목이 겹치는 건 정상**이다. 삼성SDI 는 2차전지에도 전기차에도 있다.
  "오늘 어느 테마가 강세인가" 를 보는 화면이라 중복 배제가 오히려 카드를 갉아먹는다.

## API URL (raw.githubusercontent.com — CDN)

```
https://raw.githubusercontent.com/hanjungwoo3/portfolio-etf-index/main/data/etf-index.json
https://raw.githubusercontent.com/hanjungwoo3/portfolio-etf-index/main/data/etf-list.json
https://raw.githubusercontent.com/hanjungwoo3/portfolio-etf-index/main/data/etf-compositions.json
https://raw.githubusercontent.com/hanjungwoo3/portfolio-etf-index/main/data/theme-cards.json
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
