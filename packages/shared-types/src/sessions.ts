/**
 * レッスンセッションAPI レスポンスDTO
 * ソース: services/api/src/routes/shared/lesson-sessions.ts (formatSession)
 */

import type { LessonSessionStatus, SessionExitReason } from "./enums.js";

export interface LessonSessionResponse {
  id: string;
  sessionToken: string;
  status: LessonSessionStatus;
  entryAt: string;
  exitAt: string | null;
  exitReason: SessionExitReason | null;
  deadlineAt: string;
  remainingMs: number;
  sessionVideoCompleted: boolean;
}
