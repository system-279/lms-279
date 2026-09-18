/**
 * chat-notify.ts の単体テスト (PR3、配信可視化)。
 *
 * 観点:
 *   - maskPii: メールアドレス・長い数字列・Bearer トークンをマスクする
 *   - buildDeliveryReportText: outcome 別の見出し・runId/occurrenceId 相関・
 *     テナント名への maskPii 適用
 *   - postToChat: 成功/Secret 取得失敗/非2xx/fetch 例外いずれも throw しない
 *   - createChatNotifier: postToChat の結果を {ok} に写す
 *   - notifyDispatchResult: 完了通知/進捗レポート両レーン共通の通知ヘルパー
 *     (pr-review-toolkit code-reviewer 指摘反映、両レーンの重複ロジックを一本化)
 */

import { describe, it, expect, vi } from "vitest";

import {
  maskPii,
  buildDeliveryReportText,
  postToChat,
  createChatNotifier,
  notifyDispatchResult,
  type DispatchNotifyInput,
  type NotifyDispatchResultInput,
} from "../chat-notify.js";

describe("maskPii", () => {
  it("メールアドレスをマスクする", () => {
    expect(maskPii("担当: yamada@example.com です")).toBe("担当: y***@example.com です");
  });

  it("長い数字列 (電話番号等) をマスクする", () => {
    expect(maskPii("連絡先: 090-1234-5678")).toBe("連絡先: 09***78");
  });

  it("Bearer トークンをマスクする", () => {
    expect(maskPii("Authorization: Bearer abc123.def456-ghi")).toBe(
      "Authorization: Bearer ***",
    );
  });

  it("PII を含まない文字列はそのまま返す", () => {
    expect(maskPii("株式会社サンプル")).toBe("株式会社サンプル");
  });

  it("undefined は空文字列を返す", () => {
    expect(maskPii(undefined)).toBe("");
  });

  it("任意の文字列 (fuzz 的な複数ケース) に許可外パターンが残らない", () => {
    const samples = [
      "テナントA (contact: info@tenant-a.co.jp / tel:03-1234-5678)",
      "Bearer ya29.a0Ab.superlongtoken_here-1234",
      "090 1234 5678 が緊急連絡先です",
    ];
    for (const s of samples) {
      const masked = maskPii(s);
      expect(masked).not.toMatch(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/);
      expect(masked).not.toMatch(/Bearer\s+[A-Za-z0-9._-]{10,}/);
      expect(masked).not.toMatch(/\d[\d\-\s]{7,}\d/);
    }
  });
});

function makeInput(partial: Partial<DispatchNotifyInput> = {}): DispatchNotifyInput {
  return {
    outcome: "completed",
    lane: "completion",
    runId: "run-1",
    totalSent: 3,
    totalFailed: 0,
    totalManualReviewRequired: 0,
    perTenant: [
      { tenantId: "t1", tenantName: "テナントA", sent: 3, failed: 0, manualReviewRequired: 0 },
    ],
    ...partial,
  };
}

describe("buildDeliveryReportText", () => {
  it("completed → 見出しに 【中断】/【異常終了】 が付かない", () => {
    const text = buildDeliveryReportText(makeInput());
    expect(text).not.toContain("【中断】");
    expect(text).not.toContain("【異常終了】");
    expect(text).toContain("【完了通知】");
    expect(text).toContain("runId=run-1");
  });

  it("aborted → 見出しに 【中断】 が付き、abortedReason が本文に含まれる", () => {
    const text = buildDeliveryReportText(
      makeInput({ outcome: "aborted", abortedReason: "gmail_scope_revoked" }),
    );
    expect(text).toContain("【中断】");
    expect(text).toContain("gmail_scope_revoked");
  });

  it("unexpected_error → 見出しに 【異常終了】 が付く", () => {
    const text = buildDeliveryReportText(makeInput({ outcome: "unexpected_error" }));
    expect(text).toContain("【異常終了】");
  });

  it("progress レーンでは occurrenceId が本文に含まれる (retry 相関用)", () => {
    const text = buildDeliveryReportText(
      makeInput({ lane: "progress", occurrenceId: "occ-abc" }),
    );
    expect(text).toContain("【進捗レポート】");
    expect(text).toContain("occurrenceId=occ-abc");
  });

  it("テナント名にメールアドレスが混入していても maskPii が適用される", () => {
    const text = buildDeliveryReportText(
      makeInput({
        perTenant: [
          {
            tenantId: "t1",
            tenantName: "テナントA (contact: leak@example.com)",
            sent: 1,
            failed: 0,
            manualReviewRequired: 0,
          },
        ],
      }),
    );
    expect(text).not.toContain("leak@example.com");
    expect(text).toContain("l***@example.com");
  });

  it("合計件数 (成功/失敗/要確認) が本文に含まれる", () => {
    const text = buildDeliveryReportText(
      makeInput({ totalSent: 5, totalFailed: 2, totalManualReviewRequired: 1 }),
    );
    expect(text).toContain("5 件成功");
    expect(text).toContain("2 件失敗");
    expect(text).toContain("1 件要確認");
  });
});

describe("postToChat", () => {
  it("成功 (2xx) → {ok:true, status}", async () => {
    const fetchImpl = vi.fn().mockResolvedValue({ ok: true, status: 200 });
    const getSecret = vi.fn().mockResolvedValue("https://chat.googleapis.com/webhook-url");
    const result = await postToChat("hello", "secret-name", { fetchImpl, getSecret });
    expect(result).toEqual({ ok: true, status: 200 });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("Secret 取得失敗 → throw せず {ok:false}", async () => {
    const fetchImpl = vi.fn();
    const getSecret = vi.fn().mockRejectedValue(new Error("secret not found"));
    const result = await postToChat("hello", "secret-name", { fetchImpl, getSecret });
    expect(result).toEqual({ ok: false });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("非2xx レスポンス → throw せず {ok:false, status}", async () => {
    const fetchImpl = vi.fn().mockResolvedValue({ ok: false, status: 404 });
    const getSecret = vi.fn().mockResolvedValue("https://chat.googleapis.com/webhook-url");
    const result = await postToChat("hello", "secret-name", { fetchImpl, getSecret });
    expect(result).toEqual({ ok: false, status: 404 });
  });

  it("fetch 例外 → throw せず {ok:false}", async () => {
    const fetchImpl = vi.fn().mockRejectedValue(new Error("network error"));
    const getSecret = vi.fn().mockResolvedValue("https://chat.googleapis.com/webhook-url");
    const result = await postToChat("hello", "secret-name", { fetchImpl, getSecret });
    expect(result).toEqual({ ok: false });
  });

  it("4000字超のテキストは truncate される", async () => {
    let sentBody = "";
    const fetchImpl = vi.fn().mockImplementation((_url, init: RequestInit) => {
      sentBody = String(init.body);
      return Promise.resolve({ ok: true, status: 200 });
    });
    const getSecret = vi.fn().mockResolvedValue("https://chat.googleapis.com/webhook-url");
    await postToChat("x".repeat(5000), "secret-name", { fetchImpl, getSecret });
    const parsed = JSON.parse(sentBody) as { text: string };
    expect(parsed.text.length).toBeLessThanOrEqual(4000);
    expect(parsed.text).toContain("...(truncated)");
  });
});

describe("createChatNotifier", () => {
  it("postToChat の結果を {ok} に写す (deps 注入で実 GCP/fetch への疎通なしに検証)", async () => {
    const fetchImpl = vi.fn().mockResolvedValue({ ok: true, status: 200 });
    const getSecret = vi.fn().mockResolvedValue("https://chat.googleapis.com/webhook-url");
    const notifier = createChatNotifier("dummy-secret-name", { fetchImpl, getSecret });
    const result = await notifier(makeInput());
    expect(result).toEqual({ ok: true });
    expect(getSecret).toHaveBeenCalledWith("dummy-secret-name");
  });

  it("Secret 取得失敗でも throw せず {ok:false} を返す", async () => {
    const fetchImpl = vi.fn();
    const getSecret = vi.fn().mockRejectedValue(new Error("secret not found"));
    const notifier = createChatNotifier("dummy-secret-name", { fetchImpl, getSecret });
    const result = await notifier(makeInput());
    expect(result).toEqual({ ok: false });
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

function makeNotifyInput(
  partial: Partial<NotifyDispatchResultInput> = {},
): NotifyDispatchResultInput {
  return {
    notifier: vi.fn().mockResolvedValue({ ok: true }),
    outcome: "completed",
    lane: "completion",
    runId: "run-1",
    totalSent: 1,
    totalFailed: 0,
    totalManualReviewRequired: 0,
    perTenant: [
      { tenantId: "t1", tenantName: "テナントA", sent: 1, failed: 0, manualReviewRequired: 0 },
    ],
    ...partial,
  };
}

describe("notifyDispatchResult (完了通知/進捗レポート共通ヘルパー)", () => {
  it("notifier 未注入 (undefined) → 何もしない", async () => {
    const input = makeNotifyInput({ notifier: undefined });
    await notifyDispatchResult(input);
    // 例外を投げず完了することのみを検証 (notifier が無いので呼び出し先が無い)
  });

  it("成功 (completed) かつ全カウント0 → notifier を呼ばない (0件スキップ)", async () => {
    const notifier = vi.fn().mockResolvedValue({ ok: true });
    await notifyDispatchResult(
      makeNotifyInput({
        notifier,
        totalSent: 0,
        totalFailed: 0,
        totalManualReviewRequired: 0,
        perTenant: [],
      }),
    );
    expect(notifier).not.toHaveBeenCalled();
  });

  it("成功 (completed) かつ sent=0 だが manualReviewRequired>0 → 0件スキップの対象外で notifier が呼ばれる (test-analyzer 指摘反映)", async () => {
    const notifier = vi.fn().mockResolvedValue({ ok: true });
    await notifyDispatchResult(
      makeNotifyInput({
        notifier,
        totalSent: 0,
        totalFailed: 0,
        totalManualReviewRequired: 1,
        perTenant: [
          { tenantId: "t1", tenantName: "テナントA", sent: 0, failed: 0, manualReviewRequired: 1 },
        ],
      }),
    );
    expect(notifier).toHaveBeenCalledTimes(1);
  });

  it("成功 (completed) かつ sent=0 だが failed>0 → 0件スキップの対象外で notifier が呼ばれる", async () => {
    const notifier = vi.fn().mockResolvedValue({ ok: true });
    await notifyDispatchResult(
      makeNotifyInput({
        notifier,
        totalSent: 0,
        totalFailed: 1,
        totalManualReviewRequired: 0,
        perTenant: [
          { tenantId: "t1", tenantName: "テナントA", sent: 0, failed: 1, manualReviewRequired: 0 },
        ],
      }),
    );
    expect(notifier).toHaveBeenCalledTimes(1);
  });

  it("aborted かつ全カウント0 → 0件スキップは適用されず notifier が呼ばれる", async () => {
    const notifier = vi.fn().mockResolvedValue({ ok: true });
    await notifyDispatchResult(
      makeNotifyInput({
        notifier,
        outcome: "aborted",
        totalSent: 0,
        totalFailed: 0,
        totalManualReviewRequired: 0,
        perTenant: [],
        abortedReason: "gmail_scope_revoked",
      }),
    );
    expect(notifier).toHaveBeenCalledTimes(1);
  });

  it("perTenant は件数0のテナントを除外して notifier に渡す", async () => {
    const notifier = vi.fn().mockResolvedValue({ ok: true });
    await notifyDispatchResult(
      makeNotifyInput({
        notifier,
        perTenant: [
          { tenantId: "t1", tenantName: "A", sent: 1, failed: 0, manualReviewRequired: 0 },
          { tenantId: "t2", tenantName: "B", sent: 0, failed: 0, manualReviewRequired: 0 },
        ],
      }),
    );
    const call = notifier.mock.calls[0][0] as DispatchNotifyInput;
    expect(call.perTenant.map((t) => t.tenantId)).toEqual(["t1"]);
  });

  it("notifier が {ok:false} を返す → runId/lane/outcome/occurrenceId 付きで warn ログが残る (silent-failure-hunter Medium 反映)", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const notifier = vi.fn().mockResolvedValue({ ok: false });
    await notifyDispatchResult(
      makeNotifyInput({ notifier, lane: "progress", runId: "run-abc", occurrenceId: "occ-1" }),
    );
    expect(warnSpy).toHaveBeenCalledTimes(1);
    const logged = JSON.parse((warnSpy.mock.calls[0] as [string])[0]) as Record<string, unknown>;
    expect(logged).toMatchObject({
      runId: "run-abc",
      lane: "progress",
      outcome: "completed",
      occurrenceId: "occ-1",
    });
    warnSpy.mockRestore();
  });

  it("notifier が reject する → runId/lane/outcome 付きで error ログが残り、run 自体は例外を投げない", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const notifier = vi.fn().mockRejectedValue(new Error("chat webhook down"));
    await expect(
      notifyDispatchResult(
        makeNotifyInput({ notifier, outcome: "unexpected_error", runId: "run-xyz" }),
      ),
    ).resolves.toBeUndefined();
    expect(errorSpy).toHaveBeenCalledTimes(1);
    const logged = JSON.parse((errorSpy.mock.calls[0] as [string])[0]) as Record<string, unknown>;
    expect(logged).toMatchObject({ runId: "run-xyz", lane: "completion", outcome: "unexpected_error" });
    errorSpy.mockRestore();
  });
});
