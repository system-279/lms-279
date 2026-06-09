import { describe, expect, it } from "vitest";
import {
  EXIT_REASON_NONE_VALUE,
  matchesExitReasonFilter,
} from "../_helpers/exit-reason-filter";

// ADR-027 で定義された退室理由 enum 値。本 sentinel が将来追加される値と衝突しないことを保証する。
// page.tsx 内 EXIT_REASON_LABELS と同期して保守する。
const SERVER_EXIT_REASON_KEYS = [
  "quiz_submitted",
  "pause_timeout",
  "time_limit",
  "browser_close",
  "max_attempts_failed",
] as const;

describe("EXIT_REASON_NONE_VALUE sentinel", () => {
  it("既存の退室理由 enum 値と衝突しない (silent failure regression guard)", () => {
    // 将来 ADR-027 に新しい退室理由値が追加された際、sentinel と同名にしないこと。
    // 衝突すると null セッションと「その新理由」が誤マッチする silent failure になる。
    expect(SERVER_EXIT_REASON_KEYS as readonly string[]).not.toContain(EXIT_REASON_NONE_VALUE);
  });

  it("__ プレフィックスで明確に内部 sentinel と識別できる", () => {
    expect(EXIT_REASON_NONE_VALUE.startsWith("__")).toBe(true);
  });
});

describe("matchesExitReasonFilter", () => {
  describe("退室理由が確定しているレコード", () => {
    it("選択された退室理由にマッチする", () => {
      const selected = new Set(["quiz_submitted", "time_limit"]);
      expect(matchesExitReasonFilter("quiz_submitted", selected)).toBe(true);
      expect(matchesExitReasonFilter("time_limit", selected)).toBe(true);
    });

    it("選択されていない退室理由はマッチしない", () => {
      const selected = new Set(["quiz_submitted"]);
      expect(matchesExitReasonFilter("time_limit", selected)).toBe(false);
      expect(matchesExitReasonFilter("pause_timeout", selected)).toBe(false);
    });

    it("null sentinel しか選択されていない場合、確定済み退室理由はマッチしない", () => {
      const selected = new Set([EXIT_REASON_NONE_VALUE]);
      expect(matchesExitReasonFilter("quiz_submitted", selected)).toBe(false);
      expect(matchesExitReasonFilter("time_limit", selected)).toBe(false);
    });
  });

  describe("exitReason が null (在室中 / 未確定)", () => {
    it("EXIT_REASON_NONE_VALUE が選択されていればマッチする (#532 fix)", () => {
      const selected = new Set([EXIT_REASON_NONE_VALUE]);
      expect(matchesExitReasonFilter(null, selected)).toBe(true);
    });

    it("EXIT_REASON_NONE_VALUE が未選択ならマッチしない (旧挙動と互換)", () => {
      const selected = new Set(["quiz_submitted", "time_limit", "pause_timeout"]);
      expect(matchesExitReasonFilter(null, selected)).toBe(false);
    });

    it("空セットの場合はマッチしない (呼び出し側で size > 0 ガード前提)", () => {
      const selected = new Set<string>();
      expect(matchesExitReasonFilter(null, selected)).toBe(false);
    });

    it("確定済みと null sentinel の両方が選択されていれば null もマッチする", () => {
      const selected = new Set(["quiz_submitted", EXIT_REASON_NONE_VALUE]);
      expect(matchesExitReasonFilter(null, selected)).toBe(true);
      expect(matchesExitReasonFilter("quiz_submitted", selected)).toBe(true);
      expect(matchesExitReasonFilter("time_limit", selected)).toBe(false);
    });
  });
});
