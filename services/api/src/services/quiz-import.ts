import { VertexAI } from "@google-cloud/vertexai";
import type { FormattedParagraph } from "./google-docs.js";

const PROJECT_ID = process.env.GCLOUD_PROJECT || process.env.FIREBASE_PROJECT_ID || "lms-279";
const LOCATION = process.env.VERTEX_AI_LOCATION || "asia-northeast1";
const MODEL = "gemini-2.5-flash";

export interface ImportedQuizOption {
  id: string;
  text: string;
  isCorrect: boolean | null; // null = 正解不明（ユーザーが手動設定）
}

export interface ImportedQuizQuestion {
  id: string;
  text: string;
  type: "single" | "multi";
  options: ImportedQuizOption[];
  points: number;
  explanation: string;
}

let vertexAI: VertexAI | null = null;

function getVertexAI(): VertexAI {
  if (!vertexAI) {
    vertexAI = new VertexAI({ project: PROJECT_ID, location: LOCATION });
  }
  return vertexAI;
}

/**
 * 書式付き段落をマークアップ文字列に変換
 * Geminiに書式情報を伝えるための中間形式
 */
export function buildFormattedContentMarkup(
  paragraphs: FormattedParagraph[]
): string {
  return paragraphs
    .map((p) => {
      return p.runs
        .map((run) => {
          let text = run.text;
          // 改行のみの場合はそのまま返す
          if (text.trim() === "") return text;

          if (run.foregroundColor) {
            text = `[COLOR:${run.foregroundColor}]${text}[/COLOR]`;
          }
          if (run.underline) {
            text = `[UNDERLINE]${text}[/UNDERLINE]`;
          }
          if (run.bold) {
            text = `[BOLD]${text}[/BOLD]`;
          }
          return text;
        })
        .join("");
    })
    .join("\n");
}

/**
 * インポートされた問題を検証
 * generateの validateGeneratedQuestions と異なり、isCorrect: null を許容する
 */
export function validateImportedQuestions(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  rawQuestions: any[]
): ImportedQuizQuestion[] {
  if (!Array.isArray(rawQuestions) || rawQuestions.length === 0) {
    throw new Error("No questions imported");
  }

  if (rawQuestions.length > 50) {
    throw new Error("Imported questions exceed the 50 question limit");
  }

  let idCounter = 0;
  const genId = () => `imp_${Date.now()}_${++idCounter}`;

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

    const options: ImportedQuizOption[] = q.options.map(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (opt: any) => ({
        id: genId(),
        text: String(opt.text ?? ""),
        // null を明示的に許容（正解不明）
        isCorrect: opt.isCorrect === null ? null : !!opt.isCorrect,
      })
    );

    return {
      id: genId(),
      text: q.text,
      type,
      options,
      points: 1,
      explanation: "", // インポートモードでは解説を創作しない
    };
  });
}

/**
 * ドキュメントの書式付きコンテンツからクイズ問題を抽出（生成ではなくパース）
 */
export async function importQuizFromDocument(
  formattedContent: string,
  options: { language?: "ja" | "en" } = {}
): Promise<{
  questions: ImportedQuizQuestion[];
  warnings: string[];
}> {
  const { language = "ja" } = options;
  const langLabel = language === "ja" ? "日本語" : "English";

  const prompt = `あなたはドキュメントパーサーです。クイズ設計者やコンテンツクリエーターではありません。
以下のテスト文書から、問題・選択肢・正解を**そのまま抽出**してJSON化してください。

## 絶対厳守ルール
- 問題文・選択肢のテキストは原文のまま。一文字も変更・要約・言い換えしない
- 問題を追加・削除・統合しない。文書にある問題だけを出力する
- 選択肢の順序を変えない
- [BOLD]タグで囲まれた選択肢は isCorrect: true とする
- [UNDERLINE]や[COLOR:...]タグで囲まれた選択肢も正解の可能性がある。文脈から判断してisCorrectを設定する
- 書式タグがない選択肢で、正解が判別できない場合は isCorrect: null とする
- explanationは必ず空文字""にする（解説を創作しない）
- 出力は${langLabel}で行う

## 書式タグの意味
- [BOLD]テキスト[/BOLD] → 太字（正解を示す可能性が高い）
- [UNDERLINE]テキスト[/UNDERLINE] → 下線
- [COLOR:#RRGGBB]テキスト[/COLOR] → 色付き文字

## 出力形式（JSON配列）
[
  {
    "text": "問題文（書式タグを除去した原文）",
    "type": "single",
    "options": [
      { "text": "選択肢テキスト（書式タグを除去した原文）", "isCorrect": true/false/null }
    ]
  }
]

## テスト文書
${formattedContent.slice(0, 30000)}`;

  const ai = getVertexAI();
  const model = ai.getGenerativeModel({
    model: MODEL,
    generationConfig: {
      responseMimeType: "application/json",
      temperature: 0.1, // パース用に低温度
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

  const questions = validateImportedQuestions(parsed);

  // 警告生成
  const warnings: string[] = [];
  const unknownCorrectCount = questions.filter((q) =>
    q.options.every((o) => o.isCorrect === null)
  ).length;

  if (unknownCorrectCount > 0) {
    warnings.push(
      `${questions.length}問中${unknownCorrectCount}問で正解が検出できませんでした。手動で正解を設定してください。`
    );
  }

  const partialCorrectCount = questions.filter((q) =>
    q.options.some((o) => o.isCorrect === null) &&
    q.options.some((o) => o.isCorrect !== null)
  ).length;

  if (partialCorrectCount > 0) {
    warnings.push(
      `${partialCorrectCount}問で一部の選択肢の正解判定が不確実です。確認してください。`
    );
  }

  return { questions, warnings };
}
