import { describe, it, expect } from "vitest";
import {
  maskPii,
  stripQuery,
  sanitizePathForDisplay,
  extractTenantId,
  topStackFrames,
  buildErrorAlertText,
  buildHealthReportText,
  buildAvailabilityAlertText,
  buildFlushSummaryText,
} from "../chat-payload-allowlist.js";

describe("maskPii", () => {
  it("メールアドレスをマスクする", () => {
    expect(maskPii("user not found: taro.yamada@example.com")).toBe(
      "user not found: t***@example.com"
    );
  });

  it("複数のメールアドレスをすべてマスクする", () => {
    expect(maskPii("a@example.com and b@example.co.jp")).toBe(
      "a***@example.com and b***@example.co.jp"
    );
  });

  it("Bearerトークンをマスクする", () => {
    expect(maskPii("Authorization: Bearer abc123.def456-ghi")).toBe(
      "Authorization: Bearer ***"
    );
  });

  it("9桁以上の数字列をマスクする（先頭2桁・末尾2桁のみ残す）", () => {
    expect(maskPii("phone: 09012345678")).toBe("phone: 09***78");
  });

  it("8桁以下の数字列はマスクしない（誤検知抑制）", () => {
    expect(maskPii("count: 12345678")).toBe("count: 12345678");
  });

  it("ハイフン区切りの電話番号もマスクする", () => {
    expect(maskPii("tel: 090-1234-5678")).toBe("tel: 09***78");
  });

  it("短い数値の範囲表記(誤検知しやすい形)はマスクしない", () => {
    expect(maskPii("range: 100-200")).toBe("range: 100-200");
  });

  it("PIIを含まない文字列はそのまま返す", () => {
    expect(maskPii("TypeError: Cannot read property")).toBe(
      "TypeError: Cannot read property"
    );
  });

  it("undefined/空文字は空文字を返す", () => {
    expect(maskPii(undefined)).toBe("");
    expect(maskPii("")).toBe("");
  });
});

describe("stripQuery", () => {
  it("クエリ文字列を除去する", () => {
    expect(stripQuery("/api/v2/tenant-a/users?email=foo@example.com")).toBe(
      "/api/v2/tenant-a/users"
    );
  });

  it("クエリが無ければそのまま返す", () => {
    expect(stripQuery("/api/v2/tenant-a/users")).toBe("/api/v2/tenant-a/users");
  });

  it("undefinedはundefinedを返す", () => {
    expect(stripQuery(undefined)).toBeUndefined();
  });
});

describe("sanitizePathForDisplay", () => {
  it("既知の静的セグメントは残し、可変セグメントは<id>に畳む", () => {
    expect(sanitizePathForDisplay("/api/v2/tenant-a/courses")).toBe("/api/v2/<id>/courses");
  });

  it("メールアドレスセグメントも<id>に畳む", () => {
    expect(sanitizePathForDisplay("/api/v2/super/admins/foo@example.com")).toBe(
      "/api/v2/super/admins/<id>"
    );
  });

  it("URLエンコードされたセグメントもデコードしてから判定する", () => {
    expect(sanitizePathForDisplay("/api/v2/super/admins/foo%40example.com")).toBe(
      "/api/v2/super/admins/<id>"
    );
  });

  it("複数の可変セグメントを含むパスも全て畳む", () => {
    expect(
      sanitizePathForDisplay("/api/v2/super/tenants/tenant-a/student-progress/lesson1/user1")
    ).toBe("/api/v2/super/tenants/<id>/student-progress/<id>/<id>");
  });

  it("undefinedはundefinedを返す", () => {
    expect(sanitizePathForDisplay(undefined)).toBeUndefined();
  });
});

describe("extractTenantId", () => {
  it("/api/v2/:tenant/... からtenant IDを抽出する", () => {
    expect(extractTenantId("/api/v2/tenant-a/courses")).toBe("tenant-a");
  });

  it("public/super/demo は tenant ID として扱わない", () => {
    expect(extractTenantId("/api/v2/public/courses")).toBeUndefined();
    expect(extractTenantId("/api/v2/super/tenants")).toBeUndefined();
    expect(extractTenantId("/api/v2/demo/courses")).toBeUndefined();
  });

  it("パターンに一致しない場合はundefined", () => {
    expect(extractTenantId("/health")).toBeUndefined();
    expect(extractTenantId(undefined)).toBeUndefined();
  });
});

describe("topStackFrames", () => {
  it("先頭n行を返す", () => {
    const stack = "Error: boom\n  at foo (a.ts:1:1)\n  at bar (b.ts:2:2)\n  at baz (c.ts:3:3)";
    expect(topStackFrames(stack, 2)).toEqual(["Error: boom", "at foo (a.ts:1:1)"]);
  });

  it("空行を除去する", () => {
    expect(topStackFrames("a\n\nb", 5)).toEqual(["a", "b"]);
  });

  it("undefinedは空配列を返す", () => {
    expect(topStackFrames(undefined, 5)).toEqual([]);
  });
});

describe("buildErrorAlertText", () => {
  it("許可フィールドのみを含み、messageとstackはマスクされる", () => {
    const text = buildErrorAlertText({
      timestamp: "2026-09-02T00:00:00.000Z",
      errorName: "TypeError",
      message: "failed for user@example.com",
      method: "POST",
      path: "/api/v2/tenant-a/quizzes",
      tenantId: "tenant-a",
      stackFrames: ["at handler (x.ts:1:1) user@example.com"],
      loggingLink: "https://console.cloud.google.com/logs/x",
      suppressedSincePrevious: 3,
    });
    expect(text).toContain("TypeError");
    // tenant-a は既知の静的セグメントではないため <id> に畳まれる（PII対策）
    expect(text).toContain("POST /api/v2/<id>/quizzes");
    expect(text).not.toContain("tenant-a/quizzes");
    expect(text).toContain("tenant: tenant-a");
    expect(text).toContain("u***@example.com");
    expect(text).not.toContain("user@example.com");
    expect(text).toContain("（前ウィンドウで3件抑制）");
    expect(text).toContain("https://console.cloud.google.com/logs/x");
  });

  it("pathにメールアドレスや受講者IDが含まれていても<id>に畳まれ本文に残らない", () => {
    const text = buildErrorAlertText({
      timestamp: "2026-09-02T00:00:00.000Z",
      errorName: "NotFoundError",
      message: "admin not found",
      method: "GET",
      path: "/api/v2/super/admins/foo@example.com",
      stackFrames: [],
    });
    expect(text).toContain("GET /api/v2/super/admins/<id>");
    expect(text).not.toContain("foo@example.com");
    expect(text).not.toContain("foo***@example.com"); // マスク後の形跡すら残らない(セグメント自体を畳むため)
  });

  it("suppressedSincePreviousが0の場合は抑制行を含まない", () => {
    const text = buildErrorAlertText({
      timestamp: "2026-09-02T00:00:00.000Z",
      errorName: "Error",
      message: "boom",
      stackFrames: [],
    });
    expect(text).not.toContain("抑制");
  });
});

describe("buildHealthReportText", () => {
  it("okステータスは非エンジニア向けの平易な一文のみ（専門用語・生メトリクスを含まない）", () => {
    const text = buildHealthReportText({
      date: "2026-09-02",
      status: "ok",
      firestoreStatus: "ok",
      heapUsedMB: 42,
    });
    expect(text).toBe("✅ LMS は正常に稼働しています（2026-09-02）");
    expect(text).not.toContain("firestore");
    expect(text).not.toContain("heapUsed");
  });

  it("degradedステータスは⚠️アイコン + 平易な言い換え + 技術的補足を併記する", () => {
    const text = buildHealthReportText({
      date: "2026-09-02",
      status: "degraded",
      firestoreStatus: "error",
      heapUsedMB: 42,
    });
    expect(text).toContain("⚠️");
    expect(text).toContain("データベース接続: 異常の可能性あり");
    expect(text).toContain("firestore: error");
    expect(text).toContain("メモリ使用量（参考値）: 42MB");
  });

  it("errorステータスは🔴アイコン", () => {
    const text = buildHealthReportText({
      date: "2026-09-02",
      status: "error",
      firestoreStatus: "unknown",
      detail: "connect ECONNREFUSED",
    });
    expect(text).toContain("🔴");
    expect(text).toContain("データベース接続: 異常の可能性あり");
    expect(text).toContain("connect ECONNREFUSED");
  });
});

describe("buildAvailabilityAlertText", () => {
  it("OPEN状態は🔴アイコン", () => {
    const text = buildAvailabilityAlertText({
      state: "OPEN",
      policyName: "LMS API 5xx Error Rate",
      summary: "5xx errors exceeded threshold",
    });
    expect(text).toContain("🔴");
    expect(text).toContain("LMS API 5xx Error Rate");
  });

  it("CLOSED状態は✅アイコン", () => {
    const text = buildAvailabilityAlertText({
      state: "CLOSED",
      policyName: "LMS API 5xx Error Rate",
      summary: "resolved",
    });
    expect(text).toContain("✅");
  });
});

describe("buildFlushSummaryText", () => {
  it("抑制件数を含む", () => {
    const text = buildFlushSummaryText("fingerprint: abc123", 4);
    expect(text).toContain("4 件抑制");
  });
});
