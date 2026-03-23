import { describe, it, expect, beforeEach } from "vitest";

describe("google-docs service", () => {
  describe("parseDocsUrl", () => {
    let parseDocsUrl: (url: string) => string;

    beforeEach(async () => {
      const mod = await import("../../services/google-docs.js");
      parseDocsUrl = mod.parseDocsUrl;
    });

    it("parses /document/d/{id}/edit format", () => {
      expect(
        parseDocsUrl("https://docs.google.com/document/d/1abc_DEF-xyz/edit")
      ).toBe("1abc_DEF-xyz");
    });

    it("parses /document/d/{id}/edit?usp=sharing format", () => {
      expect(
        parseDocsUrl(
          "https://docs.google.com/document/d/1abc_DEF-xyz/edit?usp=sharing"
        )
      ).toBe("1abc_DEF-xyz");
    });

    it("parses /document/d/{id} without trailing path", () => {
      expect(
        parseDocsUrl("https://docs.google.com/document/d/1abc_DEF-xyz")
      ).toBe("1abc_DEF-xyz");
    });

    it("parses /document/d/{id}/preview format", () => {
      expect(
        parseDocsUrl("https://docs.google.com/document/d/1abc_DEF-xyz/preview")
      ).toBe("1abc_DEF-xyz");
    });

    it("throws for invalid URL", () => {
      expect(() => parseDocsUrl("https://example.com/doc")).toThrow(
        "Invalid Google Docs URL"
      );
    });

    it("throws for Drive URL", () => {
      expect(() =>
        parseDocsUrl("https://drive.google.com/file/d/abc/view")
      ).toThrow("Invalid Google Docs URL");
    });

    it("throws for empty string", () => {
      expect(() => parseDocsUrl("")).toThrow("Invalid Google Docs URL");
    });
  });
});

describe("quiz-generator service", () => {
  describe("validateGeneratedQuestions", () => {
    let validateGeneratedQuestions: (
      questions: unknown[]
    ) => import("../../types/entities.js").QuizQuestion[];

    beforeEach(async () => {
      const mod = await import("../../services/quiz-generator.js");
      validateGeneratedQuestions = mod.validateGeneratedQuestions;
    });

    it("validates well-formed questions", () => {
      const input = [
        {
          text: "テスト問題",
          type: "single",
          options: [
            { text: "選択肢1", isCorrect: true },
            { text: "選択肢2", isCorrect: false },
          ],
          points: 1,
          explanation: "解説文",
        },
      ];
      const result = validateGeneratedQuestions(input);
      expect(result).toHaveLength(1);
      expect(result[0].id).toBeTruthy();
      expect(result[0].text).toBe("テスト問題");
      expect(result[0].options).toHaveLength(2);
      expect(result[0].options[0].id).toBeTruthy();
    });

    it("rejects questions without options", () => {
      const input = [
        {
          text: "問題",
          type: "single",
          options: [],
          points: 1,
          explanation: "",
        },
      ];
      expect(() => validateGeneratedQuestions(input)).toThrow();
    });

    it("rejects questions with no correct answer for single type", () => {
      const input = [
        {
          text: "問題",
          type: "single",
          options: [
            { text: "A", isCorrect: false },
            { text: "B", isCorrect: false },
          ],
          points: 1,
          explanation: "",
        },
      ];
      expect(() => validateGeneratedQuestions(input)).toThrow();
    });

    it("rejects more than 50 questions", () => {
      const input = Array.from({ length: 51 }, (_, i) => ({
        text: `問題${i}`,
        type: "single",
        options: [
          { text: "A", isCorrect: true },
          { text: "B", isCorrect: false },
        ],
        points: 1,
        explanation: "",
      }));
      expect(() => validateGeneratedQuestions(input)).toThrow("50");
    });

    it("defaults points to 1 if missing", () => {
      const input = [
        {
          text: "問題",
          type: "single",
          options: [
            { text: "A", isCorrect: true },
            { text: "B", isCorrect: false },
          ],
          explanation: "",
        },
      ];
      const result = validateGeneratedQuestions(input);
      expect(result[0].points).toBe(1);
    });
  });
});
