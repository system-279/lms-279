import { describe, it, expect } from "vitest";
import { gradeQuiz, randomizeQuiz, stripCorrectAnswers } from "../quiz-grading.js";

// -----------------------------------------------
// テストデータ型（quiz-grading.ts のローカル型に合わせる）
// -----------------------------------------------

interface QuizOption {
  id: string;
  text: string;
  isCorrect: boolean;
}

interface QuizQuestion {
  id: string;
  text: string;
  type: "single" | "multi";
  options: QuizOption[];
  points: number;
  explanation: string;
}

// -----------------------------------------------
// テストデータヘルパー
// -----------------------------------------------

function makeSingleQuestion(
  id: string,
  correctOptionId: string,
  allOptionIds: string[],
  points = 10
): QuizQuestion {
  return {
    id,
    text: `Question ${id}`,
    type: "single",
    options: allOptionIds.map((oid) => ({
      id: oid,
      text: `Option ${oid}`,
      isCorrect: oid === correctOptionId,
    })),
    points,
    explanation: `Explanation for ${id}`,
  };
}

function makeMultiQuestion(
  id: string,
  correctOptionIds: string[],
  allOptionIds: string[],
  points = 10
): QuizQuestion {
  return {
    id,
    text: `Question ${id}`,
    type: "multi",
    options: allOptionIds.map((oid) => ({
      id: oid,
      text: `Option ${oid}`,
      isCorrect: correctOptionIds.includes(oid),
    })),
    points,
    explanation: `Explanation for ${id}`,
  };
}

// -----------------------------------------------
// gradeQuiz
// -----------------------------------------------

describe("gradeQuiz", () => {
  it("全問正解 → score=100, isPassed=true", () => {
    const questions = [
      makeSingleQuestion("q1", "a", ["a", "b", "c"]),
      makeSingleQuestion("q2", "x", ["x", "y", "z"]),
    ];
    const answers: Record<string, string[]> = {
      q1: ["a"],
      q2: ["x"],
    };
    const result = gradeQuiz(questions, answers, 70);

    expect(result.score).toBe(100);
    expect(result.isPassed).toBe(true);
    expect(result.earnedPoints).toBe(20);
    expect(result.totalPoints).toBe(20);
    expect(result.questionResults).toHaveLength(2);
    expect(result.questionResults[0].isCorrect).toBe(true);
    expect(result.questionResults[1].isCorrect).toBe(true);
  });

  it("全問不正解 → score=0, isPassed=false", () => {
    const questions = [
      makeSingleQuestion("q1", "a", ["a", "b", "c"]),
      makeSingleQuestion("q2", "x", ["x", "y", "z"]),
    ];
    const answers: Record<string, string[]> = {
      q1: ["b"],
      q2: ["y"],
    };
    const result = gradeQuiz(questions, answers, 70);

    expect(result.score).toBe(0);
    expect(result.isPassed).toBe(false);
    expect(result.earnedPoints).toBe(0);
  });

  it("部分正解 → 正しいスコア計算", () => {
    const questions = [
      makeSingleQuestion("q1", "a", ["a", "b", "c"], 10),
      makeSingleQuestion("q2", "x", ["x", "y", "z"], 10),
      makeSingleQuestion("q3", "p", ["p", "q", "r"], 10),
    ];
    const answers: Record<string, string[]> = {
      q1: ["a"], // 正解
      q2: ["y"], // 不正解
      q3: ["p"], // 正解
    };
    const result = gradeQuiz(questions, answers, 70);

    // 20/30 = 66.67 → Math.round → 67
    expect(result.score).toBe(67);
    expect(result.isPassed).toBe(false);
    expect(result.earnedPoints).toBe(20);
    expect(result.totalPoints).toBe(30);
  });

  it("single type: 正解1つ選択 → 正解", () => {
    const questions = [makeSingleQuestion("q1", "a", ["a", "b", "c"])];
    const answers: Record<string, string[]> = { q1: ["a"] };
    const result = gradeQuiz(questions, answers, 70);

    expect(result.questionResults[0].isCorrect).toBe(true);
  });

  it("single type: 不正解を選択 → 不正解", () => {
    const questions = [makeSingleQuestion("q1", "a", ["a", "b", "c"])];
    const answers: Record<string, string[]> = { q1: ["b"] };
    const result = gradeQuiz(questions, answers, 70);

    expect(result.questionResults[0].isCorrect).toBe(false);
  });

  it("multi type: 全正解選択+不正解なし → 正解", () => {
    const questions = [makeMultiQuestion("q1", ["a", "b"], ["a", "b", "c"])];
    const answers: Record<string, string[]> = { q1: ["a", "b"] };
    const result = gradeQuiz(questions, answers, 70);

    expect(result.questionResults[0].isCorrect).toBe(true);
  });

  it("multi type: 正解の一部のみ選択 → 不正解", () => {
    const questions = [makeMultiQuestion("q1", ["a", "b"], ["a", "b", "c"])];
    const answers: Record<string, string[]> = { q1: ["a"] }; // bが未選択
    const result = gradeQuiz(questions, answers, 70);

    expect(result.questionResults[0].isCorrect).toBe(false);
  });

  it("multi type: 正解+不正解も選択 → 不正解", () => {
    const questions = [makeMultiQuestion("q1", ["a", "b"], ["a", "b", "c"])];
    const answers: Record<string, string[]> = { q1: ["a", "b", "c"] }; // c(不正解)も含む
    const result = gradeQuiz(questions, answers, 70);

    expect(result.questionResults[0].isCorrect).toBe(false);
  });

  it("passThreshold境界値: score=70でthreshold=70 → isPassed=true", () => {
    // 7/10問正解 = 70%
    const questions = Array.from({ length: 10 }, (_, i) =>
      makeSingleQuestion(`q${i}`, "a", ["a", "b"], 10)
    );
    const answers: Record<string, string[]> = {};
    for (let i = 0; i < 10; i++) {
      answers[`q${i}`] = i < 7 ? ["a"] : ["b"]; // 7問正解
    }
    const result = gradeQuiz(questions, answers, 70);

    expect(result.score).toBe(70);
    expect(result.isPassed).toBe(true);
  });

  it("passThreshold境界値: score=69でthreshold=70 → isPassed=false", () => {
    // 100問中69問正解 = 69%
    const questions = Array.from({ length: 100 }, (_, i) =>
      makeSingleQuestion(`q${i}`, "a", ["a", "b"], 1)
    );
    const answers: Record<string, string[]> = {};
    for (let i = 0; i < 100; i++) {
      answers[`q${i}`] = i < 69 ? ["a"] : ["b"]; // 69問正解
    }
    const result = gradeQuiz(questions, answers, 70);

    expect(result.score).toBe(69);
    expect(result.isPassed).toBe(false);
  });

  it("空questions → score=0, totalPoints=0", () => {
    const result = gradeQuiz([], {}, 70);

    expect(result.score).toBe(0);
    expect(result.totalPoints).toBe(0);
    expect(result.earnedPoints).toBe(0);
    expect(result.questionResults).toHaveLength(0);
  });

  it("未回答（answersにquestionIdなし） → 不正解扱い", () => {
    const questions = [makeSingleQuestion("q1", "a", ["a", "b", "c"])];
    const answers: Record<string, string[]> = {}; // q1 が未回答

    const result = gradeQuiz(questions, answers, 70);

    expect(result.questionResults[0].isCorrect).toBe(false);
    expect(result.questionResults[0].selectedOptionIds).toEqual([]);
    expect(result.score).toBe(0);
  });

  it("questionResults に correctOptionIds が含まれる", () => {
    const questions = [makeMultiQuestion("q1", ["a", "b"], ["a", "b", "c"])];
    const answers: Record<string, string[]> = { q1: ["a", "b"] };

    const result = gradeQuiz(questions, answers, 70);

    expect(result.questionResults[0].correctOptionIds).toEqual(
      expect.arrayContaining(["a", "b"])
    );
    expect(result.questionResults[0].correctOptionIds).toHaveLength(2);
  });
});

// -----------------------------------------------
// randomizeQuiz
// -----------------------------------------------

describe("randomizeQuiz", () => {
  const baseQuestions: QuizQuestion[] = [
    makeSingleQuestion("q1", "a", ["a", "b", "c"]),
    makeSingleQuestion("q2", "x", ["x", "y", "z"]),
    makeSingleQuestion("q3", "p", ["p", "q", "r"]),
  ];

  it("randomizeQuestions=false, randomizeAnswers=false → 元と同じ順序", () => {
    const result = randomizeQuiz(baseQuestions, false, false);

    expect(result.map((q) => q.id)).toEqual(["q1", "q2", "q3"]);
    result.forEach((q, i) => {
      expect(q.options.map((o) => o.id)).toEqual(
        baseQuestions[i].options.map((o) => o.id)
      );
    });
  });

  it("元の配列が変更されないこと（immutability）", () => {
    const originalIds = baseQuestions.map((q) => q.id);
    const originalOptionIds = baseQuestions.map((q) => q.options.map((o) => o.id));

    randomizeQuiz(baseQuestions, true, true);

    expect(baseQuestions.map((q) => q.id)).toEqual(originalIds);
    baseQuestions.forEach((q, i) => {
      expect(q.options.map((o) => o.id)).toEqual(originalOptionIds[i]);
    });
  });

  it("randomizeQuestions=true → 返り値は同じ問題を含む（順序は変わる場合あり）", () => {
    const result = randomizeQuiz(baseQuestions, true, false);

    expect(result).toHaveLength(baseQuestions.length);
    expect(result.map((q) => q.id).sort()).toEqual(["q1", "q2", "q3"]);
  });

  it("randomizeAnswers=true → 選択肢は同じものを含む（順序は変わる場合あり）", () => {
    const result = randomizeQuiz(baseQuestions, false, true);

    result.forEach((q, i) => {
      expect(q.options.map((o) => o.id).sort()).toEqual(
        baseQuestions[i].options.map((o) => o.id).sort()
      );
    });
  });
});

// -----------------------------------------------
// stripCorrectAnswers
// -----------------------------------------------

describe("stripCorrectAnswers", () => {
  const questions: QuizQuestion[] = [
    {
      id: "q1",
      text: "What is 2+2?",
      type: "single",
      options: [
        { id: "a", text: "3", isCorrect: false },
        { id: "b", text: "4", isCorrect: true },
        { id: "c", text: "5", isCorrect: false },
      ],
      points: 10,
      explanation: "2+2=4 because math.",
    },
    {
      id: "q2",
      text: "Select all even numbers",
      type: "multi",
      options: [
        { id: "x", text: "2", isCorrect: true },
        { id: "y", text: "3", isCorrect: false },
        { id: "z", text: "4", isCorrect: true },
      ],
      points: 10,
      explanation: "2 and 4 are even.",
    },
  ];

  it("isCorrectが全てfalseになること", () => {
    const stripped = stripCorrectAnswers(questions);

    stripped.forEach((q) => {
      q.options.forEach((o) => {
        expect(o.isCorrect).toBe(false);
      });
    });
  });

  it("explanationが除外されること", () => {
    const stripped = stripCorrectAnswers(questions);

    stripped.forEach((q) => {
      expect(q).not.toHaveProperty("explanation");
    });
  });

  it("問題文（text）は保持されること", () => {
    const stripped = stripCorrectAnswers(questions);

    expect(stripped[0].text).toBe("What is 2+2?");
    expect(stripped[1].text).toBe("Select all even numbers");
  });

  it("オプションのtextは保持されること", () => {
    const stripped = stripCorrectAnswers(questions);

    expect(stripped[0].options[1].text).toBe("4");
    expect(stripped[1].options[0].text).toBe("2");
  });

  it("id, type, pointsは保持されること", () => {
    const stripped = stripCorrectAnswers(questions);

    expect(stripped[0].id).toBe("q1");
    expect(stripped[0].type).toBe("single");
    expect(stripped[0].points).toBe(10);
    expect(stripped[1].id).toBe("q2");
    expect(stripped[1].type).toBe("multi");
  });

  it("元のquestionsが変更されないこと（immutability）", () => {
    stripCorrectAnswers(questions);

    // 元データのisCorrectは変わっていない
    expect(questions[0].options[1].isCorrect).toBe(true);
    expect(questions[1].options[0].isCorrect).toBe(true);
    // explanationも残っている
    expect(questions[0].explanation).toBe("2+2=4 because math.");
  });
});
