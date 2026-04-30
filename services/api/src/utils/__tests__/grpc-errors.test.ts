import { describe, it, expect } from "vitest";
import { classifyFirestoreError } from "../grpc-errors.js";

describe("classifyFirestoreError", () => {
  it("数値形式 14 (UNAVAILABLE) → transient", () => {
    expect(classifyFirestoreError({ code: 14 })).toEqual({ grpcCode: 14, isTransient: true });
  });

  it("数値形式 4 (DEADLINE_EXCEEDED) → transient", () => {
    expect(classifyFirestoreError({ code: 4 })).toEqual({ grpcCode: 4, isTransient: true });
  });

  it('文字列形式 "unavailable" → transient', () => {
    expect(classifyFirestoreError({ code: "unavailable" })).toEqual({
      grpcCode: "unavailable",
      isTransient: true,
    });
  });

  it('文字列形式 "deadline-exceeded" → transient', () => {
    expect(classifyFirestoreError({ code: "deadline-exceeded" })).toEqual({
      grpcCode: "deadline-exceeded",
      isTransient: true,
    });
  });

  it("数値形式 7 (PERMISSION_DENIED) → permanent", () => {
    expect(classifyFirestoreError({ code: 7 })).toEqual({ grpcCode: 7, isTransient: false });
  });

  it('文字列形式 "permission-denied" → permanent', () => {
    expect(classifyFirestoreError({ code: "permission-denied" })).toEqual({
      grpcCode: "permission-denied",
      isTransient: false,
    });
  });

  it("code 無しのエラー → permanent (undefined)", () => {
    expect(classifyFirestoreError(new Error("plain"))).toEqual({
      grpcCode: undefined,
      isTransient: false,
    });
  });

  it("null / undefined / 文字列入力 → permanent (undefined)", () => {
    expect(classifyFirestoreError(null)).toEqual({ grpcCode: undefined, isTransient: false });
    expect(classifyFirestoreError(undefined)).toEqual({ grpcCode: undefined, isTransient: false });
    expect(classifyFirestoreError("not an error")).toEqual({ grpcCode: undefined, isTransient: false });
  });
});
