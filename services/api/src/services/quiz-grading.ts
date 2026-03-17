/**
 * クイズ採点サービス
 * ADR-017: サーバーサイド採点、正解はsubmit後まで非公開
 */

import type { QuizQuestion } from "../types/entities.js";

interface GradingResult {
  score: number;           // パーセント (0-100)
  isPassed: boolean;
  totalPoints: number;
  earnedPoints: number;
  questionResults: QuestionResult[];
}

interface QuestionResult {
  questionId: string;
  isCorrect: boolean;
  earnedPoints: number;
  maxPoints: number;
  correctOptionIds: string[];
  selectedOptionIds: string[];
}

/**
 * クイズを採点する
 * @param questions クイズの問題配列（正解付き）
 * @param answers ユーザーの回答 { questionId: selectedOptionIds[] }
 * @param passThreshold 合格基準（パーセント）
 */
export function gradeQuiz(
  questions: QuizQuestion[],
  answers: Record<string, string[]>,
  passThreshold: number
): GradingResult {
  let totalPoints = 0;
  let earnedPoints = 0;
  const questionResults: QuestionResult[] = [];

  for (const question of questions) {
    totalPoints += question.points;
    const selectedIds = answers[question.id] || [];
    const correctIds = question.options
      .filter(o => o.isCorrect)
      .map(o => o.id);

    // single: 選択が正解と完全一致
    // multi: 全正解オプション選択 + 不正解オプション未選択
    const isCorrect =
      correctIds.length === selectedIds.length &&
      correctIds.every(id => selectedIds.includes(id)) &&
      selectedIds.every(id => correctIds.includes(id));

    const points = isCorrect ? question.points : 0;
    earnedPoints += points;

    questionResults.push({
      questionId: question.id,
      isCorrect,
      earnedPoints: points,
      maxPoints: question.points,
      correctOptionIds: correctIds,
      selectedOptionIds: selectedIds,
    });
  }

  const score = totalPoints > 0 ? Math.round((earnedPoints / totalPoints) * 100) : 0;

  return {
    score,
    isPassed: score >= passThreshold,
    totalPoints,
    earnedPoints,
    questionResults,
  };
}

/**
 * 問題をランダム化する（問題順 + 選択肢順）
 * 元の配列は変更せず新しい配列を返す
 */
export function randomizeQuiz(
  questions: QuizQuestion[],
  randomizeQuestions: boolean,
  randomizeAnswers: boolean
): QuizQuestion[] {
  let result = [...questions];

  if (randomizeQuestions) {
    result = shuffleArray(result);
  }

  if (randomizeAnswers) {
    result = result.map(q => ({
      ...q,
      options: shuffleArray([...q.options]),
    }));
  }

  return result;
}

/**
 * クイズデータから正解を除去（受講者向け）
 * ADR-017: 正解はsubmit後まで非公開
 */
export function stripCorrectAnswers(
  questions: QuizQuestion[]
): Omit<QuizQuestion, "explanation">[] {
  return questions.map(q => ({
    id: q.id,
    text: q.text,
    type: q.type,
    options: q.options.map(o => ({
      id: o.id,
      text: o.text,
      isCorrect: false, // 常にfalseで返す
    })),
    points: q.points,
    // explanationは除外
  }));
}

/**
 * Fisher-Yatesシャッフル
 */
function shuffleArray<T>(array: T[]): T[] {
  const shuffled = [...array];
  for (let i = shuffled.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
  }
  return shuffled;
}

export type { GradingResult, QuestionResult };
