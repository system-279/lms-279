import crypto from "node:crypto";
import { VertexAI } from "@google-cloud/vertexai";
import type { FormattedParagraph } from "./google-docs.js";
import {
  getDocumentTabs,
  getDocumentTabContentFormatted,
} from "./google-docs.js";

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

  const genId = () => crypto.randomUUID();

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
 * ドキュメントの書式付きコンテンツからテスト問題を抽出（生成ではなくパース）
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

  const prompt = `あなたは厳密なドキュメントパーサーです。テスト設計者やコンテンツクリエーターではありません。
以下のテスト文書から、問題・選択肢・正解を**そのまま抽出**してJSON化してください。

## 絶対厳守ルール（違反は致命的エラー）
1. 問題文・選択肢のテキストは原文のまま抽出する。一文字も変更・要約・言い換え・創作しない
2. 文書にある問題を全て出力する。問題を追加・削除・統合・分割しない
3. 選択肢は原文にあるものだけを抽出する。選択肢を追加・削除・変更しない
4. 選択肢の順序を変えない
5. explanationは必ず空文字""にする（解説を創作しない）
6. 出力は${langLabel}で行う

## 選択肢の認識パターン
以下の形式を選択肢として認識する（前後の空白は除去）:
- a) / b) / c) / d) ... （小文字アルファベット + 閉じ括弧）
- A) / B) / C) / D) ... （大文字アルファベット + 閉じ括弧）
- ア) / イ) / ウ) / エ) ...
- ① / ② / ③ / ④ ...
- 1. / 2. / 3. / 4. ...（※番号付き問題と混同しないよう文脈で判断）

選択肢テキストには先頭のラベル（a), A), ①等）を含めない。

## 正解の判定
- 選択肢の行にある[BOLD]タグ → isCorrect: true
- 選択肢の行にある[UNDERLINE]や[COLOR:...]タグ → 正解の可能性。文脈から判断
- 書式タグが一切ない場合 → isCorrect: null（全選択肢null可。正解を推測しない）
- 問題文の行にある[BOLD]は見出しの強調であり、正解判定に使わない

## 書式タグ
- [BOLD]テキスト[/BOLD] → 太字
- [UNDERLINE]テキスト[/UNDERLINE] → 下線
- [COLOR:#RRGGBB]テキスト[/COLOR] → 色付き文字

## 出力形式（JSON配列）
[
  {
    "text": "問題文（書式タグを除去した原文そのまま）",
    "type": "single",
    "options": [
      { "text": "選択肢テキスト（ラベルと書式タグを除去した原文そのまま）", "isCorrect": true/false/null }
    ]
  }
]

## テスト文書
${formattedContent.slice(0, 30000)}`;

  const contentTruncated = formattedContent.length > 30000;

  const ai = getVertexAI();
  const model = ai.getGenerativeModel({
    model: MODEL,
    generationConfig: {
      responseMimeType: "application/json",
      temperature: 0.0, // パース用に最低温度（創作を抑制）
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

  // Geminiが {questions: [...]} 形式で返した場合のアンラップ
  let questionsArray: unknown[];
  if (Array.isArray(parsed)) {
    questionsArray = parsed;
  } else if (
    typeof parsed === "object" &&
    parsed !== null &&
    Array.isArray((parsed as Record<string, unknown>).questions)
  ) {
    questionsArray = (parsed as Record<string, unknown>).questions as unknown[];
  } else {
    throw new Error("ドキュメントの形式が認識できませんでした。問題・選択肢の書式を確認してください。");
  }

  const questions = validateImportedQuestions(questionsArray);

  // 警告生成
  const warnings: string[] = [];

  if (contentTruncated) {
    warnings.push(
      "ドキュメントが長すぎるため、先頭30,000文字のみを処理しました。問題数をご確認ください。"
    );
  }
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

// ============================================================
// ルートハンドラ用: タブ解決 → インポートの統合フロー
// ============================================================

export type QuizImportResult =
  | {
      action: "select_tab";
      tabs: { id: string; title: string }[];
      documentTitle: string;
    }
  | {
      action: "imported";
      importedQuestions: ImportedQuizQuestion[];
      documentTitle: string;
      suggestedTitle: string;
      warnings: string[];
    };

/**
 * Google Docsのタブ解決 → 書式付き取得 → Geminiパースを一括実行
 * ルートハンドラはこの関数を呼び出すだけで済む
 */
export async function resolveAndImportQuiz(
  documentId: string,
  tabId: string | null,
  options: { language?: "ja" | "en" } = {}
): Promise<QuizImportResult> {
  let resolvedTabId = tabId;

  if (!resolvedTabId) {
    const { title: docTitle, tabs } = await getDocumentTabs(documentId);

    // 「テスト」を含むタブを検索
    const testTab = tabs.find((t) =>
      t.title.toLowerCase().includes("テスト")
    );

    if (testTab) {
      resolvedTabId = testTab.id;
    } else if (tabs.length === 1) {
      // タブが1つしかない場合は自動選択
      resolvedTabId = tabs[0].id;
    } else {
      return { action: "select_tab", tabs, documentTitle: docTitle };
    }
  }

  const { title: docTitle, formattedContent } =
    await getDocumentTabContentFormatted(documentId, resolvedTabId);

  const formattedMarkup = buildFormattedContentMarkup(formattedContent);
  const { questions, warnings } = await importQuizFromDocument(
    formattedMarkup,
    options
  );

  return {
    action: "imported",
    importedQuestions: questions,
    documentTitle: docTitle,
    suggestedTitle: `${docTitle} - 確認テスト`,
    warnings,
  };
}
