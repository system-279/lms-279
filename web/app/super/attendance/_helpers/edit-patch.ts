/**
 * 出席レポート編集ダイアログの PATCH body 生成 pure function。
 *
 * Phase 3 follow-up #3 (#533): 時刻フィールドが実際に変更された場合のみ entryAt/exitAt を含める。
 * 未変更で送ると `dateTimeJSTtoISO` の分精度丸めで秒情報が失われ、original snapshot との差分が
 * 発生し `isStayTimeEdited=true` になる回帰を防ぐ (Codex セカンドオピニオン BLOCK MERGE 指摘)。
 */

/** 日付(yyyy-MM-dd) + 時刻(HH:mm) をJSTとしてISO UTC文字列に変換 (分精度、秒は :00) */
export function dateTimeJSTtoISO(date: string, time: string): string {
  return new Date(`${date}T${time}:00+09:00`).toISOString();
}

export interface EditPatchInput {
  editDate: string;
  editEntryTime: string;
  editExitTime: string;
  initialEditDate: string;
  initialEditEntryTime: string;
  initialEditExitTime: string;
  editScore: string;
  editPassed: string;
}

/**
 * 編集ダイアログの form state から PATCH body を生成する。
 * 時刻フィールドは「日付 or 該当時刻が初期値から変更された場合のみ」body に含める (dirty 判定)。
 */
export function buildEditPatchBody(input: EditPatchInput): Record<string, unknown> {
  const dateChanged = input.editDate !== input.initialEditDate;
  const entryTimeChanged = input.editEntryTime !== input.initialEditEntryTime;
  const exitTimeChanged = input.editExitTime !== input.initialEditExitTime;
  const body: Record<string, unknown> = {};
  if (input.editDate && input.editEntryTime && (dateChanged || entryTimeChanged)) {
    body.entryAt = dateTimeJSTtoISO(input.editDate, input.editEntryTime);
  }
  if (input.editDate && input.editExitTime && (dateChanged || exitTimeChanged)) {
    body.exitAt = dateTimeJSTtoISO(input.editDate, input.editExitTime);
  }
  if (input.editScore !== "") {
    body.quizScore = Number(input.editScore);
  }
  if (input.editPassed !== "") {
    body.quizPassed = input.editPassed === "true";
  }
  return body;
}
