# ADR-038: URL path 不可視文字サニタイズ middleware の導入

- Status: **Accepted**
- Date: 2026-05-21
- Deciders: system-279, sanwaminamihonda@gmail.com
- 関連: Issue #456 (現場バグ起票), PR #457 (実装), ADR-005 (Firebase Auth), ADR-007 (マルチテナント Firestore パスベース), ADR-035 (本 ADR がフォーマット踏襲), Session 41 ハンドオフ

## Context

### 起点となった現場事象

2026-05-21、福の種 株式会社様③ (tenant `atali82i`) の受講生 2 名が、管理者から共有された受講者向けリンク (`https://web-*.run.app/atali82i/student`) からログインできず 404 となる事象が発生した。

調査の結果、URL 末尾に **U+FE0E (VARIATION SELECTOR-15)** が混入していた。Gemini 解析でも一致する見解が得られ、リポジトリ全 grep ではリテラルの不可視文字はゼロヒットで、コード生成由来ではなかった。原因は **macOS / iOS の入力履歴経由のクリップボード → メーラー / メモアプリへのペースト時に OS / IME が変異セレクタを付加** したものと判明。

### 既存の対応手段では救えない理由

1. **クライアント側 sanitize 単独では既に共有されてしまった壊れた URL を救えない**: 受講生 2 名は既に汚染 URL を受け取って LINE / メール経由で保存している。コピー元の修正は将来分しか守れない。
2. **404 ハンドラでの誘導は受講者体験を著しく劣化させる**: 受講前のドメインへの最初の接触で 404 を見せる時点で離脱率が上がる。

### 採用しなかった代替案

| 案 | 不採用理由 |
|---|---|
| Next.js routing の `[...slug]` catch-all で 404 内サニタイズ | catch-all は本来のルーティング (例: `[tenant]/student`) を壊す。route 単位の網羅も保守不能 |
| Cloud Run 前段の Load Balancer / Cloud Armor で WAF rule | 不可視文字を全許可 → 全拒否のフラグは存在しない。WAF ルール自前定義は範囲が広く誤検知の温床、運用負荷 (本田様 = decision-maker の Ops 領分外) |
| クライアント (CopyButton) で書き込み前 sanitize **のみ** | 既に共有された URL を救えない (上記 #1)。**併用は採用 = ADR の Decision §3 参照** |
| 404 ページから JS でリトライ | SEO / a11y / Cookie / Auth context を一部失う。リダイレクト判定が AI 駆動になる (脆い) |

### 設計上の本質的な難しさ

Next.js middleware に届く `req.nextUrl.pathname` は WHATWG URL 準拠で percent-encoded (`%E2%80%8B` 等)。素朴に `decodeURIComponent(pathname)` で全体 decode して strip → encode すると、**encoded path separator (`%2F`) が真の `/` に化けて別 route に redirect される不可逆変換**が起きる。Codex review (PR #457) で High 指摘済。segment 単位処理が必須となる。

## Decision

### 1. アーキテクチャ層: Next.js middleware (`web/middleware.ts`)

不可視文字サニタイズは **Next.js middleware (Edge / Node runtime ハンドラ前)** に配置する。理由:

- routing 解決前に介入できる唯一の同居レイヤー (404 ハンドラより前段)
- `matcher` で `/_next/static`, `/_next/image`, `/favicon.ico`, `/api(?:/|$)` を除外でき、Web 側 path のみに作用
- BE (`services/api`) は `/api/v2/:tenant/` で別ドメイン経路。BE の path には影響しない (api routing は Express 5 ルータ側で別途処理)

### 2. サニタイズ処理: segment 単位 decode → strip → re-encode

`web/lib/sanitize-path.ts` の `sanitizeEncodedPathnameForRedirect(pathname)` で:

1. `pathname.split("/")` で segment 分解
2. 各 segment を `decodeURIComponent` (失敗時は WARN ログを残し**元 segment を返す = 部分救済**)
3. `stripInvisibleChars(decoded)` で除去対象を空文字置換
4. 除去対象を含まない segment は元のまま (再 encode 形式の揺れ = `+` vs `%20` 等の差異を避ける)
5. 除去後の segment は `encodeURIComponent` で再 encode
6. `"/"` で join し、元と差分があれば `needsRedirect = true`

### 3. 二重ガード: middleware + CopyButton 両方で sanitize

PR #457 で CopyButton 側でも書き込み前 sanitize を実施 (二重ガード)。理由:

- middleware は**既に共有された URL** を救う恒久救済
- CopyButton 側 sanitize は**新規に共有される URL** が汚染されないことを保証 (上流 DOM 加工 / Clipboard 改変系拡張への防御)
- 両者は救済タイミングが異なり、片側だけでは穴が残る

### 4. リダイレクト方式: 308 Permanent Redirect

- 308 は POST / PUT の method 保持 (一般 308 仕様)。本 middleware の対象は受講者 GET 経路だが、将来 form POST 経路にも安全
- HTTP cache に乗りやすく、リダイレクト分の RTT を後続アクセスで省ける
- 301 ではなく 308 を選択: GET → POST の method 変換が起きないことを browser に明示

### 5. 除去対象 (合意済 9 範囲)

| 範囲 | 種別 | 採用理由 |
|---|---|---|
| `U+00AD` | soft hyphen | URL 内では常に不正 (改行ヒント) |
| `U+200B..U+200F` | zero-width / LRM / RLM | LRM / RLM は ASCII 域に混じると視覚的に同じ URL の作出が可能 |
| `U+202A..U+202E` | bidi control | RLO 攻撃 (見せかけ URL) |
| `U+2060..U+2064` | word joiner / invisible operators | URL 内では用途なし |
| `U+2066..U+206F` | bidi isolates / deprecated formatting | bidi 系の派生 |

> **Note**: `U+2065` は現在 Unicode で Unassigned のため除去対象外 (将来 Unicode が用途を割り当てた時点で本 ADR を改訂)。これが `U+2060..U+2064` と `U+2066..U+206F` を分割している意図。
| `U+FE00..U+FE0F` | **variation selectors 1-16** | **Issue #456 の U+FE0E**。CJK 異体字 selector の単独混入を除去 |
| `U+FEFF` | BOM / zero-width no-break space | URL 内では常に不正 |
| `U+E0000..U+E007F` | TAG characters | stego (steganography) 対策 |
| `U+E0100..U+E01EF` | variation selectors supplement | VS17-256 |

通常絵文字 (`U+1F300+`) / CJK / 改行・タブ・スペースは **対象外** (URL 内の意味ある文字)。

### 6. エラーハンドリング: 全体 try/catch + 部分救済

```typescript
export function middleware(req: NextRequest) {
  try {
    const { pathname } = req.nextUrl;
    const { needsRedirect, cleaned } = sanitizeEncodedPathnameForRedirect(pathname);
    if (!needsRedirect) return NextResponse.next();
    const url = req.nextUrl.clone();
    url.pathname = cleaned;
    return NextResponse.redirect(url, 308);
  } catch (err) {
    console.error("[middleware] sanitization failed, passing through", {
      errorName: err instanceof Error ? err.name : "unknown",
    });
    return NextResponse.next();
  }
}
```

- **middleware が throw すると Next.js は全 route に 500 を返す**ため、想定外例外で全画面ブラックアウトする最悪ケースを防ぐ
- segment 単位の `decodeURIComponent` 失敗は `URIError` (malformed percent sequence) として WARN ログ + 元 segment 返却で**部分救済**
- segment 本体は出力しない (PII / 攻撃 payload 拡散リスク)。`segmentLength` / `errorName` のみ
- グローバル CLAUDE.md `rules/error-handling.md` §1 「状態復旧 > ログ記録」原則に準拠 (sanitize 失敗は元 path に fall back することで route 解決を継続)

### 7. observability

- 不可視文字検出時の構造化ログは **追加しない**: middleware 層は高頻度実行のため全 normal request にログを出すとコストが嵩む。検出時のみ 308 redirect が Cloud Run access log に乗るので追跡可能 (原則 logs/0 access log 経由でモニタリング)
- 例外時のみ WARN / ERROR を残す (上記 §6)

## Consequences

### 良い影響

- 既に共有された壊れた URL (例: 福の種 株式会社様③ の受講生 2 名) を **再共有なしに救済**できる
- 不可視文字を悪用した攻撃ベクトル (RLO による見せかけ URL / stego) を path 層で構造的に遮断
- middleware 単位の単一責務で、追加除去対象 (`U+FE0E` 以外の VS / 将来発見される範囲) を `INVISIBLE_CHAR_PATTERN` の 1 箇所更新で拡張可能
- 同一処理を route 単位に分散させずに済む = 漏れの構造的回避

### 受容するトレードオフ

| トレードオフ | 受容理由 |
|---|---|
| 全 web request に 1 段の overhead (segment 分解 + regex test) | strip 不要 segment は **regex test ヒットなしで早期 return**、cost は O(path length)。Cloud Run の per-request 100ms 級と比較して無視可能 |
| ZWJ (U+200D) も除去対象に含む → 絵文字合字 (👨‍👩‍👧 等) を URL path に置くと破壊される | URL path は ASCII / percent-encode 前提で、絵文字合字を path に置く用途は想定外。test で固定 (将来意図変更時は ADR 改訂) |
| middleware は Edge runtime / Node runtime のどちらでも動く必要があるため、Buffer / Node 専用 API を使えない | `String.replace` + 正規表現のみで実装、`decodeURIComponent` / `encodeURIComponent` も両環境で動作確認済 |
| 不可視文字を含むテナント ID / コース slug を将来導入できない | 多言語 slug 対応 (Vietnamese tones の VS / Indic 言語の VS) が必要になった時点で ADR 改訂。現状は ASCII tenant ID + 日本語 lesson title (本文のみ) 運用 |

### 既存設計との関係

- **ADR-005 (Firebase Auth)**: 認証層には影響しない。middleware は path 正規化のみで auth header / cookie に触らない
- **ADR-007 (マルチテナント Firestore パスベース)**: tenant ID は ASCII 前提なので middleware 通過後の path は変化なし
- **ADR-010 (エラーレスポンス)**: middleware は **308 redirect または `NextResponse.next()` のみを返す**。next() 後に後続 route が 4xx を返す場合は ADR-010 のフラット形式 `{ error, message }` が適用される (middleware は通過するだけ)。middleware 自体はエラー JSON を返さないため ADR-010 の責務外
- **ADR-025 (セキュリティ強化 / Helmet, レート制限, CORS)**: 補完関係。Helmet header は middleware 後段で付与 (Next.js 標準経路に乗る)。レート制限は Cloud Run / API 層で実施されるため middleware では実装しない

### 検証 / テスト

- `web/__tests__/middleware.test.ts` (9 ケース): クリーン path 通過 / U+FE0E redirect / U+200B redirect / ルート path / `%2F` 保全 / 不正 percent sequence 救済 / catch-all (例外時 next) 他
- `web/lib/__tests__/sanitize-path.test.ts` (47 ケース): 9 範囲の除去確認 / 絵文字保持 / 日本語保持 / segment 単位処理 / 不正 percent sequence 部分救済 / 境界値 (空文字 / ルート / 末尾 slash) 他
- vitest 全 PASS (Session 41 末: 108 → 161 件、本 ADR 関連実装で +56 件追加)

## Notes

- 本 ADR は **Session 41 (2026-05-21)** で実装が main にマージ済 (PR #457) の後追い記録
- PR description / commit message / JSDoc には既に詳細記載済だが、新規アーキテクチャ層 (Next.js middleware) の導入であり、後続変更時に「なぜ全体 decode ではなく segment 単位なのか」「なぜ ZWJ も含むのか」を追跡可能とするため明文化
- 将来追加候補:
  - 多言語 slug 対応時の除去範囲再評価 (上記トレードオフ表)
  - middleware で WARN 多発時のサンプリングログ追加 (Cloud Logging cost 制御)
