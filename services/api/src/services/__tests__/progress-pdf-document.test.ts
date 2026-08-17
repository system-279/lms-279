/**
 * progress-pdf-document の font / style 仕様の退行防止テスト。
 *
 * PR #393 review (silent-failure-hunter C1) で「Variable Font の `fontWeight: 500`
 * 別登録は @react-pdf/font の getVariation 未実装で no-op」が判明したため、
 * 登録する weight 一覧を export しておき、想定外の weight が増減したら
 * CI で検知できるよう pin する。
 */

import { describe, it, expect } from "vitest";
import {
  REGISTERED_FONT_WEIGHTS,
  computeLessonCheckMark,
  computeLessonDetail,
  computeQuizScoreRow,
} from "../progress-pdf-document.js";

describe("REGISTERED_FONT_WEIGHTS (Variable Font weight 仕様 pin)", () => {
  it("Regular (400) と Bold (700) のみを登録する", () => {
    // 500 (Medium) 等の中間 weight は Variable Font 補間が効かないため登録しない
    expect(REGISTERED_FONT_WEIGHTS).toEqual([400, 700]);
  });

  it("Bold (700) が登録されていること (本文値の濃度を担保)", () => {
    expect(REGISTERED_FONT_WEIGHTS).toContain(700);
  });
});

// -----------------------------------------------
// テスト任意化（quizSkipped）が進捗PDFの表示ロジックに正しく反映されるかの回帰テスト。
// codex review 指摘: quizSkipped 追加当初、PDF側は quizPassed のみを見ており
// スキップ済みレッスンが「未受験」と誤表示されていた。
// -----------------------------------------------

describe("computeLessonCheckMark", () => {
  it("lessonCompleted=true なら常に✓", () => {
    expect(
      computeLessonCheckMark({ lessonCompleted: true, videoCompleted: true, quizPassed: false, quizSkipped: false })
    ).toBe("✓");
  });

  it("動画完了+テストスキップ（未完了）なら△", () => {
    expect(
      computeLessonCheckMark({ lessonCompleted: false, videoCompleted: true, quizPassed: false, quizSkipped: true })
    ).toBe("△");
  });

  it("何も進んでいなければ□", () => {
    expect(
      computeLessonCheckMark({ lessonCompleted: false, videoCompleted: false, quizPassed: false, quizSkipped: false })
    ).toBe("□");
  });
});

describe("computeLessonDetail", () => {
  it("テストスキップ時は「テスト―(スキップ)」を表示する（「テスト□」＝未受験と誤読させない）", () => {
    const detail = computeLessonDetail({
      hasVideo: true,
      hasQuiz: true,
      videoCompleted: true,
      quizPassed: false,
      quizSkipped: true,
    });
    expect(detail).toEqual(["動画✓", "テスト―(スキップ)"]);
  });

  it("テスト合格時は「テスト✓」", () => {
    const detail = computeLessonDetail({
      hasVideo: true,
      hasQuiz: true,
      videoCompleted: true,
      quizPassed: true,
      quizSkipped: false,
    });
    expect(detail).toEqual(["動画✓", "テスト✓"]);
  });

  it("未受験（スキップでも合格でもない）時は「テスト□」", () => {
    const detail = computeLessonDetail({
      hasVideo: true,
      hasQuiz: true,
      videoCompleted: true,
      quizPassed: false,
      quizSkipped: false,
    });
    expect(detail).toEqual(["動画✓", "テスト□"]);
  });
});

describe("computeQuizScoreRow", () => {
  it("スキップ時は「―(スキップ)」を表示し、未受験と区別する", () => {
    const row = computeQuizScoreRow({ quizBestScore: null, quizPassed: false, quizSkipped: true });
    expect(row.mark).toBe("―");
    expect(row.meta).toBe("―(スキップ)");
  });

  it("合格時は得点+「合格」を表示する", () => {
    const row = computeQuizScoreRow({ quizBestScore: 90, quizPassed: true, quizSkipped: false });
    expect(row.mark).toBe("✓");
    expect(row.meta).toBe("90点 合格");
  });

  it("未受験時は「未受験」を表示する", () => {
    const row = computeQuizScoreRow({ quizBestScore: null, quizPassed: false, quizSkipped: false });
    expect(row.mark).toBe("□");
    expect(row.meta).toBe("未受験");
  });
});
