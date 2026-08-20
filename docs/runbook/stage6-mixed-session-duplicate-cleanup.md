# Stage 6 Phase B: mixed_synthetic_real 重複行の手動対応手順（ADR-040）

`scripts/audit-duplicate-synthetic-sessions.ts`（Stage 6 Phase A）の実測（2026-08-20、全テナント横断）で、
対応が必要な safe な `mixed_synthetic_real`（real+synthetic 混在候補）グループは **atali82i テナントの 2 件のみ**
と判明した。本監査スクリプトは PII 制限（userId / doc id 非出力）のため対象ドキュメントを特定できず、
super-admin が個別に特定・対応する必要がある（ADR-040 Stage 6 Phase B 決定1）。

本手順はその「対象の特定」と「安全な対応の選択肢」を示す。**実際にどう直すか（削除するか、フィールド補正で残すか）
は本手順のStep 3で開発者が判断すること**（本手順はその判断材料を揃えるのみで、判断そのものは代行しない）。

## 前提

- 対象: テナント `atali82i` の `lesson_sessions` コレクション、`mixed_synthetic_real` バケットの safe（`original`/`editedAt` 未設定）グループ 2 件
- 本番 Firestore への認証情報（`GOOGLE_APPLICATION_CREDENTIALS`）取得済み
- 本番 Firestore に PITR または定期エクスポートが設定済みであること（`rules/production-data-safety.md` §2）。未確認なら GCP コンソール > Firestore > バックアップと復元 で確認してから進める
- 実行者は開発者本人（super-admin 権限保持者）。本手順で使うスクリプトは userId / doc id を出力するため、**コミットしない使い捨てスクリプト**として扱う

## Step 1: 対象グループの特定（一時スクリプト、コミット禁止）

`scripts/audit-duplicate-synthetic-sessions.ts` の分類ロジック（`classifyKind` / `groupByUserLesson` / `classifyGroup`）を
再利用し、tenant を `atali82i` に固定した上で `mixed_synthetic_real` かつ safe（`isProtected === false`）のグループのみ
userId / lessonId / doc 一覧を出力する。以下をリポジトリ外の一時ファイル（例: `/tmp/find-atali82i-mixed.ts`）に保存して実行する。

```typescript
#!/usr/bin/env npx tsx
// 使い捨てスクリプト。userId/docId を出力するためコミットしないこと。
import { FieldPath } from "firebase-admin/firestore";
import { initFirestoreForCli } from "../lms-279/scripts/lib/init-firebase-admin.js";
import {
  classifyKind,
  groupByUserLesson,
  classifyGroup,
  mapRawDocToSessionDoc,
} from "../lms-279/scripts/audit-duplicate-synthetic-sessions.js";

const db = initFirestoreForCli();
const coll = db.collection("tenants/atali82i/lesson_sessions");

const allDocs = [];
let afterDocId: string | null = null;
for (;;) {
  let q = coll.orderBy(FieldPath.documentId()).limit(1000);
  if (afterDocId) q = q.startAfter(afterDocId);
  const snap = await q.get();
  if (snap.empty) break;
  for (const d of snap.docs) allDocs.push(mapRawDocToSessionDoc(d.id, d.data()));
  if (snap.docs.length < 1000) break;
  afterDocId = snap.docs[snap.docs.length - 1].id;
}

const { groups } = groupByUserLesson(allDocs);
for (const g of groups) {
  const c = classifyGroup(g);
  if (c.bucket !== "mixed_synthetic_real" || c.isProtected) continue;
  console.log(`userId=${g.userId} lessonId=${g.lessonId}`);
  for (const m of g.members) {
    console.log(
      `  docId=${m.docId} kind=${classifyKind(m.docId)} status=${m.status} exitReason=${m.exitReason} entryAt=${m.entryAt} exitAt=${m.exitAt} quizAttemptId=${m.quizAttemptId}`
    );
  }
}
```

```bash
GOOGLE_APPLICATION_CREDENTIALS=/path/to/key.json \
  GOOGLE_CLOUD_PROJECT=lms-279 \
  npx tsx /tmp/find-atali82i-mixed.ts
```

期待される出力は 2 グループ（各グループ 2 件以上の `lesson_sessions` doc）。3 件以上ヒットした場合は
Phase A 実測時点（2026-08-20）からデータが変化している可能性があるため、対応を進める前に
`scripts/audit-duplicate-synthetic-sessions.ts --tenant-id=atali82i` を再実行し件数が一致するか確認すること
（監査スクリプトのコメント「Phase B 着手直前には必ず再監査すること」参照）。

## Step 2: 各行の判定材料

| doc id の形式 | 種別 | 意味 |
|---|---|---|
| `synthetic_skip_{userId}_{lessonId}` | synthetic_skip | テスト任意化スキップによる合成セッション（ADR-040 決定5） |
| `synthetic_{attemptId}` | synthetic_pass | ケースD後方互換による合成セッション（ADR-027） |
| それ以外 | real | 実際の入退室セッション |

`mixed_synthetic_real` は上記のうち real と synthetic が同一グループに混在しているケース。
`entryAt`/`exitAt`/`quizAttemptId` を突き合わせ、どちらが「実際に起きた出席」でどちらが
「後から補完的に生成された合成データ」かを目視判定する。

## Step 3: 対応方針の決定（開発者判断）

アプリ側に `lesson_sessions` を削除する管理APIは存在しない（`services/api/src/routes/super-admin.ts` には
`GET /tenants/:tenantId/attendance-report` と `PATCH /tenants/:tenantId/attendance-report/:sessionId` のみで、
DELETE相当のエンドポイントはない）。選択肢は以下の2つ:

1. **既存の出席レポート編集UI（`PATCH .../attendance-report/:sessionId`）でフィールド補正**: doc は残るが、
   表示上誤りのある値（`quizScore`/`quizPassed`/`exitReason`等）を訂正する。この操作で自動的に
   `original`（初回編集時のみ）+`editedAt` が付与され、次回監査から `protected` として扱われる
   （既存 16 件の protected グループもこの経路で対応済みと推測される）。doc 自体は消えないため、
   レポート上の「余剰行」自体は解消しない。
2. **Firestore コンソールで該当 doc を直接削除**: 余剰行そのものを除去できるが、アプリの管理APIを経由しない
   直接操作のため、実施前に Step 1 で出力した doc 一覧と Phase A の実測結果（グループ数2件）を必ず突き合わせ、
   PITR/エクスポートで復旧経路が確保されていることを確認してから行うこと。どちらの行を残すか
   （real / synthetic のどちらが正）は Step 2 の判定材料をもとに開発者が個別に判断する。

## Step 4: 実施後の検証

```bash
GOOGLE_APPLICATION_CREDENTIALS=/path/to/key.json \
  GOOGLE_CLOUD_PROJECT=lms-279 \
  npx tsx scripts/audit-duplicate-synthetic-sessions.ts --tenant-id=atali82i
```

`real+synthetic 混在候補` の `safe` が 0 件になっていることを確認する。`protected` 件数が想定通り増えている
（Step 3 で選択肢1を使った場合）か、`groupCount` 自体が減っている（選択肢2で削除した場合）かで、
どちらの対応を行ったか事後確認できる。

## 参考

- ADR-040: 本対応のスコープと Phase A/B 決定の全文
- `scripts/audit-duplicate-synthetic-sessions.ts`: 分類ロジック本体（read-only、PII非出力）
- `services/api/src/routes/super-admin.ts:968-1234`: 出席レポート取得・編集API（削除APIなし）
- `rules/production-data-safety.md`: 本番Firestore書き込み前のバックアップ確認
