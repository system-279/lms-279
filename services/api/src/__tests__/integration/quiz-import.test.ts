import { describe, it, expect, beforeEach } from "vitest";

describe("quiz-import service", () => {
  describe("validateImportedQuestions", () => {
    let validateImportedQuestions: (
      questions: unknown[]
    ) => import("../../services/quiz-import.js").ImportedQuizQuestion[];

    beforeEach(async () => {
      const mod = await import("../../services/quiz-import.js");
      validateImportedQuestions = mod.validateImportedQuestions;
    });

    it("validates well-formed questions with isCorrect set", () => {
      const input = [
        {
          text: "テスト問題",
          type: "single",
          options: [
            { text: "選択肢1", isCorrect: true },
            { text: "選択肢2", isCorrect: false },
            { text: "選択肢3", isCorrect: false },
          ],
        },
      ];
      const result = validateImportedQuestions(input);
      expect(result).toHaveLength(1);
      expect(result[0].id).toBeTruthy();
      expect(result[0].text).toBe("テスト問題");
      expect(result[0].type).toBe("single");
      expect(result[0].options).toHaveLength(3);
      expect(result[0].options[0].isCorrect).toBe(true);
      expect(result[0].points).toBe(1);
      expect(result[0].explanation).toBe("");
    });

    it("allows isCorrect: null for undetected correct answers", () => {
      const input = [
        {
          text: "正解不明な問題",
          type: "single",
          options: [
            { text: "選択肢A", isCorrect: null },
            { text: "選択肢B", isCorrect: null },
          ],
        },
      ];
      const result = validateImportedQuestions(input);
      expect(result[0].options[0].isCorrect).toBeNull();
      expect(result[0].options[1].isCorrect).toBeNull();
    });

    it("allows mixed isCorrect values (boolean and null)", () => {
      const input = [
        {
          text: "混在問題",
          type: "single",
          options: [
            { text: "正解", isCorrect: true },
            { text: "不正解", isCorrect: false },
            { text: "不明", isCorrect: null },
          ],
        },
      ];
      const result = validateImportedQuestions(input);
      expect(result[0].options[0].isCorrect).toBe(true);
      expect(result[0].options[1].isCorrect).toBe(false);
      expect(result[0].options[2].isCorrect).toBeNull();
    });

    it("does not enforce correct answer requirement (unlike generation validator)", () => {
      const input = [
        {
          text: "全部不明",
          type: "single",
          options: [
            { text: "A", isCorrect: null },
            { text: "B", isCorrect: null },
          ],
        },
      ];
      // Should NOT throw (unlike validateGeneratedQuestions)
      const result = validateImportedQuestions(input);
      expect(result).toHaveLength(1);
    });

    it("rejects empty questions array", () => {
      expect(() => validateImportedQuestions([])).toThrow("No questions");
    });

    it("rejects non-array input", () => {
      expect(() =>
        validateImportedQuestions("not an array" as unknown as unknown[])
      ).toThrow("No questions");
    });

    it("rejects more than 50 questions", () => {
      const input = Array.from({ length: 51 }, (_, i) => ({
        text: `問題${i}`,
        type: "single",
        options: [
          { text: "A", isCorrect: true },
          { text: "B", isCorrect: false },
        ],
      }));
      expect(() => validateImportedQuestions(input)).toThrow("50");
    });

    it("rejects question without text", () => {
      const input = [
        {
          type: "single",
          options: [
            { text: "A", isCorrect: true },
            { text: "B", isCorrect: false },
          ],
        },
      ];
      expect(() => validateImportedQuestions(input)).toThrow("text");
    });

    it("rejects question with fewer than 2 options", () => {
      const input = [
        {
          text: "問題",
          type: "single",
          options: [{ text: "A", isCorrect: true }],
        },
      ];
      expect(() => validateImportedQuestions(input)).toThrow("2 options");
    });

    it("defaults type to single when invalid", () => {
      const input = [
        {
          text: "問題",
          type: "unknown",
          options: [
            { text: "A", isCorrect: true },
            { text: "B", isCorrect: false },
          ],
        },
      ];
      const result = validateImportedQuestions(input);
      expect(result[0].type).toBe("single");
    });

    it("defaults points to 1", () => {
      const input = [
        {
          text: "問題",
          type: "single",
          options: [
            { text: "A", isCorrect: true },
            { text: "B", isCorrect: false },
          ],
        },
      ];
      const result = validateImportedQuestions(input);
      expect(result[0].points).toBe(1);
    });

    it("sets explanation to empty string", () => {
      const input = [
        {
          text: "問題",
          type: "single",
          options: [
            { text: "A", isCorrect: true },
            { text: "B", isCorrect: false },
          ],
          explanation: "AIが勝手に作った解説",
        },
      ];
      const result = validateImportedQuestions(input);
      // Import mode should always set explanation to empty (no creation)
      expect(result[0].explanation).toBe("");
    });

    it("handles 10-question 3-choice format (typical use case)", () => {
      const input = Array.from({ length: 10 }, (_, i) => ({
        text: `第${i + 1}問の問題文`,
        type: "single",
        options: [
          { text: `選択肢A${i}`, isCorrect: i % 3 === 0 ? true : false },
          { text: `選択肢B${i}`, isCorrect: i % 3 === 1 ? true : false },
          { text: `選択肢C${i}`, isCorrect: i % 3 === 2 ? true : false },
        ],
      }));
      const result = validateImportedQuestions(input);
      expect(result).toHaveLength(10);
      result.forEach((q, i) => {
        expect(q.text).toBe(`第${i + 1}問の問題文`);
        expect(q.options).toHaveLength(3);
      });
    });
  });

  describe("buildFormattedContentMarkup", () => {
    let buildFormattedContentMarkup: (
      paragraphs: import("../../services/google-docs.js").FormattedParagraph[]
    ) => string;

    beforeEach(async () => {
      const mod = await import("../../services/quiz-import.js");
      buildFormattedContentMarkup = mod.buildFormattedContentMarkup;
    });

    it("wraps bold text with [BOLD] tags", () => {
      const paragraphs = [
        {
          runs: [{ text: "正解の選択肢", bold: true, underline: false, foregroundColor: null }],
        },
      ];
      const result = buildFormattedContentMarkup(paragraphs);
      expect(result).toContain("[BOLD]正解の選択肢[/BOLD]");
    });

    it("wraps underline text with [UNDERLINE] tags", () => {
      const paragraphs = [
        {
          runs: [{ text: "下線テキスト", bold: false, underline: true, foregroundColor: null }],
        },
      ];
      const result = buildFormattedContentMarkup(paragraphs);
      expect(result).toContain("[UNDERLINE]下線テキスト[/UNDERLINE]");
    });

    it("wraps colored text with [COLOR] tags", () => {
      const paragraphs = [
        {
          runs: [{ text: "赤テキスト", bold: false, underline: false, foregroundColor: "#FF0000" }],
        },
      ];
      const result = buildFormattedContentMarkup(paragraphs);
      expect(result).toContain("[COLOR:#FF0000]赤テキスト[/COLOR]");
    });

    it("leaves plain text as-is", () => {
      const paragraphs = [
        {
          runs: [{ text: "普通のテキスト", bold: false, underline: false, foregroundColor: null }],
        },
      ];
      const result = buildFormattedContentMarkup(paragraphs);
      expect(result).toContain("普通のテキスト");
      expect(result).not.toContain("[BOLD]");
      expect(result).not.toContain("[UNDERLINE]");
      expect(result).not.toContain("[COLOR");
    });

    it("separates paragraphs with newlines", () => {
      const paragraphs = [
        { runs: [{ text: "段落1", bold: false, underline: false, foregroundColor: null }] },
        { runs: [{ text: "段落2", bold: false, underline: false, foregroundColor: null }] },
      ];
      const result = buildFormattedContentMarkup(paragraphs);
      expect(result).toBe("段落1\n段落2");
    });

    it("handles multiple formatting on same text", () => {
      const paragraphs = [
        {
          runs: [{ text: "太字下線", bold: true, underline: true, foregroundColor: "#0000FF" }],
        },
      ];
      const result = buildFormattedContentMarkup(paragraphs);
      expect(result).toContain("[BOLD]");
      expect(result).toContain("[UNDERLINE]");
      expect(result).toContain("[COLOR:#0000FF]");
      expect(result).toContain("太字下線");
    });
  });
});
