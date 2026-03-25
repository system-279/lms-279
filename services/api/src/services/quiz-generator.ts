import { VertexAI } from "@google-cloud/vertexai";
import type { QuizQuestion, QuizOption } from "../types/entities.js";

const PROJECT_ID = process.env.GCLOUD_PROJECT || process.env.FIREBASE_PROJECT_ID || "lms-279";
const LOCATION = process.env.VERTEX_AI_LOCATION || "asia-northeast1";
const MODEL = "gemini-2.5-flash";

export interface GenerateQuizOptions {
  questionCount?: number;  // default 10, max 50
  language?: "ja" | "en"; // default "ja"
  difficulty?: "easy" | "medium" | "hard"; // default "medium"
}

let vertexAI: VertexAI | null = null;

function getVertexAI(): VertexAI {
  if (!vertexAI) {
    vertexAI = new VertexAI({ project: PROJECT_ID, location: LOCATION });
  }
  return vertexAI;
}

/**
 * AI生成結果を QuizQuestion[] に変換・検証
 * 不正な問題はスキップせずエラーを投げる
 */
export function validateGeneratedQuestions(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  rawQuestions: any[]
): QuizQuestion[] {
  if (!Array.isArray(rawQuestions) || rawQuestions.length === 0) {
    throw new Error("No questions generated");
  }

  if (rawQuestions.length > 50) {
    throw new Error("Generated questions exceed the 50 question limit");
  }

  let idCounter = 0;
  const genId = () => `gen_${Date.now()}_${++idCounter}`;

  return rawQuestions.map((q, i) => {
    if (!q.text || typeof q.text !== "string") {
      throw new Error(`Question ${i + 1}: text is required`);
    }

    const type = q.type === "multi" ? "multi" : "single";

    if (!Array.isArray(q.options) || q.options.length < 2) {
      throw new Error(
        `Question ${i + 1}: at least 2 options are required`
      );
    }

    const options: QuizOption[] = q.options.map(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (opt: any) => ({
        id: genId(),
        text: String(opt.text ?? ""),
        isCorrect: !!opt.isCorrect,
      })
    );

    const correctCount = options.filter((o) => o.isCorrect).length;
    if (type === "single" && correctCount !== 1) {
      throw new Error(
        `Question ${i + 1} (single): exactly 1 correct answer required, got ${correctCount}`
      );
    }
    if (type === "multi" && correctCount < 1) {
      throw new Error(
        `Question ${i + 1} (multi): at least 1 correct answer required`
      );
    }

    return {
      id: genId(),
      text: q.text,
      type,
      options,
      points: typeof q.points === "number" && q.points > 0 ? q.points : 1,
      explanation: typeof q.explanation === "string" ? q.explanation : "",
    };
  });
}

/**
 * ドキュメント内容からテスト問題を自動生成
 */
export async function generateQuizQuestions(
  content: string,
  options: GenerateQuizOptions = {}
): Promise<QuizQuestion[]> {
  const {
    questionCount = 10,
    language = "ja",
    difficulty = "medium",
  } = options;

  const clampedCount = Math.min(Math.max(questionCount, 1), 50);

  const langLabel = language === "ja" ? "日本語" : "English";
  const difficultyLabel = {
    easy: "基礎的",
    medium: "標準的",
    hard: "応用的",
  }[difficulty];

  const prompt = `あなたは教育テスト設計の専門家です。以下のドキュメント内容に基づいて、${clampedCount}問のテスト問題を${langLabel}で作成してください。

## 要件
- 難易度: ${difficultyLabel}
- 各問題は3〜5個の選択肢を持つこと
- "single"（単一選択）と"multi"（複数選択）を適切に混在させること
- 各問題にはソース資料に基づく簡潔な解説を付けること
- 選択肢のテキストは簡潔かつ明確にすること

## 出力形式（JSON配列）
[
  {
    "text": "問題文",
    "type": "single" または "multi",
    "options": [
      { "text": "選択肢テキスト", "isCorrect": true/false }
    ],
    "points": 1,
    "explanation": "解説文"
  }
]

## ドキュメント内容
${content.slice(0, 30000)}`;

  const ai = getVertexAI();
  const model = ai.getGenerativeModel({
    model: MODEL,
    generationConfig: {
      responseMimeType: "application/json",
      temperature: 0.7,
    },
  });

  const result = await model.generateContent(prompt);
  const responseText =
    result.response?.candidates?.[0]?.content?.parts?.[0]?.text;

  if (!responseText) {
    throw new Error("Gemini returned no content");
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(responseText);
  } catch {
    throw new Error("Failed to parse Gemini response as JSON");
  }

  if (!Array.isArray(parsed)) {
    throw new Error("Gemini response is not an array");
  }

  return validateGeneratedQuestions(parsed);
}
