/**
 * #533 Phase 2: backfill-synthetic-sessions のテスト
 *
 * 構成:
 *   - 純粋関数の単体テスト (categorizeAttempt / buildSyntheticSessionData /
 *     validateExpectedCount / validateReadback / parseArgs / sanitizeForWrite)
 *   - integration テスト (findBackfillTargets / applyBackfill) を in-memory
 *     Firestore fake で検証。AC2.1〜AC2.11 を網羅。
 */

import { describe, expect, it, vi } from "vitest";
import {
  type AttemptInfo,
  type BackfillTarget,
  type SessionInfo,
  type SyntheticSessionData,
  applyBackfill,
  buildSyntheticSessionData,
  buildUpdatedExitAt,
  buildWritePayload,
  categorizeAttempt,
  categorizeAttemptForUpdate,
  findBackfillTargets,
  parseArgs,
  resolveSessionDurationMs,
  runMain,
  sanitizeForWrite,
  validateExpectedCount,
  validateReadback,
  validateTenantBreakdown,
} from "../backfill-synthetic-sessions.js";
import type { Firestore } from "firebase-admin/firestore";

// ============================================================
// テスト用ヘルパー
// ============================================================

function makeAttempt(overrides: Partial<AttemptInfo> = {}): AttemptInfo {
  return {
    id: "attempt-1",
    status: "submitted",
    isPassed: true,
    startedAt: "2026-01-09T10:00:00.000Z",
    submittedAt: "2026-01-09T10:30:00.000Z",
    quizId: "quiz-1",
    userId: "user-1",
    attemptNumber: 1,
    score: 80,
    ...overrides,
  };
}

function makeSession(overrides: Partial<SessionInfo> = {}): SessionInfo {
  return {
    id: "session-1",
    userId: "user-1",
    lessonId: "lesson-1",
    courseId: "course-1",
    videoId: "video-1",
    status: "completed",
    entryAt: "2026-01-09T09:00:00.000Z",
    exitAt: "2026-01-09T10:30:00.000Z",
    exitReason: "quiz_submitted",
    quizAttemptId: null,
    ...overrides,
  };
}

// ============================================================
// categorizeAttempt
// ============================================================

describe("categorizeAttempt", () => {
  it("status=submitted + isPassed=true + 関連 session なし → backfill_target", () => {
    const attempt = makeAttempt();
    expect(categorizeAttempt(attempt, [])).toBe("backfill_target");
  });

  it("status=submitted + isPassed=true + 関連 session あるが quizAttemptId 一致なし → backfill_target", () => {
    const attempt = makeAttempt({ id: "attempt-A" });
    const session = makeSession({ quizAttemptId: "attempt-OTHER" });
    expect(categorizeAttempt(attempt, [session])).toBe("backfill_target");
  });

  it("status=submitted + isPassed=true + quizAttemptId 一致 session あり → audit_only", () => {
    const attempt = makeAttempt({ id: "attempt-A" });
    const session = makeSession({ quizAttemptId: "attempt-A" });
    expect(categorizeAttempt(attempt, [session])).toBe("audit_only");
  });

  it("status=submitted + isPassed=true + abandoned session に quizAttemptId 一致 → audit_only (apply 対象外)", () => {
    const attempt = makeAttempt({ id: "attempt-A" });
    const session = makeSession({
      quizAttemptId: "attempt-A",
      status: "abandoned",
    });
    expect(categorizeAttempt(attempt, [session])).toBe("audit_only");
  });

  it("status=in_progress → null", () => {
    const attempt = makeAttempt({ status: "in_progress" });
    expect(categorizeAttempt(attempt, [])).toBeNull();
  });

  it("status=timed_out → null (Codex 指摘: 'passed' でなく 'submitted' のみ)", () => {
    const attempt = makeAttempt({ status: "timed_out" });
    expect(categorizeAttempt(attempt, [])).toBeNull();
  });

  it("status='passed' (旧仕様、型に存在しないが念のため) → null", () => {
    const attempt = makeAttempt({ status: "passed" });
    expect(categorizeAttempt(attempt, [])).toBeNull();
  });

  it("status=submitted + isPassed=false → null", () => {
    const attempt = makeAttempt({ isPassed: false });
    expect(categorizeAttempt(attempt, [])).toBeNull();
  });

  it("status=submitted + isPassed=null → null", () => {
    const attempt = makeAttempt({ isPassed: null });
    expect(categorizeAttempt(attempt, [])).toBeNull();
  });

  it("startedAt 欠落 → null", () => {
    const attempt = makeAttempt({ startedAt: null });
    expect(categorizeAttempt(attempt, [])).toBeNull();
  });

  it("submittedAt 欠落 → null", () => {
    const attempt = makeAttempt({ submittedAt: null });
    expect(categorizeAttempt(attempt, [])).toBeNull();
  });

  it("複数 session のうち 1 件のみ quizAttemptId 一致 → audit_only", () => {
    const attempt = makeAttempt({ id: "attempt-A" });
    const sessions = [
      makeSession({ id: "s1", quizAttemptId: null }),
      makeSession({ id: "s2", quizAttemptId: "attempt-A", status: "completed" }),
      makeSession({ id: "s3", quizAttemptId: "attempt-OTHER" }),
    ];
    expect(categorizeAttempt(attempt, sessions)).toBe("audit_only");
  });
});

// ============================================================
// buildSyntheticSessionData
// ============================================================

describe("buildSyntheticSessionData", () => {
  it("Phase 1 createSyntheticCompletedSession と同じフィールドを生成", () => {
    const attempt = makeAttempt();
    const data = buildSyntheticSessionData(
      attempt,
      "lesson-1",
      "course-1",
      "video-1"
    );
    expect(data.userId).toBe("user-1");
    expect(data.lessonId).toBe("lesson-1");
    expect(data.courseId).toBe("course-1");
    expect(data.videoId).toBe("video-1");
    expect(data.sessionToken).toBe("synthetic-attempt-1");
    expect(data.status).toBe("completed");
    expect(data.entryAt).toBe("2026-01-09T10:00:00.000Z");
    expect(data.exitAt).toBe("2026-01-09T10:30:00.000Z");
    expect(data.exitReason).toBe("quiz_submitted");
    expect(data.pauseStartedAt).toBeNull();
    expect(data.longestPauseSec).toBe(0);
    expect(data.sessionVideoCompleted).toBe(true);
    expect(data.quizAttemptId).toBe("attempt-1");
    expect(data.isSynthetic).toBe(true);
  });

  it("deadlineAt = entryAt + SESSION_DURATION_MS (default 2 時間)", () => {
    const attempt = makeAttempt({
      startedAt: "2026-01-09T10:00:00.000Z",
    });
    const data = buildSyntheticSessionData(
      attempt,
      "lesson-1",
      "course-1",
      "video-1"
    );
    expect(data.deadlineAt).toBe("2026-01-09T12:00:00.000Z");
  });

  it("カスタム sessionDurationMs を指定可能", () => {
    const attempt = makeAttempt({
      startedAt: "2026-01-09T10:00:00.000Z",
    });
    const data = buildSyntheticSessionData(
      attempt,
      "lesson-1",
      "course-1",
      "video-1",
      3_600_000 // 1 時間
    );
    expect(data.deadlineAt).toBe("2026-01-09T11:00:00.000Z");
  });

  it("startedAt 欠落で例外", () => {
    const attempt = makeAttempt({ startedAt: null });
    expect(() =>
      buildSyntheticSessionData(attempt, "lesson-1", "course-1", "video-1")
    ).toThrow(/startedAt\/submittedAt が欠落/);
  });

  it("submittedAt 欠落で例外", () => {
    const attempt = makeAttempt({ submittedAt: null });
    expect(() =>
      buildSyntheticSessionData(attempt, "lesson-1", "course-1", "video-1")
    ).toThrow(/startedAt\/submittedAt が欠落/);
  });
});

// ============================================================
// validateExpectedCount
// ============================================================

describe("validateExpectedCount", () => {
  it("expected 未指定 → ok=true (audit 用)", () => {
    expect(validateExpectedCount(4, undefined)).toEqual({ ok: true });
    expect(validateExpectedCount(0, undefined)).toEqual({ ok: true });
  });

  it("一致 → ok=true", () => {
    expect(validateExpectedCount(4, 4)).toEqual({ ok: true });
    expect(validateExpectedCount(0, 0)).toEqual({ ok: true });
  });

  it("不一致 (実際の方が多い) → ok=false", () => {
    const result = validateExpectedCount(5, 4);
    expect(result.ok).toBe(false);
    expect(result.reason).toContain("expected_count=4");
    expect(result.reason).toContain("実際の対象件数は 5 件");
  });

  it("不一致 (実際の方が少ない) → ok=false (空振り検知)", () => {
    const result = validateExpectedCount(0, 4);
    expect(result.ok).toBe(false);
    expect(result.reason).toContain("実際の対象件数は 0 件");
  });
});

// ============================================================
// validateReadback
// ============================================================

describe("validateReadback", () => {
  function makeExpected(): SyntheticSessionData {
    return {
      userId: "user-1",
      lessonId: "lesson-1",
      courseId: "course-1",
      videoId: "video-1",
      sessionToken: "synthetic-attempt-1",
      status: "completed",
      entryAt: "2026-01-09T10:00:00.000Z",
      exitAt: "2026-01-09T10:30:00.000Z",
      exitReason: "quiz_submitted",
      deadlineAt: "2026-01-09T12:00:00.000Z",
      pauseStartedAt: null,
      longestPauseSec: 0,
      sessionVideoCompleted: true,
      quizAttemptId: "attempt-1",
      isSynthetic: true,
    };
  }

  it("全フィールド一致 → ok=true", () => {
    const expected = makeExpected();
    const actual = {
      id: "synthetic_attempt-1",
      ...expected,
    } as unknown as SessionInfo & {
      sessionVideoCompleted?: boolean;
      longestPauseSec?: number;
    };
    const result = validateReadback(expected, actual);
    expect(result.ok).toBe(true);
    expect(result.mismatches).toEqual([]);
  });

  it("isSynthetic が false → mismatch", () => {
    const expected = makeExpected();
    const actual = {
      id: "synthetic_attempt-1",
      ...expected,
      isSynthetic: false,
    } as unknown as SessionInfo & {
      sessionVideoCompleted?: boolean;
      longestPauseSec?: number;
    };
    const result = validateReadback(expected, actual);
    expect(result.ok).toBe(false);
    expect(result.mismatches.some((m) => m.startsWith("isSynthetic:"))).toBe(true);
  });

  it("entryAt が異なる → mismatch", () => {
    const expected = makeExpected();
    const actual = {
      id: "synthetic_attempt-1",
      ...expected,
      entryAt: "2026-01-09T11:00:00.000Z",
    } as unknown as SessionInfo & {
      sessionVideoCompleted?: boolean;
      longestPauseSec?: number;
    };
    const result = validateReadback(expected, actual);
    expect(result.ok).toBe(false);
    expect(result.mismatches.some((m) => m.startsWith("entryAt:"))).toBe(true);
  });

  it("複数フィールド差分を全て報告", () => {
    const expected = makeExpected();
    const actual = {
      id: "synthetic_attempt-1",
      ...expected,
      status: "active",
      isSynthetic: undefined,
    } as unknown as SessionInfo & {
      sessionVideoCompleted?: boolean;
      longestPauseSec?: number;
    };
    const result = validateReadback(expected, actual);
    expect(result.ok).toBe(false);
    expect(result.mismatches.length).toBeGreaterThanOrEqual(2);
  });

  it("pauseStartedAt が undefined → mismatch (Codex 反映: fieldsToCheck に追加)", () => {
    const expected = makeExpected();
    const actual = {
      id: "synthetic_attempt-1",
      ...expected,
      pauseStartedAt: undefined,
    } as unknown as SessionInfo & {
      sessionVideoCompleted?: boolean;
      longestPauseSec?: number;
      pauseStartedAt?: string | null;
    };
    const result = validateReadback(expected, actual);
    expect(result.ok).toBe(false);
    expect(result.mismatches.some((m) => m.startsWith("pauseStartedAt:"))).toBe(true);
  });
});

// ============================================================
// resolveSessionDurationMs (Codex C1 反映: env 読み出し)
// ============================================================

describe("resolveSessionDurationMs", () => {
  it("env 未指定 → 2 時間 (7,200,000 ms)", () => {
    expect(resolveSessionDurationMs(undefined)).toBe(7_200_000);
  });

  it("env=10800000 (本番 3 時間) → 10,800,000 ms", () => {
    expect(resolveSessionDurationMs("10800000")).toBe(10_800_000);
  });

  it("env=abc (NaN) → fallback", () => {
    expect(resolveSessionDurationMs("abc")).toBe(7_200_000);
  });

  it("env=0 → fallback (1 以上必須)", () => {
    expect(resolveSessionDurationMs("0")).toBe(7_200_000);
  });

  it("env=-100 → fallback", () => {
    expect(resolveSessionDurationMs("-100")).toBe(7_200_000);
  });

  it("env=3600.5 (非整数) → fallback", () => {
    expect(resolveSessionDurationMs("3600.5")).toBe(7_200_000);
  });

  it("env=空文字 → fallback", () => {
    expect(resolveSessionDurationMs("")).toBe(7_200_000);
  });

  it("env=86400000 (上限 24h ちょうど) → 86,400,000 ms", () => {
    expect(resolveSessionDurationMs("86400000")).toBe(86_400_000);
  });

  it("env=86400001 (上限 24h 超え) → fallback (Codex M2: Date 範囲外を防ぐ)", () => {
    expect(resolveSessionDurationMs("86400001")).toBe(7_200_000);
  });

  it("env=1e20 (極大値) → fallback", () => {
    expect(resolveSessionDurationMs("1e20")).toBe(7_200_000);
  });
});

// ============================================================
// buildWritePayload (Codex C5 反映: createdAt/updatedAt を Date オブジェクトで型保証)
// ============================================================

describe("buildWritePayload", () => {
  function makePlanned(): SyntheticSessionData {
    return buildSyntheticSessionData(
      {
        id: "attempt-1",
        status: "submitted",
        isPassed: true,
        startedAt: "2026-01-09T10:00:00.000Z",
        submittedAt: "2026-01-09T10:30:00.000Z",
        quizId: "quiz-1",
        userId: "user-1",
        attemptNumber: 1,
        score: 80,
      },
      "lesson-1",
      "course-1",
      "video-1"
    );
  }

  it("planned 全フィールド + createdAt/updatedAt が Date オブジェクトとして付与", () => {
    const planned = makePlanned();
    const now = new Date("2026-06-09T10:00:00.000Z");
    const payload = buildWritePayload(planned, now);
    // planned のフィールドが保持される
    expect(payload.userId).toBe("user-1");
    expect(payload.sessionToken).toBe("synthetic-attempt-1");
    expect(payload.isSynthetic).toBe(true);
    // Phase 1 createLessonSessionWithId と一致する Date オブジェクト型 (Firestore Timestamp 型保存)
    expect(payload.createdAt).toBeInstanceOf(Date);
    expect(payload.updatedAt).toBeInstanceOf(Date);
    expect(payload.createdAt.toISOString()).toBe("2026-06-09T10:00:00.000Z");
    expect(payload.updatedAt.toISOString()).toBe("2026-06-09T10:00:00.000Z");
  });

  it("createdAt と updatedAt は同じ Date インスタンスを参照 (一括書き込み)", () => {
    const planned = makePlanned();
    const now = new Date();
    const payload = buildWritePayload(planned, now);
    expect(payload.createdAt).toBe(payload.updatedAt);
  });
});

// ============================================================
// parseArgs
// ============================================================

describe("parseArgs", () => {
  it("引数なし → デフォルト値", () => {
    const result = parseArgs([]);
    expect(result.execute).toBe(false);
    expect(result.tenantId).toBeUndefined();
    expect(result.userId).toBeUndefined();
    expect(result.userEmail).toBeUndefined();
    expect(result.maxTargets).toBe(100);
    expect(result.expectedCount).toBeUndefined();
    expect(result.noBackup).toBe(false);
  });

  it("--execute フラグ", () => {
    expect(parseArgs(["--execute"]).execute).toBe(true);
  });

  it("--tenant-id=xxx", () => {
    expect(parseArgs(["--tenant-id=t1"]).tenantId).toBe("t1");
  });

  it("--user-email は lowercase + trim", () => {
    const result = parseArgs(["--user-email= Foo@Bar.Com "]);
    expect(result.userEmail).toBe("foo@bar.com");
  });

  it("--max-targets=50", () => {
    expect(parseArgs(["--max-targets=50"]).maxTargets).toBe(50);
  });

  it("--expected-count=4", () => {
    expect(parseArgs(["--expected-count=4"]).expectedCount).toBe(4);
  });

  it("--expected-count=0 は許可 (空振り検知用)", () => {
    expect(parseArgs(["--expected-count=0"]).expectedCount).toBe(0);
  });

  it("--user-id と --user-email 両指定で例外", () => {
    expect(() =>
      parseArgs(["--user-id=u1", "--user-email=foo@bar.com"])
    ).toThrow(/同時指定できません/);
  });

  it("--max-targets=0 で例外 (1 以上必須)", () => {
    expect(() => parseArgs(["--max-targets=0"])).toThrow(/1 以上の数値/);
  });

  it("--max-targets=-1 で例外", () => {
    expect(() => parseArgs(["--max-targets=-1"])).toThrow(/1 以上の数値/);
  });

  it("--max-targets=abc (NaN) で例外", () => {
    expect(() => parseArgs(["--max-targets=abc"])).toThrow(/1 以上の数値/);
  });

  it("--expected-count=-1 で例外", () => {
    expect(() => parseArgs(["--expected-count=-1"])).toThrow(/0 以上の整数/);
  });

  it("--expected-count=0.5 (非整数) で例外 (Codex M1 反映)", () => {
    expect(() => parseArgs(["--expected-count=0.5"])).toThrow(/0 以上の整数/);
  });

  it("--expected-count=2.7 (非整数) で例外", () => {
    expect(() => parseArgs(["--expected-count=2.7"])).toThrow(/0 以上の整数/);
  });

  it("未知のフラグで例外", () => {
    expect(() => parseArgs(["--unknown"])).toThrow(/未知のフラグ/);
  });

  it("--no-backup フラグ", () => {
    expect(parseArgs(["--no-backup"]).noBackup).toBe(true);
  });
});

// ============================================================
// sanitizeForWrite
// ============================================================

describe("sanitizeForWrite", () => {
  it("undefined フィールドを除去", () => {
    const result = sanitizeForWrite({
      a: 1,
      b: undefined,
      c: "x",
      d: null,
      e: false,
      f: 0,
    });
    expect(result).toEqual({ a: 1, c: "x", d: null, e: false, f: 0 });
    expect("b" in result).toBe(false);
  });

  it("null は保持 (Firestore で有効な値、undefined のみ除去)", () => {
    const result = sanitizeForWrite({ a: null });
    expect(result).toEqual({ a: null });
  });

  it("空オブジェクト → 空オブジェクト", () => {
    expect(sanitizeForWrite({})).toEqual({});
  });
});

// ============================================================
// In-memory Firestore fake (integration test 用)
// ============================================================

/**
 * admin SDK の最小サブセット (collection / doc / get / where / runTransaction) を満たす fake。
 * findBackfillTargets / applyBackfill が必要とする API のみ実装。
 */
function createFakeFirestore(initial: {
  tenants: string[];
  data: Record<string, Record<string, Record<string, unknown>>>; // path → docId → data
}): Firestore {
  const store: Record<string, Map<string, Record<string, unknown>>> = {};
  for (const [path, docs] of Object.entries(initial.data)) {
    store[path] = new Map(Object.entries(docs));
  }
  for (const tid of initial.tenants) {
    store["tenants"] ??= new Map();
    // data["tenants"] で name 等を明示指定していれば上書きしない
    if (!store["tenants"].has(tid)) {
      store["tenants"].set(tid, { id: tid });
    }
  }

  function makeDocRef(path: string, id: string) {
    return {
      id,
      _path: path,
      async get() {
        const doc = store[path]?.get(id);
        return {
          exists: doc !== undefined,
          id,
          data: () => doc,
        };
      },
    };
  }

  function makeQuery(path: string, filters: Array<[string, string, unknown]>) {
    return {
      where(field: string, op: string, value: unknown) {
        return makeQuery(path, [...filters, [field, op, value]]);
      },
      limit(_n: number) {
        return this;
      },
      async get() {
        const docs = Array.from(store[path]?.entries() ?? []).filter(([_id, d]) =>
          filters.every(([f, op, v]) => {
            if (op !== "==") throw new Error(`fake: only == supported`);
            return d[f] === v;
          })
        );
        return {
          empty: docs.length === 0,
          docs: docs.map(([id, d]) => ({
            id,
            data: () => d,
            ref: { id },
          })),
        };
      },
    };
  }

  function makeCollection(path: string) {
    return {
      doc(id: string) {
        return makeDocRef(path, id);
      },
      where(field: string, op: string, value: unknown) {
        return makeQuery(path, [[field, op, value]]);
      },
      async get() {
        return makeQuery(path, []).get();
      },
    };
  }

  const fake = {
    collection: (path: string) => makeCollection(path),
    async runTransaction<T>(
      fn: (tx: {
        get: (ref: { _path: string; id: string }) => Promise<{
          exists: boolean;
          data: () => Record<string, unknown> | undefined;
        }>;
        create: (
          ref: { _path: string; id: string },
          data: Record<string, unknown>
        ) => void;
        update: (
          ref: { _path: string; id: string },
          data: Record<string, unknown>
        ) => void;
      }) => Promise<T>
    ): Promise<T> {
      const writes: Array<
        | { type: "create"; path: string; id: string; data: Record<string, unknown> }
        | { type: "update"; path: string; id: string; data: Record<string, unknown> }
      > = [];
      const tx = {
        async get(ref: { _path: string; id: string }) {
          const doc = store[ref._path]?.get(ref.id);
          return {
            exists: doc !== undefined,
            data: () => doc,
          };
        },
        create(ref: { _path: string; id: string }, data: Record<string, unknown>) {
          if (store[ref._path]?.get(ref.id) !== undefined) {
            throw new Error(`fake: ALREADY_EXISTS at ${ref._path}/${ref.id}`);
          }
          writes.push({ type: "create", path: ref._path, id: ref.id, data });
        },
        update(ref: { _path: string; id: string }, data: Record<string, unknown>) {
          writes.push({ type: "update", path: ref._path, id: ref.id, data });
        },
      };
      const result = await fn(tx);
      for (const w of writes) {
        store[w.path] ??= new Map();
        if (w.type === "create") store[w.path].set(w.id, w.data);
        else
          store[w.path].set(w.id, {
            ...(store[w.path].get(w.id) ?? {}),
            ...w.data,
          });
      }
      return result;
    },
  };
  return fake as unknown as Firestore;
}

// ============================================================
// findBackfillTargets (integration)
// ============================================================

describe("findBackfillTargets [integration]", () => {
  function setupTenantWithAttempt(opts: {
    tenantId: string;
    attemptId: string;
    attemptStatus: string;
    isPassed: boolean | null;
    relatedSessions?: Array<{
      id: string;
      quizAttemptId: string | null;
      status: string;
    }>;
    lessonExists?: boolean;
    videoExists?: boolean;
    videoId?: string;
  }) {
    const lessonId = "lesson-1";
    const courseId = "course-1";
    const videoId = opts.videoId ?? "video-1";
    const quizId = "quiz-1";

    const sessions: Record<string, Record<string, unknown>> = {};
    for (const s of opts.relatedSessions ?? []) {
      sessions[s.id] = {
        userId: "user-1",
        lessonId,
        courseId,
        videoId,
        status: s.status,
        entryAt: "2026-01-09T09:00:00.000Z",
        exitAt: "2026-01-09T10:00:00.000Z",
        exitReason: s.status === "completed" ? "quiz_submitted" : null,
        quizAttemptId: s.quizAttemptId,
      };
    }

    const data: Record<string, Record<string, Record<string, unknown>>> = {
      [`tenants/${opts.tenantId}/quiz_attempts`]: {
        [opts.attemptId]: {
          quizId,
          userId: "user-1",
          attemptNumber: 1,
          status: opts.attemptStatus,
          isPassed: opts.isPassed,
          score: 80,
          startedAt: "2026-01-09T10:00:00.000Z",
          submittedAt: "2026-01-09T10:30:00.000Z",
        },
      },
      [`tenants/${opts.tenantId}/quizzes`]: {
        [quizId]: { lessonId, courseId },
      },
      // lesson 存在確認用 (videoId field は読まない、canonical は videos.lessonId)
      [`tenants/${opts.tenantId}/lessons`]: opts.lessonExists === false
        ? {}
        : { [lessonId]: { title: "test lesson" } },
      // videoId 解決用 (Phase 1 helper と同じ videos.lessonId where 検索)
      [`tenants/${opts.tenantId}/videos`]: opts.videoExists === false
        ? {}
        : { [videoId]: { lessonId, title: "test video" } },
      [`tenants/${opts.tenantId}/lesson_sessions`]: sessions,
    };

    return createFakeFirestore({
      tenants: [opts.tenantId],
      data,
    });
  }

  it("AC2.1: status=submitted + isPassed=true + 関連 session 0 件 → backfill_target", async () => {
    const db = setupTenantWithAttempt({
      tenantId: "t1",
      attemptId: "a1",
      attemptStatus: "submitted",
      isPassed: true,
    });
    const { targets, auditOnly } = await findBackfillTargets(db, ["t1"]);
    expect(targets.length).toBe(1);
    expect(auditOnly.length).toBe(0);
    expect(targets[0].attempt.id).toBe("a1");
    expect(targets[0].lessonId).toBe("lesson-1");
    expect(targets[0].courseId).toBe("course-1");
    expect(targets[0].videoId).toBe("video-1");
  });

  it("Codex 反映: status=submitted のみ拾い、'passed'/'in_progress'/'timed_out' は対象外", async () => {
    const dbInProgress = setupTenantWithAttempt({
      tenantId: "t1",
      attemptId: "a1",
      attemptStatus: "in_progress",
      isPassed: true,
    });
    const { targets: t1 } = await findBackfillTargets(dbInProgress, ["t1"]);
    expect(t1.length).toBe(0);

    const dbTimedOut = setupTenantWithAttempt({
      tenantId: "t1",
      attemptId: "a1",
      attemptStatus: "timed_out",
      isPassed: true,
    });
    const { targets: t2 } = await findBackfillTargets(dbTimedOut, ["t1"]);
    expect(t2.length).toBe(0);
  });

  it("isPassed=false は対象外", async () => {
    const db = setupTenantWithAttempt({
      tenantId: "t1",
      attemptId: "a1",
      attemptStatus: "submitted",
      isPassed: false,
    });
    const { targets } = await findBackfillTargets(db, ["t1"]);
    expect(targets.length).toBe(0);
  });

  it("quizAttemptId 一致 session あり → audit_only (apply 対象外)", async () => {
    const db = setupTenantWithAttempt({
      tenantId: "t1",
      attemptId: "a1",
      attemptStatus: "submitted",
      isPassed: true,
      relatedSessions: [
        { id: "s-existing", quizAttemptId: "a1", status: "abandoned" },
      ],
    });
    const { targets, auditOnly } = await findBackfillTargets(db, ["t1"]);
    expect(targets.length).toBe(0);
    expect(auditOnly.length).toBe(1);
    expect(auditOnly[0].reason).toContain("quizAttemptId 一致 session が 1 件");
  });

  it("lesson 削除済み → skip + warn (apply 対象外)", async () => {
    const db = setupTenantWithAttempt({
      tenantId: "t1",
      attemptId: "a1",
      attemptStatus: "submitted",
      isPassed: true,
      lessonExists: false,
    });
    const { targets, auditOnly } = await findBackfillTargets(db, ["t1"]);
    expect(targets.length).toBe(0);
    expect(auditOnly.length).toBe(0);
  });

  it("video 未紐付け (videos に lessonId 該当なし) → skip + warn (review-pr C1 反映)", async () => {
    const db = setupTenantWithAttempt({
      tenantId: "t1",
      attemptId: "a1",
      attemptStatus: "submitted",
      isPassed: true,
      videoExists: false,
    });
    const { targets, auditOnly } = await findBackfillTargets(db, ["t1"]);
    expect(targets.length).toBe(0);
    expect(auditOnly.length).toBe(0);
  });
});

// ============================================================
// applyBackfill (integration)
// ============================================================

describe("applyBackfill [integration]", () => {
  function makeTarget(attemptId: string, tenantId = "t1"): BackfillTarget {
    return {
      tenantId,
      attempt: {
        id: attemptId,
        status: "submitted",
        isPassed: true,
        startedAt: "2026-01-09T10:00:00.000Z",
        submittedAt: "2026-01-09T10:30:00.000Z",
        quizId: "quiz-1",
        userId: "user-1",
        attemptNumber: 1,
        score: 80,
      },
      lessonId: "lesson-1",
      courseId: "course-1",
      videoId: "video-1",
      relatedSessions: [],
    };
  }

  it("AC2.3: tx.create で synthetic_{attemptId} doc が作成され、6 フィールド値が正しい", async () => {
    const db = createFakeFirestore({ tenants: ["t1"], data: {} });
    const targets = [makeTarget("a1")];
    const result = await applyBackfill(db, targets);
    expect(result.created).toBe(1);
    expect(result.skipped).toBe(0);
    expect(result.failed).toBe(0);
    expect(result.readbackVerified).toBe(1);
    expect(result.readbackFailed).toBe(0);

    // 直接 store を read して値検証
    const doc = await db
      .collection("tenants/t1/lesson_sessions")
      .doc("synthetic_a1")
      .get();
    expect(doc.exists).toBe(true);
    const data = doc.data()!;
    expect(data.isSynthetic).toBe(true);
    expect(data.entryAt).toBe("2026-01-09T10:00:00.000Z");
    expect(data.exitAt).toBe("2026-01-09T10:30:00.000Z");
    expect(data.status).toBe("completed");
    expect(data.exitReason).toBe("quiz_submitted");
    expect(data.sessionVideoCompleted).toBe(true);
    expect(data.sessionToken).toBe("synthetic-a1");
    expect(data.quizAttemptId).toBe("a1");
    expect(data.createdAt).toBeTruthy();
    expect(data.updatedAt).toBeTruthy();
  });

  it("AC2.4: 同 target を 2 回 apply しても重複作成しない (idempotency)", async () => {
    const db = createFakeFirestore({ tenants: ["t1"], data: {} });
    const targets = [makeTarget("a1")];
    const r1 = await applyBackfill(db, targets);
    expect(r1.created).toBe(1);

    const r2 = await applyBackfill(db, targets);
    expect(r2.created).toBe(0);
    expect(r2.skipped).toBe(1);
    expect(r2.failed).toBe(0);
  });

  it("AC2.8: 1 件失敗で全体停止しない (per-attempt try/catch)", async () => {
    // a1 は正常、a2 は ALREADY_EXISTS をシミュレート (apply の tx.get で exists=true 扱い)
    const db = createFakeFirestore({
      tenants: ["t1"],
      data: {
        "tenants/t1/lesson_sessions": {
          synthetic_a2: { isSynthetic: true, userId: "pre-existing" },
        },
      },
    });
    const targets = [makeTarget("a1"), makeTarget("a2")];
    const result = await applyBackfill(db, targets);
    expect(result.created).toBe(1);
    expect(result.skipped).toBe(1);
    expect(result.failed).toBe(0);
  });

  it("複数テナント混在 + 複数 target を順次処理", async () => {
    const db = createFakeFirestore({
      tenants: ["t1", "t2"],
      data: {},
    });
    const targets = [
      makeTarget("a1", "t1"),
      makeTarget("a2", "t1"),
      makeTarget("a3", "t2"),
    ];
    const result = await applyBackfill(db, targets);
    expect(result.created).toBe(3);
    expect(result.skipped).toBe(0);
    expect(result.failed).toBe(0);
    expect(result.readbackVerified).toBe(3);

    const t1docs = await db.collection("tenants/t1/lesson_sessions").get();
    const t2docs = await db.collection("tenants/t2/lesson_sessions").get();
    expect(t1docs.docs.length).toBe(2);
    expect(t2docs.docs.length).toBe(1);
  });
});

// ============================================================
// ALREADY_EXISTS race condition (review-pr C2 反映)
// ============================================================

describe("applyBackfill: ALREADY_EXISTS race [integration]", () => {
  /**
   * tx.get で exists=false の後、tx.create で race により ALREADY_EXISTS が throw された
   * ケースを模擬する。実 Firestore admin SDK では並行 process 間で発生する。
   * runTransaction は ABORTED を retry するが、permanent error の場合は catch に到達する。
   */
  function createFakeWithRaceError(
    errorCode: number | string
  ): Firestore {
    const fakeRef = { _path: "tenants/t1/lesson_sessions", id: "synthetic_a1" };
    return {
      collection: (_path: string) => ({
        doc: (_id: string) => fakeRef,
      }),
      runTransaction: async <T>(
        fn: (tx: {
          get: (ref: typeof fakeRef) => Promise<{ exists: boolean; data: () => undefined }>;
          create: (ref: typeof fakeRef, data: unknown) => void;
        }) => Promise<T>
      ): Promise<T> => {
        return await fn({
          get: async () => ({ exists: false, data: () => undefined }),
          create: () => {
            const e = new Error("simulated race ALREADY_EXISTS") as Error & {
              code: number | string;
            };
            e.code = errorCode;
            throw e;
          },
        });
      },
    } as unknown as Firestore;
  }

  function makeTarget(attemptId: string): BackfillTarget {
    return {
      tenantId: "t1",
      attempt: {
        id: attemptId,
        status: "submitted",
        isPassed: true,
        startedAt: "2026-01-09T10:00:00.000Z",
        submittedAt: "2026-01-09T10:30:00.000Z",
        quizId: "quiz-1",
        userId: "user-1",
        attemptNumber: 1,
        score: 80,
      },
      lessonId: "lesson-1",
      courseId: "course-1",
      videoId: "video-1",
      relatedSessions: [],
    };
  }

  it("gRPC code=6 → skipped 扱い", async () => {
    const db = createFakeWithRaceError(6);
    const result = await applyBackfill(db, [makeTarget("a1")]);
    expect(result.skipped).toBe(1);
    expect(result.failed).toBe(0);
    expect(result.created).toBe(0);
  });

  it("admin SDK 文字列 'ALREADY_EXISTS' → skipped 扱い", async () => {
    const db = createFakeWithRaceError("ALREADY_EXISTS");
    const result = await applyBackfill(db, [makeTarget("a1")]);
    expect(result.skipped).toBe(1);
    expect(result.failed).toBe(0);
  });

  it("Web SDK 文字列 'already-exists' (lower-case) → skipped 扱い (review-pr 反映)", async () => {
    const db = createFakeWithRaceError("already-exists");
    const result = await applyBackfill(db, [makeTarget("a1")]);
    expect(result.skipped).toBe(1);
    expect(result.failed).toBe(0);
  });

  it("ALREADY_EXISTS 以外の error code → failed 扱い", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const db = createFakeWithRaceError(13); // gRPC INTERNAL
    const result = await applyBackfill(db, [makeTarget("a1")]);
    expect(result.failed).toBe(1);
    expect(result.skipped).toBe(0);
    errorSpy.mockRestore();
  });
});

// ============================================================
// runMain integration (review-pr C3 / I5 反映)
// ============================================================

describe("runMain [integration]", () => {
  function withProcessExitMock(): {
    exitSpy: ReturnType<typeof vi.spyOn>;
    errorSpy: ReturnType<typeof vi.spyOn>;
    logSpy: ReturnType<typeof vi.spyOn>;
    restore: () => void;
  } {
    const exitSpy = vi
      .spyOn(process, "exit")
      .mockImplementation((code?: string | number | null | undefined) => {
        throw new Error(`exit:${code ?? 0}`);
      });
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    return {
      exitSpy,
      errorSpy,
      logSpy,
      restore: () => {
        exitSpy.mockRestore();
        errorSpy.mockRestore();
        logSpy.mockRestore();
      },
    };
  }

  function setupDbWithTargets(count: number): Firestore {
    const attempts: Record<string, Record<string, unknown>> = {};
    for (let i = 0; i < count; i++) {
      attempts[`a${i}`] = {
        quizId: "quiz-1",
        userId: "user-1",
        attemptNumber: 1,
        status: "submitted",
        isPassed: true,
        score: 80,
        startedAt: "2026-01-09T10:00:00.000Z",
        submittedAt: "2026-01-09T10:30:00.000Z",
      };
    }
    return createFakeFirestore({
      tenants: ["t1"],
      data: {
        "tenants/t1/quiz_attempts": attempts,
        "tenants/t1/quizzes": {
          "quiz-1": { lessonId: "lesson-1", courseId: "course-1" },
        },
        "tenants/t1/lessons": { "lesson-1": { title: "lesson" } },
        "tenants/t1/videos": {
          "video-1": { lessonId: "lesson-1", title: "video" },
        },
      },
    });
  }

  it("--execute && --no-backup → exit(1) (review-pr C3 反映、destructive guard)", async () => {
    const { restore, errorSpy } = withProcessExitMock();
    const db = setupDbWithTargets(1);

    await expect(
      runMain(db, {
        execute: true,
        noBackup: true,
        maxTargets: 100,
      })
    ).rejects.toThrow("exit:1");

    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining("--execute と --no-backup")
    );
    restore();
  });

  it("targets.length > max_targets → exit(1) (review-pr I5 反映)", async () => {
    const { restore, errorSpy } = withProcessExitMock();
    const db = setupDbWithTargets(5);

    await expect(
      runMain(db, {
        execute: false,
        noBackup: true,
        maxTargets: 3,
      })
    ).rejects.toThrow("exit:1");

    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining("backfill 対象が 3 件を超えています (5 件)")
    );
    restore();
  });

  it("expected_count 不一致 → exit(1)", async () => {
    const { restore, errorSpy } = withProcessExitMock();
    const db = setupDbWithTargets(2);

    await expect(
      runMain(db, {
        execute: false,
        noBackup: true,
        maxTargets: 100,
        expectedCount: 3,
      })
    ).rejects.toThrow("exit:1");

    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining("expected_count=3")
    );
    restore();
  });

  it("targets ゼロ件 + expected_count=0 → 正常終了 (空振り検証)", async () => {
    const { restore } = withProcessExitMock();
    const db = setupDbWithTargets(0);

    await expect(
      runMain(db, {
        execute: false,
        noBackup: true,
        maxTargets: 100,
        expectedCount: 0,
      })
    ).resolves.toBeUndefined();
    restore();
  });

  it("tenant 内訳表示 + backup metadata に tenantName/userEmail 解決 (人間判読性向上)", async () => {
    const { restore, logSpy } = withProcessExitMock();
    const db = createFakeFirestore({
      tenants: ["t-A", "t-B"],
      data: {
        // tenant 名を明示
        tenants: {
          "t-A": { id: "t-A", name: "テナント A 株式会社" },
          "t-B": { id: "t-B", name: "テナント B 有限会社" },
        },
        // user email
        "tenants/t-A/users": {
          "user-1": { email: "user1@a.example" },
        },
        "tenants/t-B/users": {
          "user-1": { email: "user1@b.example" },
        },
        "tenants/t-A/quiz_attempts": {
          a1: {
            quizId: "quiz-1",
            userId: "user-1",
            attemptNumber: 1,
            status: "submitted",
            isPassed: true,
            score: 80,
            startedAt: "2026-01-09T10:00:00.000Z",
            submittedAt: "2026-01-09T10:30:00.000Z",
          },
        },
        "tenants/t-A/quizzes": {
          "quiz-1": { lessonId: "lesson-1", courseId: "course-1" },
        },
        "tenants/t-A/lessons": { "lesson-1": { title: "lesson" } },
        "tenants/t-A/videos": {
          "video-1": { lessonId: "lesson-1", title: "video" },
        },
        "tenants/t-B/quiz_attempts": {
          a2: {
            quizId: "quiz-2",
            userId: "user-1",
            attemptNumber: 1,
            status: "submitted",
            isPassed: true,
            score: 90,
            startedAt: "2026-01-10T10:00:00.000Z",
            submittedAt: "2026-01-10T10:30:00.000Z",
          },
        },
        "tenants/t-B/quizzes": {
          "quiz-2": { lessonId: "lesson-2", courseId: "course-2" },
        },
        "tenants/t-B/lessons": { "lesson-2": { title: "lesson 2" } },
        "tenants/t-B/videos": {
          "video-2": { lessonId: "lesson-2", title: "video 2" },
        },
      },
    });

    await expect(
      runMain(db, {
        execute: false,
        noBackup: true, // backup ファイル書き込みは無効、ただし tenant 内訳ログは出る
        maxTargets: 100,
      })
    ).resolves.toBeUndefined();

    // tenant 内訳ログに name が出ること
    const logs = logSpy.mock.calls.map((c) => String(c[0])).join("\n");
    expect(logs).toContain("テナント A 株式会社");
    expect(logs).toContain("テナント B 有限会社");
    restore();
  });
});

// ============================================================
// End-to-end (audit → dry-run → apply → idempotency)
// ============================================================

describe("E2E [audit → dry-run → apply → idempotency]", () => {
  it("検出 → apply → 再検出で 0 件 (Phase 2 のフルフロー)", async () => {
    const db = createFakeFirestore({
      tenants: ["t-nagaono"],
      data: {
        "tenants/t-nagaono/quiz_attempts": {
          a1: {
            quizId: "quiz-1",
            userId: "user-1",
            attemptNumber: 1,
            status: "submitted",
            isPassed: true,
            score: 100,
            startedAt: "2026-01-09T10:00:00.000Z",
            submittedAt: "2026-01-09T10:30:00.000Z",
          },
        },
        "tenants/t-nagaono/quizzes": {
          "quiz-1": { lessonId: "lesson-1", courseId: "course-1" },
        },
        "tenants/t-nagaono/lessons": {
          "lesson-1": { title: "lesson" },
        },
        "tenants/t-nagaono/videos": {
          "video-1": { lessonId: "lesson-1", title: "video" },
        },
      },
    });

    // Phase 1: audit (検出)
    const before = await findBackfillTargets(db, ["t-nagaono"]);
    expect(before.targets.length).toBe(1);

    // Phase 2: apply
    const applyResult = await applyBackfill(db, before.targets);
    expect(applyResult.created).toBe(1);
    expect(applyResult.readbackVerified).toBe(1);

    // Phase 3: re-audit → 0 件 (idempotency)
    const after = await findBackfillTargets(db, ["t-nagaono"]);
    expect(after.targets.length).toBe(0);
    expect(after.auditOnly.length).toBe(1);
    expect(after.auditOnly[0].reason).toContain("quizAttemptId 一致");
  });
});

// ============================================================
// Phase 3 follow-up #4 (D 案) update-existing モード
// ============================================================

describe("Phase 3 follow-up #4: categorizeAttemptForUpdate", () => {
  const baseAttempt: AttemptInfo = {
    id: "att-1",
    status: "submitted",
    isPassed: true,
    startedAt: "2026-05-30T08:41:00.000Z",
    submittedAt: "2026-05-30T08:42:00.000Z",
    quizId: "q-1",
    userId: "u-1",
    attemptNumber: 1,
    score: 100,
  };

  function makeSyntheticSession(overrides: Partial<SessionInfo & { editedAt?: string; original?: unknown }> = {}) {
    return {
      id: "synthetic_att-1",
      userId: "u-1",
      lessonId: "l-1",
      courseId: "c-1",
      videoId: "v-1",
      status: "completed",
      entryAt: "2026-05-30T08:41:00.000Z",
      exitAt: "2026-05-30T08:42:00.000Z",
      exitReason: "quiz_submitted",
      quizAttemptId: "att-1",
      isSynthetic: true,
      ...overrides,
    };
  }

  it("旧形式 synthetic doc (entryAt=startedAt, exitAt=submittedAt) + 編集なし → update_target", () => {
    expect(categorizeAttemptForUpdate(baseAttempt, [makeSyntheticSession()])).toBe(
      "update_target",
    );
  });

  it("attempt.status !== submitted → skip_invalid_attempt", () => {
    expect(
      categorizeAttemptForUpdate({ ...baseAttempt, status: "in_progress" }, [
        makeSyntheticSession(),
      ]),
    ).toBe("skip_invalid_attempt");
  });

  it("attempt.isPassed !== true → skip_invalid_attempt", () => {
    expect(
      categorizeAttemptForUpdate({ ...baseAttempt, isPassed: false }, [
        makeSyntheticSession(),
      ]),
    ).toBe("skip_invalid_attempt");
  });

  it("attempt.startedAt 欠落 → skip_invalid_attempt", () => {
    expect(
      categorizeAttemptForUpdate({ ...baseAttempt, startedAt: null }, [
        makeSyntheticSession(),
      ]),
    ).toBe("skip_invalid_attempt");
  });

  it("synthetic doc 不在 → skip_no_synthetic", () => {
    expect(categorizeAttemptForUpdate(baseAttempt, [])).toBe("skip_no_synthetic");
  });

  it("synthetic.original あり → skip_edited (PR #557 保護)", () => {
    expect(
      categorizeAttemptForUpdate(baseAttempt, [
        makeSyntheticSession({
          original: { entryAt: "2026-05-30T08:41:00.000Z", exitAt: "2026-05-30T08:42:00.000Z" },
        }),
      ]),
    ).toBe("skip_edited");
  });

  it("synthetic.editedAt あり → skip_edited (Codex 指摘 #5: editedAt 単独でも保護)", () => {
    expect(
      categorizeAttemptForUpdate(baseAttempt, [
        makeSyntheticSession({ editedAt: "2026-06-10T12:00:00.000Z" }),
      ]),
    ).toBe("skip_edited");
  });

  it("synthetic.entryAt !== attempt.startedAt → skip_not_legacy", () => {
    expect(
      categorizeAttemptForUpdate(baseAttempt, [
        makeSyntheticSession({ entryAt: "2026-05-30T07:00:00.000Z" }),
      ]),
    ).toBe("skip_not_legacy");
  });

  it("synthetic.exitAt !== attempt.submittedAt → skip_not_legacy", () => {
    expect(
      categorizeAttemptForUpdate(baseAttempt, [
        makeSyntheticSession({ exitAt: "2026-05-30T10:00:00.000Z" }),
      ]),
    ).toBe("skip_not_legacy");
  });

  it("isSynthetic !== true → skip_no_synthetic (id が synthetic_ でも厳密判定)", () => {
    expect(
      categorizeAttemptForUpdate(baseAttempt, [
        makeSyntheticSession({ isSynthetic: false }),
      ]),
    ).toBe("skip_no_synthetic");
  });
});

describe("Phase 3 follow-up #4: buildUpdatedExitAt", () => {
  const attempt: AttemptInfo = {
    id: "att-1",
    status: "submitted",
    isPassed: true,
    startedAt: "2026-05-30T08:41:00.000Z",
    submittedAt: "2026-05-30T08:42:00.000Z", // quiz 1 分
    quizId: "q-1",
    userId: "u-1",
    attemptNumber: 1,
    score: 100,
  };

  it("動画 60 分 + テスト 1 分 → startedAt + 61 分", () => {
    const result = buildUpdatedExitAt(attempt, 60 * 60);
    expect(result).toBe("2026-05-30T09:42:00.000Z");
  });

  it("動画 5 分 + テスト 1 分 → startedAt + 6 分", () => {
    const result = buildUpdatedExitAt(attempt, 5 * 60);
    expect(result).toBe("2026-05-30T08:47:00.000Z");
  });

  it("videoDurationSec=0 → throw", () => {
    expect(() => buildUpdatedExitAt(attempt, 0)).toThrow(/invalid videoDurationSec/);
  });

  it("videoDurationSec が負 → throw", () => {
    expect(() => buildUpdatedExitAt(attempt, -1)).toThrow(/invalid videoDurationSec/);
  });

  it("videoDurationSec が NaN → throw", () => {
    expect(() => buildUpdatedExitAt(attempt, NaN)).toThrow(/invalid videoDurationSec/);
  });

  it("videoDurationSec が Infinity → throw", () => {
    expect(() => buildUpdatedExitAt(attempt, Infinity)).toThrow(/invalid videoDurationSec/);
  });

  it("attempt.startedAt 欠落 → throw", () => {
    expect(() =>
      buildUpdatedExitAt({ ...attempt, startedAt: null }, 60),
    ).toThrow(/startedAt\/submittedAt が欠落/);
  });

  it("日付境界またぎ (動画 120 分、23:00 開始) → 翌日 01:01", () => {
    const result = buildUpdatedExitAt(
      { ...attempt, startedAt: "2026-05-30T23:00:00.000Z", submittedAt: "2026-05-30T23:01:00.000Z" },
      120 * 60,
    );
    expect(result).toBe("2026-05-31T01:01:00.000Z");
  });
});

describe("Phase 3 follow-up #4: validateTenantBreakdown", () => {
  it("expected 空 → 検証スキップ (ok=true)", () => {
    expect(validateTenantBreakdown(new Map([["t1", 5]]), new Map())).toEqual({ ok: true });
  });

  it("完全一致 → ok=true", () => {
    expect(
      validateTenantBreakdown(
        new Map([["nagaono", 12], ["fukunotane", 5]]),
        new Map([["nagaono", 12], ["fukunotane", 5]]),
      ),
    ).toEqual({ ok: true });
  });

  it("件数不一致 → ok=false", () => {
    const result = validateTenantBreakdown(
      new Map([["nagaono", 10], ["fukunotane", 5]]),
      new Map([["nagaono", 12], ["fukunotane", 5]]),
    );
    expect(result.ok).toBe(false);
    expect(result.reason).toContain("nagaono");
  });

  it("想定外 tenant あり → ok=false", () => {
    const result = validateTenantBreakdown(
      new Map([["nagaono", 12], ["fukunotane", 5], ["unexpected", 3]]),
      new Map([["nagaono", 12], ["fukunotane", 5]]),
    );
    expect(result.ok).toBe(false);
    expect(result.reason).toContain("unexpected tenant");
  });

  it("expected にあるが actual に 0 → ok=false", () => {
    const result = validateTenantBreakdown(
      new Map([["nagaono", 12]]),
      new Map([["nagaono", 12], ["fukunotane", 5]]),
    );
    expect(result.ok).toBe(false);
    expect(result.reason).toContain("fukunotane");
  });
});

describe("Phase 3 follow-up #4: parseArgs mode フラグ", () => {
  it("--mode= 指定なし → デフォルト 'create-missing'", () => {
    const parsed = parseArgs([]);
    expect(parsed.mode).toBe("create-missing");
  });

  it("--mode=update-existing → 'update-existing'", () => {
    const parsed = parseArgs(["--mode=update-existing"]);
    expect(parsed.mode).toBe("update-existing");
  });

  it("--mode=create-missing → 'create-missing'", () => {
    const parsed = parseArgs(["--mode=create-missing"]);
    expect(parsed.mode).toBe("create-missing");
  });

  it("--mode=invalid → throw", () => {
    expect(() => parseArgs(["--mode=invalid"])).toThrow(/--mode は/);
  });
});

describe("Phase 3 follow-up #4: parseExpectedCountTenant (Codex finding #1)", () => {
  it("'tid1:12,tid2:5' → Map 2 件", async () => {
    const { parseExpectedCountTenant } = await import("../backfill-synthetic-sessions.js");
    const result = parseExpectedCountTenant("tid1:12,tid2:5");
    expect(result.get("tid1")).toBe(12);
    expect(result.get("tid2")).toBe(5);
  });

  it("空白許容", async () => {
    const { parseExpectedCountTenant } = await import("../backfill-synthetic-sessions.js");
    const result = parseExpectedCountTenant(" tid1:12 , tid2:5 ");
    expect(result.size).toBe(2);
  });

  it("形式不正 (':' なし) → throw", async () => {
    const { parseExpectedCountTenant } = await import("../backfill-synthetic-sessions.js");
    expect(() => parseExpectedCountTenant("tid1-12,tid2:5")).toThrow(/形式が不正/);
  });

  it("count が負数 → throw", async () => {
    const { parseExpectedCountTenant } = await import("../backfill-synthetic-sessions.js");
    expect(() => parseExpectedCountTenant("tid1:-1")).toThrow(/0 以上の整数が必要/);
  });

  it("count が NaN → throw", async () => {
    const { parseExpectedCountTenant } = await import("../backfill-synthetic-sessions.js");
    expect(() => parseExpectedCountTenant("tid1:abc")).toThrow(/0 以上の整数が必要/);
  });

  it("重複 tenant id → throw", async () => {
    const { parseExpectedCountTenant } = await import("../backfill-synthetic-sessions.js");
    expect(() => parseExpectedCountTenant("tid1:12,tid1:5")).toThrow(/重複した tenant id/);
  });

  it("--expected-count-tenant フラグ経由で parseArgs に渡る", () => {
    const parsed = parseArgs(["--expected-count-tenant=nagaono:12,fukunotane:5"]);
    expect(parsed.expectedCountTenant?.get("nagaono")).toBe(12);
    expect(parsed.expectedCountTenant?.get("fukunotane")).toBe(5);
  });
});
