/**
 * progress-pdf-document の font / style 仕様の退行防止テスト。
 *
 * PR #393 review (silent-failure-hunter C1) で「Variable Font の `fontWeight: 500`
 * 別登録は @react-pdf/font の getVariation 未実装で no-op」が判明したため、
 * 登録する weight 一覧を export しておき、想定外の weight が増減したら
 * CI で検知できるよう pin する。
 */

import { describe, it, expect } from "vitest";
import { REGISTERED_FONT_WEIGHTS } from "../progress-pdf-document.js";

describe("REGISTERED_FONT_WEIGHTS (Variable Font weight 仕様 pin)", () => {
  it("Regular (400) と Bold (700) のみを登録する", () => {
    // 500 (Medium) 等の中間 weight は Variable Font 補間が効かないため登録しない
    expect(REGISTERED_FONT_WEIGHTS).toEqual([400, 700]);
  });

  it("Bold (700) が登録されていること (本文値の濃度を担保)", () => {
    expect(REGISTERED_FONT_WEIGHTS).toContain(700);
  });
});
