#!/usr/bin/env npx tsx
/**
 * `scripts/audit-duplicate-synthetic-sessions.ts` の smoke test。
 *
 * 実行方法:
 *   npx tsx scripts/__tests__/audit-duplicate-synthetic-sessions.smoke.ts
 */

import assert from "node:assert/strict";
import { Timestamp } from "firebase-admin/firestore";
import {
  classifyKind,
  hasKindFlagMismatch,
  extractAttemptIdFromSyntheticPassDocId,
  normalizeTimestamp,
  jstDateOf,
  intervalsOverlap,
  mapRawDocToSessionDoc,
  groupByUserLesson,
  classifyGroup,
  scanTenantLessonSessions,
  aggregateTenant,
  mergeSummaries,
  printTenantSummary,
  printGrandTotal,
  type RawSessionDoc,
  type PageFetcher,
  type ScanMeta,
} from "../audit-duplicate-synthetic-sessions.ts";

// scanTenantLessonSessions のテストが async のため、ファイル全体を async 関数で包む
// （tsx の cjs transform はトップレベル await 非対応のため）。
async function main(): Promise<void> {

// ============================================================
// classifyKind: prefix ordering（skip を pass より先に判定）
// ============================================================
{
  assert.equal(classifyKind("synthetic_skip_user1_lesson1"), "synthetic_skip");
  assert.equal(classifyKind("synthetic_attempt123"), "synthetic_pass");
  assert.equal(classifyKind("aBcDeFgH12345"), "real"); // Firestore 自動採番の実session doc id想定
  // "synthetic_skip_" prefix を "synthetic_" 判定に食われないこと
  assert.equal(classifyKind("synthetic_skipper"), "synthetic_pass"); // "synthetic_skip_" と一致しない
}

// ============================================================
// hasKindFlagMismatch
// ============================================================
{
  assert.equal(hasKindFlagMismatch("synthetic_pass", true), false);
  assert.equal(hasKindFlagMismatch("synthetic_pass", false), true); // synthetic なのに flag=false
  assert.equal(hasKindFlagMismatch("real", true), true); // real なのに flag=true
  assert.equal(hasKindFlagMismatch("real", false), false);
  assert.equal(hasKindFlagMismatch("real", null), false); // 欠落は不一致扱いしない
}

// ============================================================
// extractAttemptIdFromSyntheticPassDocId
// ============================================================
{
  assert.equal(extractAttemptIdFromSyntheticPassDocId("synthetic_attempt123"), "attempt123");
  assert.equal(extractAttemptIdFromSyntheticPassDocId("synthetic_skip_u1_l1"), null);
  assert.equal(extractAttemptIdFromSyntheticPassDocId("realDocId123"), null);
  assert.equal(extractAttemptIdFromSyntheticPassDocId("synthetic_"), null); // attemptId 空
}

// ============================================================
// normalizeTimestamp: 4状態
// ============================================================
{
  const ts = Timestamp.fromDate(new Date("2026-08-20T00:00:00.000Z"));
  assert.deepEqual(normalizeTimestamp(ts), { iso: "2026-08-20T00:00:00.000Z", kind: "timestamp" });
  assert.deepEqual(normalizeTimestamp("2026-08-20T00:00:00.000Z"), {
    iso: "2026-08-20T00:00:00.000Z",
    kind: "string",
  });
  assert.deepEqual(normalizeTimestamp(null), { iso: null, kind: "missing" });
  assert.deepEqual(normalizeTimestamp(undefined), { iso: null, kind: "missing" });
  assert.deepEqual(normalizeTimestamp("not-a-date"), { iso: null, kind: "malformed" });
  assert.deepEqual(normalizeTimestamp(12345), { iso: null, kind: "malformed" });
}

// ============================================================
// jstDateOf: UTC 14:59:59.999Z / 15:00:00.000Z 境界
// ============================================================
{
  assert.equal(jstDateOf("2026-08-19T14:59:59.999Z"), "2026-08-19"); // JST 23:59:59.999 同日
  assert.equal(jstDateOf("2026-08-19T15:00:00.000Z"), "2026-08-20"); // JST 00:00:00.000 翌日
}

// ============================================================
// intervalsOverlap
// ============================================================
{
  const a = { entryAt: "2026-08-20T00:00:00.000Z", exitAt: "2026-08-20T01:00:00.000Z" };
  const disjoint = { entryAt: "2026-08-20T02:00:00.000Z", exitAt: "2026-08-20T03:00:00.000Z" };
  const touching = { entryAt: "2026-08-20T01:00:00.000Z", exitAt: "2026-08-20T02:00:00.000Z" };
  const nested = { entryAt: "2026-08-20T00:15:00.000Z", exitAt: "2026-08-20T00:45:00.000Z" };
  const openEnded = { entryAt: "2026-08-20T00:30:00.000Z", exitAt: null };
  const missingEntry = { entryAt: null, exitAt: "2026-08-20T00:30:00.000Z" };

  assert.equal(intervalsOverlap(a, disjoint), false);
  assert.equal(intervalsOverlap(a, touching), true); // 端点一致は重なり扱い（<=）
  assert.equal(intervalsOverlap(a, nested), true);
  assert.equal(intervalsOverlap(a, openEnded), true); // 開区間は a と重なる
  assert.equal(intervalsOverlap(a, missingEntry), false); // entryAt 欠落は比較不能
}

// ============================================================
// mapRawDocToSessionDoc: original/editedAt はフィールド存在で判定（truthy ではない）
// ============================================================
{
  const withNullOriginal = mapRawDocToSessionDoc("doc1", {
    userId: "u1",
    lessonId: "l1",
    original: null, // 値は null でも「フィールドとして存在する」= protected
  });
  assert.equal(withNullOriginal.hasOriginal, true);

  const withoutOriginal = mapRawDocToSessionDoc("doc2", { userId: "u1", lessonId: "l1" });
  assert.equal(withoutOriginal.hasOriginal, false);
  assert.equal(withoutOriginal.hasEditedAt, false);

  const nonStringUserId = mapRawDocToSessionDoc("doc3", { userId: 12345, lessonId: "l1" });
  assert.equal(nonStringUserId.userId, null); // 非 string は null 正規化
}

// ============================================================
// groupByUserLesson: 不正データ除外 + カウント、singleton除外、キー非衝突
// ============================================================
{
  const doc = (docId: string, userId: string | null, lessonId: string | null): RawSessionDoc => ({
    docId,
    userId,
    lessonId,
    status: null,
    exitReason: null,
    entryAt: null,
    exitAt: null,
    quizAttemptId: null,
    isSyntheticFlag: null,
    hasOriginal: false,
    hasEditedAt: false,
  });

  const result = groupByUserLesson([
    doc("d1", "u1", "l1"),
    doc("d2", "u1", "l1"), // u1/l1 グループ（size2）
    doc("d3", "u2", "l1"), // singleton → グループに含まれない
    doc("d4", null, "l1"), // userId欠落 → 除外+カウント
    doc("d5", "u1", null), // lessonId欠落 → 除外+カウント
  ]);

  assert.equal(result.missingUserId, 1);
  assert.equal(result.missingLessonId, 1);
  assert.equal(result.groups.length, 1);
  assert.equal(result.groups[0].userId, "u1");
  assert.equal(result.groups[0].lessonId, "l1");
  assert.equal(result.groups[0].members.length, 2);
}

// ============================================================
// groupByUserLesson: キー衝突耐性（codex review指摘: 単純な区切り文字連結は
// userId/lessonId 自体に区切り文字が含まれると異なる組み合わせが同一キーに衝突しうる）
// ============================================================
{
  const doc = (docId: string, userId: string, lessonId: string): RawSessionDoc => ({
    docId,
    userId,
    lessonId,
    status: null,
    exitReason: null,
    entryAt: null,
    exitAt: null,
    quizAttemptId: null,
    isSyntheticFlag: null,
    hasOriginal: false,
    hasEditedAt: false,
  });

  // 単純な "," 連結なら userId="a,b"/lessonId="c" と userId="a"/lessonId="b,c" が
  // 同一キー "a,b,c" に衝突する。JSON.stringify([userId, lessonId]) はエスケープにより
  // 衝突しないことを確認する。
  const result = groupByUserLesson([
    doc("d1", "a,b", "c"),
    doc("d2", "a,b", "c"), // 同一ペア → グループ化される
    doc("d3", "a", "b,c"), // 別ペアだが単純連結なら同一キーになりうる
    doc("d4", "a", "b,c"),
  ]);

  assert.equal(result.groups.length, 2, "異なる (userId, lessonId) ペアは別グループのままであるべき");
  const pairs = result.groups.map((g) => `${g.userId}|${g.lessonId}`).sort();
  assert.deepEqual(pairs, ["a,b|c", "a|b,c"].sort());
}

// ============================================================
// classifyGroup: バケット排他性 + protected + sameAttemptSignal + skipMultiAnomaly
// ============================================================
{
  const base = {
    status: null,
    exitReason: null,
    entryAt: null,
    exitAt: null,
    isSyntheticFlag: null,
    hasOriginal: false,
    hasEditedAt: false,
  };

  // mixed: real + synthetic_pass 1件（synthetic_pass単独では2件未満だが mixed が最優先）
  {
    const c = classifyGroup({
      userId: "u1",
      lessonId: "l1",
      members: [
        { ...base, docId: "realDoc1", userId: "u1", lessonId: "l1", quizAttemptId: "attempt1" },
        { ...base, docId: "synthetic_attempt1", userId: "u1", lessonId: "l1", quizAttemptId: "attempt1" },
      ],
    });
    assert.equal(c.bucket, "mixed_synthetic_real");
    assert.equal(c.sameAttemptSignal, true); // real の quizAttemptId が synthetic_pass の doc id と一致
  }

  // synthetic_pass_multi: synthetic_pass のみ2件
  {
    const c = classifyGroup({
      userId: "u1",
      lessonId: "l1",
      members: [
        { ...base, docId: "synthetic_attemptA", userId: "u1", lessonId: "l1", quizAttemptId: "attemptA" },
        { ...base, docId: "synthetic_attemptB", userId: "u1", lessonId: "l1", quizAttemptId: "attemptB" },
      ],
    });
    assert.equal(c.bucket, "synthetic_pass_multi");
    assert.equal(c.syntheticPassCount, 2);
  }

  // synthetic_skip_multi: 構造的に異常。ここでは検証用に人為的に2件のskip docを与える
  {
    const c = classifyGroup({
      userId: "u1",
      lessonId: "l1",
      members: [
        { ...base, docId: "synthetic_skip_u1_l1", userId: "u1", lessonId: "l1", quizAttemptId: null },
        { ...base, docId: "synthetic_skip_u1_l1_dup", userId: "u1", lessonId: "l1", quizAttemptId: null },
      ],
    });
    assert.equal(c.bucket, "synthetic_skip_multi");
    assert.equal(c.hasSkipMultiAnomaly, true);
  }

  // real_only_multi
  {
    const c = classifyGroup({
      userId: "u1",
      lessonId: "l1",
      members: [
        { ...base, docId: "realDoc1", userId: "u1", lessonId: "l1", quizAttemptId: null },
        { ...base, docId: "realDoc2", userId: "u1", lessonId: "l1", quizAttemptId: null },
      ],
    });
    assert.equal(c.bucket, "real_only_multi");
    assert.equal(c.hasSkipMultiAnomaly, false);
  }

  // codex review指摘の回帰テスト: skip 1件 + pass 1件（real 0件）は
  // real_only_multi に誤分類されてはならない（QUIZ_REQUIRE_ACTIVE_SESSION=false 時に
  // skip 後さらに無セッションで合格提出した場合に実在しうる組み合わせ）
  {
    const c = classifyGroup({
      userId: "u1",
      lessonId: "l1",
      members: [
        { ...base, docId: "synthetic_skip_u1_l1", userId: "u1", lessonId: "l1", quizAttemptId: null },
        { ...base, docId: "synthetic_attemptA", userId: "u1", lessonId: "l1", quizAttemptId: "attemptA" },
      ],
    });
    assert.notEqual(c.bucket, "real_only_multi");
    assert.equal(c.bucket, "synthetic_pass_multi");
    assert.equal(c.realCount, 0);
  }

  // protected: hasOriginal のみ / hasEditedAt のみ / 両方
  {
    const cOriginalOnly = classifyGroup({
      userId: "u1",
      lessonId: "l1",
      members: [
        { ...base, docId: "realDoc1", userId: "u1", lessonId: "l1", quizAttemptId: null, hasOriginal: true },
        { ...base, docId: "realDoc2", userId: "u1", lessonId: "l1", quizAttemptId: null },
      ],
    });
    assert.equal(cOriginalOnly.isProtected, true);

    const cEditedAtOnly = classifyGroup({
      userId: "u1",
      lessonId: "l1",
      members: [
        { ...base, docId: "realDoc1", userId: "u1", lessonId: "l1", quizAttemptId: null, hasEditedAt: true },
        { ...base, docId: "realDoc2", userId: "u1", lessonId: "l1", quizAttemptId: null },
      ],
    });
    assert.equal(cEditedAtOnly.isProtected, true);

    const cNeither = classifyGroup({
      userId: "u1",
      lessonId: "l1",
      members: [
        { ...base, docId: "realDoc1", userId: "u1", lessonId: "l1", quizAttemptId: null },
        { ...base, docId: "realDoc2", userId: "u1", lessonId: "l1", quizAttemptId: null },
      ],
    });
    assert.equal(cNeither.isProtected, false);
  }

  // mixed グループ内で skip が2件以上 → 主バケットは mixed のままだが異常シグナルは握りつぶさない
  {
    const c = classifyGroup({
      userId: "u1",
      lessonId: "l1",
      members: [
        { ...base, docId: "realDoc1", userId: "u1", lessonId: "l1", quizAttemptId: null },
        { ...base, docId: "synthetic_skip_u1_l1", userId: "u1", lessonId: "l1", quizAttemptId: null },
        { ...base, docId: "synthetic_skip_u1_l1_dup", userId: "u1", lessonId: "l1", quizAttemptId: null },
      ],
    });
    assert.equal(c.bucket, "mixed_synthetic_real");
    assert.equal(c.hasSkipMultiAnomaly, true); // mixedでも異常シグナルは立つ
  }
}

// ============================================================
// scanTenantLessonSessions: ページング・カーソル前進・上限打ち切り
// ============================================================
{
  // --- 2つの満杯ページ(size==pageSize) + 空ページで終了、カーソルが正しく前進すること ---
  {
    const pages = [
      { docs: [{ id: "a1", data: { userId: "u1", lessonId: "l1" } }, { id: "a2", data: { userId: "u1", lessonId: "l1" } }] },
      { docs: [{ id: "a3", data: { userId: "u2", lessonId: "l2" } }, { id: "a4", data: { userId: "u2", lessonId: "l2" } }] },
    ];
    const calls: Array<string | null> = [];
    const fetcher: PageFetcher = {
      async fetchPage(afterDocId) {
        calls.push(afterDocId);
        if (calls.length === 1) return pages[0];
        if (calls.length === 2) return pages[1];
        return { docs: [] }; // 3回目で空ページを返し終了（満杯ページが続く限り空ページ確認が必要）
      },
    };
    const result = await scanTenantLessonSessions(fetcher, 20000, 2);
    assert.deepEqual(calls, [null, "a2", "a4"]); // カーソルが前ページ最終docIdへ前進し、空ページで終了
    assert.equal(result.docsRead, 4);
    assert.equal(result.pageCount, 3);
    assert.equal(result.hitDocCap, false);
  }

  // --- pageSize より少ないページで最終ページと判定（空ページ待ちしない） ---
  {
    const fetcher: PageFetcher = {
      async fetchPage() {
        return { docs: [{ id: "only1", data: { userId: "u1", lessonId: "l1" } }] };
      },
    };
    const result = await scanTenantLessonSessions(fetcher, 20000, 10);
    assert.equal(result.pageCount, 1);
    assert.equal(result.docsRead, 1);
  }

  // --- max-docs-per-tenant 到達で打ち切り ---
  {
    const fetcher: PageFetcher = {
      async fetchPage(afterDocId) {
        // 常に pageSize=2 件返す無限ページ（cap で止まらなければ無限ループする）
        const base = afterDocId ? Number(afterDocId) : 0;
        return {
          docs: [
            { id: String(base + 1), data: { userId: "u1", lessonId: "l1" } },
            { id: String(base + 2), data: { userId: "u1", lessonId: "l1" } },
          ],
        };
      },
    };
    const result = await scanTenantLessonSessions(fetcher, 5, 2);
    assert.equal(result.hitDocCap, true);
    assert.equal(result.docsRead, 5); // 上限ちょうどで打ち切り
  }
}

// ============================================================
// aggregateTenant + mergeSummaries: INVALID_FOR_PHASE_B
// ============================================================
{
  const scanMetaOk: ScanMeta = {
    startedAt: "2026-08-20T00:00:00.000Z",
    finishedAt: "2026-08-20T00:00:01.000Z",
    pageCount: 1,
    docsRead: 0,
    hitDocCap: false,
  };
  const scanMetaCapped: ScanMeta = { ...scanMetaOk, hitDocCap: true };

  const summaryOk = aggregateTenant("tenantA", [], scanMetaOk, 0, 0, 20);
  const summaryCapped = aggregateTenant("tenantB", [], scanMetaCapped, 0, 0, 20);

  const grandOk = mergeSummaries([summaryOk]);
  assert.equal(grandOk.invalidForPhaseB, false);
  assert.equal(grandOk.capHitTenantCount, 0);

  const grandInvalid = mergeSummaries([summaryOk, summaryCapped]);
  assert.equal(grandInvalid.invalidForPhaseB, true);
  assert.equal(grandInvalid.capHitTenantCount, 1);
}

// ============================================================
// printTenantSummary / printGrandTotal: PII 非出力の検証
// (userId は TenantDuplicateSummary/GrandTotal の型に存在しないため構造的に出力不可能だが、
//  実際の出力全体を捕捉して念のため userId 文字列が含まれないことも確認する)
// ============================================================
{
  const PII_USER_ID = "sensitive-user-id-should-never-appear";
  const doc = (docId: string): RawSessionDoc => ({
    docId,
    userId: PII_USER_ID,
    lessonId: "lesson-x",
    status: null,
    exitReason: null,
    entryAt: "2026-08-20T00:00:00.000Z",
    exitAt: "2026-08-20T01:00:00.000Z",
    quizAttemptId: null,
    isSyntheticFlag: null,
    hasOriginal: false,
    hasEditedAt: false,
  });

  const scanMeta: ScanMeta = {
    startedAt: "2026-08-20T00:00:00.000Z",
    finishedAt: "2026-08-20T00:00:01.000Z",
    pageCount: 1,
    docsRead: 2,
    hitDocCap: false,
  };
  const summary = aggregateTenant("tenantC", [doc("real1"), doc("real2")], scanMeta, 0, 0, 20);
  const grandTotal = mergeSummaries([summary]);

  const originalLog = console.log;
  const originalWarn = console.warn;
  const captured: string[] = [];
  console.log = (...a: unknown[]) => {
    captured.push(a.join(" "));
  };
  console.warn = (...a: unknown[]) => {
    captured.push(a.join(" "));
  };
  try {
    printTenantSummary(summary);
    printGrandTotal(grandTotal);
  } finally {
    console.log = originalLog;
    console.warn = originalWarn;
  }

  const output = captured.join("\n");
  assert.equal(output.includes(PII_USER_ID), false, "出力に userId が含まれてはならない");
  assert.equal(output.includes("lesson-x"), true); // lessonId は出力対象として正しい
}

} // end main()

main()
  .then(() => console.log("✓ audit-duplicate-synthetic-sessions.smoke.ts: all assertions passed"))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
