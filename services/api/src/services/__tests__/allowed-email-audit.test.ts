import { describe, it, expect } from "vitest";
import {
  planAudit,
  buildAuditFixNote,
  type AuditUserInput,
  type AuditAllowedEmailInput,
} from "../allowed-email-audit.js";

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
