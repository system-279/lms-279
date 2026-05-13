import { describe, it, expect } from "vitest";
import {
  planAudit,
  buildAuditFixNote,
  planApplyFix,
  mergeSuperAdmins,
  parseAuditArgs,
  detectDuplicateUsers,
  toNormalizedEmail,
  HelpRequestedError,
  WRITE_BATCH_LIMIT,
  type AuditUserInput,
  type AuditAllowedEmailInput,
  type NormalizedEmail,
  type AuditReport,
} from "../allowed-email-audit.js";

/** テスト用ヘルパ: 文字列を NormalizedEmail として cast する (正規化済みである前提) */
function ne(s: string): NormalizedEmail {
  const n = toNormalizedEmail(s);
  if (n === null) throw new Error(`Invalid email for test fixture: ${s}`);
  return n;
}

function u(
  id: string,
  email: string | null,
  opts: Partial<AuditUserInput> = {}
): AuditUserInput {
  return {
    id,
    email,
    role: "student",
    createdAt: "2026-01-01T00:00:00.000Z",
    lastSignInTime: null,
    ...opts,
  };
}

function ae(id: string, email: string | null): AuditAllowedEmailInput {
  return { id, email };
}

describe("planAudit", () => {
  it("users と allowed_emails の両方にある場合は matched に分類する", () => {
    const report = planAudit(
      [u("u1", "alice@example.com", { firebaseUid: "fbuid-1" })],
      [ae("ae1", "alice@example.com")],
      []
    );

    expect(report.matched).toEqual([
      {
        userId: "u1",
        firebaseUid: "fbuid-1",
        email: "alice@example.com",
        allowedEmailId: "ae1",
      },
    ]);
    expect(report.usersWithoutAllowedEmail).toEqual([]);
    expect(report.allowedEmailsWithoutUser).toEqual([]);
  });

  it("users にあるが allowed_emails にない場合は usersWithoutAllowedEmail に分類する", () => {
    const report = planAudit(
      [
        u("u1", "orphan@example.com", {
          firebaseUid: "fbuid-1",
          role: "teacher",
          createdAt: "2025-06-01T00:00:00.000Z",
          lastSignInTime: "2025-12-01T00:00:00.000Z",
        }),
      ],
      [],
      []
    );

    expect(report.usersWithoutAllowedEmail).toEqual([
      {
        userId: "u1",
        firebaseUid: "fbuid-1",
        email: "orphan@example.com",
        role: "teacher",
        createdAt: "2025-06-01T00:00:00.000Z",
        lastSignInTime: "2025-12-01T00:00:00.000Z",
      },
    ]);
    expect(report.matched).toEqual([]);
  });

  it("allowed_emails にあるが users にない場合は allowedEmailsWithoutUser に分類する", () => {
    const report = planAudit(
      [],
      [ae("ae1", "invited@example.com")],
      []
    );

    expect(report.allowedEmailsWithoutUser).toEqual([
      { allowedEmailId: "ae1", email: "invited@example.com" },
    ]);
  });

  it("email 大文字混在でも正規化して突き合わせる", () => {
    const report = planAudit(
      [u("u1", "  Alice@Example.COM  ")],
      [ae("ae1", "alice@example.com")],
      []
    );

    expect(report.matched).toHaveLength(1);
    expect(report.matched[0].email).toBe("alice@example.com");
    expect(report.usersWithoutAllowedEmail).toEqual([]);
    expect(report.allowedEmailsWithoutUser).toEqual([]);
  });

  it("スーパー管理者は usersWithoutAllowedEmail から除外される", () => {
    const report = planAudit(
      [
        u("u1", "admin@example.com", { role: "admin" }),
        u("u2", "regular@example.com"),
      ],
      [],
      ["admin@example.com"]
    );

    expect(report.usersWithoutAllowedEmail).toHaveLength(1);
    expect(report.usersWithoutAllowedEmail[0].email).toBe("regular@example.com");
    expect(report.excludedSuperAdmins).toEqual([
      { userId: "u1", email: "admin@example.com" },
    ]);
  });

  it("スーパー管理者メールも正規化して比較される（大文字混在）", () => {
    const report = planAudit(
      [u("u1", "admin@example.com")],
      [],
      ["  ADMIN@Example.com  "]
    );

    expect(report.usersWithoutAllowedEmail).toEqual([]);
    expect(report.excludedSuperAdmins).toHaveLength(1);
  });

  it("スーパー管理者が allowed_emails にも入っている場合は matched 扱い（excludedSuperAdmins には入らない）", () => {
    const report = planAudit(
      [u("u1", "admin@example.com", { role: "admin" })],
      [ae("ae1", "admin@example.com")],
      ["admin@example.com"]
    );

    expect(report.matched).toHaveLength(1);
    expect(report.excludedSuperAdmins).toEqual([]);
    expect(report.usersWithoutAllowedEmail).toEqual([]);
  });

  it("email が空または null の users は invalid に分類される", () => {
    const report = planAudit(
      [u("u1", null), u("u2", "")],
      [],
      []
    );

    expect(report.invalid).toEqual([
      { kind: "user", id: "u1", reason: "email が空または null" },
      { kind: "user", id: "u2", reason: "email が空または null" },
    ]);
    expect(report.usersWithoutAllowedEmail).toEqual([]);
  });

  it("email が空または null の allowed_emails も invalid に分類される", () => {
    const report = planAudit(
      [],
      [ae("ae1", null), ae("ae2", "   ")],
      []
    );

    expect(report.invalid).toEqual([
      { kind: "allowed_email", id: "ae1", reason: "email が空または null" },
      { kind: "allowed_email", id: "ae2", reason: "email が空または null" },
    ]);
    expect(report.allowedEmailsWithoutUser).toEqual([]);
  });

  it("複数テナント横断の大規模入力でも正しく分類される", () => {
    const users = [
      u("u1", "a@x.com"),
      u("u2", "b@x.com"),
      u("u3", "c@x.com"),
      u("u4", "admin@x.com", { role: "admin" }),
    ];
    const allowed = [
      ae("ae1", "a@x.com"),
      ae("ae2", "b@x.com"),
      ae("ae3", "d@x.com"),
    ];
    const report = planAudit(users, allowed, ["admin@x.com"]);

    expect(report.matched.map((m) => m.email).sort()).toEqual([
      "a@x.com",
      "b@x.com",
    ]);
    expect(report.usersWithoutAllowedEmail.map((e) => e.email)).toEqual([
      "c@x.com",
    ]);
    expect(report.allowedEmailsWithoutUser.map((e) => e.email)).toEqual([
      "d@x.com",
    ]);
    expect(report.excludedSuperAdmins.map((e) => e.email)).toEqual([
      "admin@x.com",
    ]);
  });

  it("重複する email を持つ users 入力でも最初の1件だけ扱い、後続は無視される（防御的）", () => {
    const report = planAudit(
      [u("u1", "dup@example.com"), u("u2", "dup@example.com")],
      [ae("ae1", "dup@example.com")],
      []
    );

    expect(report.matched).toHaveLength(1);
    expect(report.matched[0].userId).toBe("u1");
    expect(report.usersWithoutAllowedEmail).toEqual([]);
  });

  it("lastSignInTime が未指定の場合は null として出力される", () => {
    const report = planAudit(
      [u("u1", "a@x.com")],
      [],
      []
    );

    expect(report.usersWithoutAllowedEmail[0].lastSignInTime).toBeNull();
  });

  it("全て空入力でも空のレポートを返す（境界条件）", () => {
    const report = planAudit([], [], []);

    expect(report).toEqual({
      matched: [],
      usersWithoutAllowedEmail: [],
      allowedEmailsWithoutUser: [],
      invalid: [],
      excludedSuperAdmins: [],
      duplicateUsers: [],
    });
  });

  it("スーパー管理者リストに users にも allowed_emails にもない email があっても副作用なし", () => {
    const report = planAudit(
      [u("u1", "alice@example.com")],
      [ae("ae1", "alice@example.com")],
      ["ghost@example.com"]
    );

    expect(report.matched).toHaveLength(1);
    expect(report.excludedSuperAdmins).toEqual([]);
    expect(report.usersWithoutAllowedEmail).toEqual([]);
  });

  it("スーパー管理者リストの空文字/空白は無視される", () => {
    const report = planAudit(
      [u("u1", "admin@example.com")],
      [],
      ["", "  ", "admin@example.com"]
    );

    expect(report.excludedSuperAdmins).toHaveLength(1);
    expect(report.excludedSuperAdmins[0].email).toBe("admin@example.com");
    expect(report.usersWithoutAllowedEmail).toEqual([]);
  });
});

describe("buildAuditFixNote", () => {
  it("固定日付で note 文字列を生成する", () => {
    const date = new Date("2026-04-21T12:34:56Z");
    expect(buildAuditFixNote(date)).toBe(
      "audit-fix (Issue #279) by scripts/audit-users-vs-allowed-emails on 2026-04-21"
    );
  });

  it("月日が1桁でもゼロパディングされる", () => {
    const date = new Date("2026-01-05T00:00:00Z");
    expect(buildAuditFixNote(date)).toBe(
      "audit-fix (Issue #279) by scripts/audit-users-vs-allowed-emails on 2026-01-05"
    );
  });
});

describe("planApplyFix (Issue #281)", () => {
  function buildReport(
    emails: string[]
  ): Pick<AuditReport, "usersWithoutAllowedEmail"> {
    return {
      usersWithoutAllowedEmail: emails.map((email, i) => ({
        userId: `u${i}`,
        firebaseUid: undefined,
        email: ne(email),
        role: "student",
        createdAt: "2026-01-01T00:00:00.000Z",
        lastSignInTime: null,
      })),
    };
  }

  it("空入力なら toAdd/toSkip/batches すべて空", () => {
    const plan = planApplyFix(buildReport([]), []);
    expect(plan).toEqual({ toAdd: [], toSkip: [], batches: [] });
  });

  it("既存に存在しない email は toAdd に分類される", () => {
    const plan = planApplyFix(
      buildReport(["a@x.com", "b@x.com"]),
      [ne("c@x.com")]
    );
    expect(plan.toAdd).toEqual([ne("a@x.com"), ne("b@x.com")]);
    expect(plan.toSkip).toEqual([]);
  });

  it("既存に存在する email は toSkip に分類される", () => {
    const plan = planApplyFix(
      buildReport(["a@x.com", "b@x.com"]),
      [ne("a@x.com")]
    );
    expect(plan.toAdd).toEqual([ne("b@x.com")]);
    expect(plan.toSkip).toEqual([ne("a@x.com")]);
  });

  it("usersWithoutAllowedEmail 内の同一 email 重複は toAdd に 1 回のみ", () => {
    const plan = planApplyFix(
      buildReport(["a@x.com", "a@x.com", "b@x.com"]),
      []
    );
    expect(plan.toAdd).toEqual([ne("a@x.com"), ne("b@x.com")]);
  });

  it("WriteBatch 境界: 449 件 → 1 batch", () => {
    const emails = Array.from({ length: 449 }, (_, i) => `u${i}@x.com`);
    const plan = planApplyFix(buildReport(emails), []);
    expect(plan.batches).toHaveLength(1);
    expect(plan.batches[0]).toHaveLength(449);
  });

  it("WriteBatch 境界: 450 件 → 1 batch (上限ぴったり)", () => {
    const emails = Array.from({ length: 450 }, (_, i) => `u${i}@x.com`);
    const plan = planApplyFix(buildReport(emails), []);
    expect(plan.batches).toHaveLength(1);
    expect(plan.batches[0]).toHaveLength(450);
  });

  it("WriteBatch 境界: 900 件 → 2 batches (各 450 件)", () => {
    const emails = Array.from({ length: 900 }, (_, i) => `u${i}@x.com`);
    const plan = planApplyFix(buildReport(emails), []);
    expect(plan.batches).toHaveLength(2);
    expect(plan.batches[0]).toHaveLength(450);
    expect(plan.batches[1]).toHaveLength(450);
  });

  it("WriteBatch 境界: 901 件 → 3 batches (450/450/1)", () => {
    const emails = Array.from({ length: 901 }, (_, i) => `u${i}@x.com`);
    const plan = planApplyFix(buildReport(emails), []);
    expect(plan.batches).toHaveLength(3);
    expect(plan.batches[0]).toHaveLength(450);
    expect(plan.batches[1]).toHaveLength(450);
    expect(plan.batches[2]).toHaveLength(1);
  });

  it("WRITE_BATCH_LIMIT は 450", () => {
    expect(WRITE_BATCH_LIMIT).toBe(450);
  });

  it("batchLimit <= 0 はエラー", () => {
    expect(() => planApplyFix(buildReport(["a@x.com"]), [], 0)).toThrow(
      /must be positive/
    );
    expect(() => planApplyFix(buildReport(["a@x.com"]), [], -1)).toThrow(
      /must be positive/
    );
  });
});

describe("mergeSuperAdmins (Issue #281)", () => {
  it("env CSV + Firestore + extra の union を返す", () => {
    const result = mergeSuperAdmins(
      "a@x.com,b@x.com",
      ["c@x.com"],
      ["d@x.com"]
    );
    expect(result).toEqual([ne("a@x.com"), ne("b@x.com"), ne("c@x.com"), ne("d@x.com")]);
  });

  it("重複は除去される (env と Firestore の重複)", () => {
    const result = mergeSuperAdmins("a@x.com,b@x.com", ["a@x.com"], []);
    expect(result).toEqual([ne("a@x.com"), ne("b@x.com")]);
  });

  it("空白除去 + 小文字化される", () => {
    const result = mergeSuperAdmins(" A@X.COM , b@x.com ", [" C@x.com "], []);
    expect(result).toEqual([ne("a@x.com"), ne("b@x.com"), ne("c@x.com")]);
  });

  it("空文字は無視される", () => {
    const result = mergeSuperAdmins(",,a@x.com,", ["", "  ", "b@x.com"], [""]);
    expect(result).toEqual([ne("a@x.com"), ne("b@x.com")]);
  });

  it("全引数が空でも空配列を返す", () => {
    const result = mergeSuperAdmins("", [], []);
    expect(result).toEqual([]);
  });

  it("結果はソートされる", () => {
    const result = mergeSuperAdmins("c@x.com", ["a@x.com"], ["b@x.com"]);
    expect(result).toEqual([ne("a@x.com"), ne("b@x.com"), ne("c@x.com")]);
  });
});

describe("parseAuditArgs (Issue #281)", () => {
  it("引数なしは dry-run mode", () => {
    expect(parseAuditArgs([])).toEqual({
      mode: { kind: "dry-run" },
      skipAuthMetadata: false,
      tenantFilter: null,
      extraSuperAdmins: [],
    });
  });

  it("--fix のみは fix-dry-run mode", () => {
    expect(parseAuditArgs(["--fix"]).mode).toEqual({ kind: "fix-dry-run" });
  });

  it("--fix --execute は fix-execute mode", () => {
    expect(parseAuditArgs(["--fix", "--execute"]).mode).toEqual({
      kind: "fix-execute",
    });
  });

  it("--execute のみ (--fix 不在) は reject", () => {
    expect(() => parseAuditArgs(["--execute"])).toThrow(
      /--execute は --fix と併用/
    );
  });

  it("位置引数は reject", () => {
    expect(() => parseAuditArgs(["tenant1"])).toThrow(/未知の引数/);
    expect(() => parseAuditArgs(["--fix", "tenant1"])).toThrow(/未知の引数/);
  });

  it("--tenant 値欠落は reject", () => {
    expect(() => parseAuditArgs(["--tenant"])).toThrow(
      /--tenant の値が指定されていません/
    );
  });

  it("--super-admins 値欠落は reject", () => {
    expect(() => parseAuditArgs(["--super-admins"])).toThrow(
      /--super-admins の値が指定されていません/
    );
  });

  it("--tenant に値を渡せる", () => {
    expect(parseAuditArgs(["--tenant", "t1"]).tenantFilter).toBe("t1");
  });

  it("--super-admins は CSV を分解して空白除去", () => {
    expect(
      parseAuditArgs(["--super-admins", " a@x.com , b@x.com , "])
        .extraSuperAdmins
    ).toEqual(["a@x.com", "b@x.com"]);
  });

  it("--skip-auth-metadata を解釈する", () => {
    expect(parseAuditArgs(["--skip-auth-metadata"]).skipAuthMetadata).toBe(true);
  });

  it("--help は HelpRequestedError を throw", () => {
    expect(() => parseAuditArgs(["--help"])).toThrow(HelpRequestedError);
    expect(() => parseAuditArgs(["-h"])).toThrow(HelpRequestedError);
  });

  it("未知のオプションは reject", () => {
    expect(() => parseAuditArgs(["--unknown"])).toThrow(/未知の引数/);
  });

  it("複数オプションを組み合わせ可能", () => {
    const opts = parseAuditArgs([
      "--fix",
      "--execute",
      "--tenant",
      "t1",
      "--skip-auth-metadata",
      "--super-admins",
      "a@x.com",
    ]);
    expect(opts).toEqual({
      mode: { kind: "fix-execute" },
      skipAuthMetadata: true,
      tenantFilter: "t1",
      extraSuperAdmins: ["a@x.com"],
    });
  });
});

describe("detectDuplicateUsers (Issue #281)", () => {
  it("重複なしなら空配列", () => {
    const result = detectDuplicateUsers([
      u("u1", "a@x.com"),
      u("u2", "b@x.com"),
    ]);
    expect(result).toEqual([]);
  });

  it("重複 email を含む全 userIds を返す", () => {
    const result = detectDuplicateUsers([
      u("u1", "a@x.com"),
      u("u2", "a@x.com"),
      u("u3", "a@x.com"),
    ]);
    expect(result).toEqual([
      { email: ne("a@x.com"), userIds: ["u1", "u2", "u3"] },
    ]);
  });

  it("正規化後に重複する email を検出する (大文字小文字)", () => {
    const result = detectDuplicateUsers([
      u("u1", "Alice@x.com"),
      u("u2", "ALICE@x.com"),
    ]);
    expect(result).toEqual([
      { email: ne("alice@x.com"), userIds: ["u1", "u2"] },
    ]);
  });

  it("空 email / null は skip", () => {
    const result = detectDuplicateUsers([
      u("u1", ""),
      u("u2", null),
      u("u3", "a@x.com"),
    ]);
    expect(result).toEqual([]);
  });

  it("Gmail dot trick negative: a.l.i.c.e@gmail.com と alice@gmail.com は別扱い", () => {
    // toNormalizedEmail は trim+toLowerCase のみ。Gmail dot 正規化はしない。
    const result = detectDuplicateUsers([
      u("u1", "a.l.i.c.e@gmail.com"),
      u("u2", "alice@gmail.com"),
    ]);
    expect(result).toEqual([]);
  });
});

describe("planAudit duplicateUsers 出力 (Issue #281)", () => {
  it("重複 users があれば duplicateUsers に primary + 漏れた id をまとめて出力", () => {
    const report = planAudit(
      [
        u("u1", "alice@x.com"),
        u("u2", "alice@x.com"),
        u("u3", "alice@x.com"),
      ],
      [],
      []
    );
    expect(report.duplicateUsers).toEqual([
      { email: ne("alice@x.com"), userIds: ["u1", "u2", "u3"] },
    ]);
  });

  it("重複がなければ duplicateUsers は空配列", () => {
    const report = planAudit([u("u1", "alice@x.com")], [], []);
    expect(report.duplicateUsers).toEqual([]);
  });

  it("重複 users がいても matched は primary のみ", () => {
    const report = planAudit(
      [u("u1", "alice@x.com"), u("u2", "alice@x.com")],
      [{ id: "ae1", email: "alice@x.com" }],
      []
    );
    expect(report.matched).toEqual([
      {
        userId: "u1",
        firebaseUid: undefined,
        email: ne("alice@x.com"),
        allowedEmailId: "ae1",
      },
    ]);
    expect(report.duplicateUsers).toEqual([
      { email: ne("alice@x.com"), userIds: ["u1", "u2"] },
    ]);
  });

  it("invalid + valid 混在: invalid は invalid に、valid 重複は duplicateUsers に", () => {
    const report = planAudit(
      [
        u("u1", "alice@x.com"),
        u("u2", null),
        u("u3", "alice@x.com"),
        u("u4", ""),
      ],
      [],
      []
    );
    expect(report.invalid).toEqual([
      { kind: "user", id: "u2", reason: "email が空または null" },
      { kind: "user", id: "u4", reason: "email が空または null" },
    ]);
    expect(report.duplicateUsers).toEqual([
      { email: ne("alice@x.com"), userIds: ["u1", "u3"] },
    ]);
  });
});
