# ADR-028: DataSource テスト戦略

**Status:** ACCEPTED  
**Date:** 2026-04-02  
**Deciders:** 開発チーム  

---

## Context

受講生が動画再生画面初回アクセス時に「入室から2時間経過」で強制退室ダイアログが表示されるバグが発生した。根本原因は `toDate()` 関数がFirestoreから読み出したISO 8601文字列を処理できず、フォールスルーして `new Date()`（現在時刻）を返していたこと。

このバグは以下のテスト戦略の盲点により、本番環境まで検出されず：

1. **全テストが InMemoryDataSource を使用** → `toDate()` を経由しない
2. **Firestore固有の日時変換ロジックがユニットテストでカバーされていない**
3. **InMemory（インメモリ）と Firestore（実DB）の挙動差異が明示化されていない**

---

## Decision

DataSource層のテスト戦略を以下に統一する：

### 1. 契約テスト（Contract Test）

**目的:** InMemoryDataSource と FirestoreDataSource の振る舞いが同一であることを保証

**実装:**
```typescript
// services/api/src/__tests__/datasource-contract.test.ts

describe("DataSource Contract", () => {
  const dataSources = [
    new InMemoryDataSource({ readOnly: false }),
    // new FirestoreDataSource(db, "test-tenant") ← 本来はこちらも含めたい
  ];
  
  dataSources.forEach(ds => {
    describe(ds.constructor.name, () => {
      it("createLessonSession → readLessonSession で round-trip 一致", async () => {
        // 入力: エンティティA
        // → write → read
        // 出力: エンティティAと同値
      });
      
      it("日時フィールドの正確性", async () => {
        // entryAt, deadlineAt の相対差分が変わらないこと
      });
    });
  });
});
```

**対象コレクション:**
- lesson_sessions（entryAt, deadlineAt, exitAt）
- quiz_attempts（startedAt, submittedAt）
- video_analytics（系のタイムスタンプ）

### 2. 単機能ユニットテスト（Unit Test）

**目的:** 日時変換関数の正確性を保証

**実装:**
```typescript
// services/api/src/datasource/__tests__/toDate.test.ts

describe("toDate()", () => {
  it("ISO 8601文字列 → Date 変換", () => { /* ... */ });
  it("Date型そのまま返却", () => { /* ... */ });
  it("Firestore Timestamp → Date 変換", () => { /* ... */ });
  it("null/undefined → new Date() フォールバック", () => { /* ... */ });
  it("不正文字列 → Invalid Date", () => { /* ... */ });
});
```

### 3. 統合テスト（Integration Test）

**目的:** 変換後のエンティティが API レスポンスとして機能すること確認

**実装:**
```typescript
// services/api/src/__tests__/integration/lesson-session.test.ts

describe("LessonSession整合性", () => {
  it("toLessonSession: 過去のISO文字列 → deadlineAt - entryAt = 7200000ms", () => {
    const entryAt = "2024-01-01T09:00:00.000Z";
    const deadlineAt = "2024-01-01T11:00:00.000Z";
    const diff = new Date(deadlineAt) - new Date(entryAt);
    expect(diff).toBe(7200000);
  });
});
```

---

## Consequences

### Positive
- ✅ InMemory/Firestore 乖離によるバグが早期に検出される
- ✅ 日時変換ロジックが明示的にテストカバレッジに含まれる
- ✅ 他の変換関数（toLessonSession, toQuizAttempt等）への信頼性向上
- ✅ 将来のリファクタリング（例: dayjs導入）での検証が容易

### Negative
- ⚠️ テスト数が増加（現状+15-20テスト程度）
- ⚠️ 本番環境のFirestoreTestingを含む場合、CI/CDパイプラインが複雑化
- ⚠️ InMemoryの完全な互換性保証は困難（Firestoreの一部仕様を模擬しきれない）

### Mitigation
- **テスト数増加:** InMemoryの主要メソッド（CRUD）に限定してカバレッジ
- **本番テスト複雑化:** CI段階では InMemory で高速テスト、デプロイ前に手動QAで Firestore 検証
- **不完全な互換性:** ADR-028の目的は「高度な互換性」ではなく「変換バグの早期検出」に限定

---

## Implementation Status

### Phase 1（完了）
- [x] toDate() に ISO文字列チェック追加
- [x] toDate() ユニットテスト作成（9ケース）
- [x] handleForceExit() 副次バグ修正

### Phase 2（進行中）
- [x] toLessonSession 変換テスト（既存で十分）
- [x] toQuizAttempt() の toDate() 統合
- [ ] DataSource振る舞い差異テスト（後続）

### Phase 3（検討中）
- [ ] Firestoreテスト環境での本番デバッグ
- [ ] 既存データの健全性スキャン

---

## Related ADRs

- [ADR-020](./ADR-020-progress-denormalization.md): 進捗トラッキング設計（日時フィールド含む）
- [ADR-027](./ADR-027-lesson-session-attendance.md): 出席管理（entryAt/deadlineAt）

---

## References

- Firestore timestamp handling: https://firebase.google.com/docs/firestore/data-types#timestamp
- Testing strategies for data layers: https://martinfowler.com/articles/testing-strategies.html
