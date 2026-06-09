import { describe, expect, it } from "vitest";
import {
  EXIT_REASON_NONE_VALUE,
  matchesExitReasonFilter,
} from "../_helpers/exit-reason-filter";

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
