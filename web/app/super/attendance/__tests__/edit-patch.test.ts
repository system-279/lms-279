import { describe, expect, it } from "vitest";
import { buildEditPatchBody, dateTimeJSTtoISO } from "../_helpers/edit-patch";

describe("dateTimeJSTtoISO", () => {
  it("JST 08:41 → UTC 23:41 (前日)", () => {
    expect(dateTimeJSTtoISO("2026-05-30", "08:41")).toBe("2026-05-29T23:41:00.000Z");
  });

  it("秒は :00 で丸める (分精度)", () => {
    const iso = dateTimeJSTtoISO("2026-05-30", "10:14");
    expect(iso.endsWith(":00.000Z")).toBe(true);
  });
});

describe("buildEditPatchBody", () => {
  const initial = {
    editDate: "2026-05-30",
    editEntryTime: "08:41",
    editExitTime: "08:42",
    initialEditDate: "2026-05-30",
    initialEditEntryTime: "08:41",
    initialEditExitTime: "08:42",
    editScore: "",
    editPassed: "",
  };

  it("全フィールド未変更 → 空 body (時刻 / score / passed すべて送らない)", () => {
    expect(buildEditPatchBody(initial)).toEqual({});
  });

  it("Phase 3 follow-up #3 回帰防止: synthetic record の quizScore のみ編集 → entryAt/exitAt 不含 (Codex BLOCK MERGE 反映)", () => {
    const body = buildEditPatchBody({ ...initial, editScore: "100" });
    expect(body).toEqual({ quizScore: 100 });
    expect(body.entryAt).toBeUndefined();
    expect(body.exitAt).toBeUndefined();
  });

  it("quizPassed のみ編集 → entryAt/exitAt 不含", () => {
    const body = buildEditPatchBody({ ...initial, editPassed: "true" });
    expect(body).toEqual({ quizPassed: true });
    expect(body.entryAt).toBeUndefined();
    expect(body.exitAt).toBeUndefined();
  });

  it("editEntryTime 変更 → entryAt のみ含む、exitAt 不含", () => {
    const body = buildEditPatchBody({ ...initial, editEntryTime: "09:00" });
    expect(body.entryAt).toBe("2026-05-30T00:00:00.000Z");
    expect(body.exitAt).toBeUndefined();
  });

  it("editExitTime 変更 → exitAt のみ含む、entryAt 不含", () => {
    const body = buildEditPatchBody({ ...initial, editExitTime: "11:00" });
    expect(body.exitAt).toBe("2026-05-30T02:00:00.000Z");
    expect(body.entryAt).toBeUndefined();
  });

  it("editDate 変更 → entryAt/exitAt 両方含む (日付は両方の ISO に影響)", () => {
    const body = buildEditPatchBody({ ...initial, editDate: "2026-05-31" });
    expect(body.entryAt).toBe("2026-05-30T23:41:00.000Z");
    expect(body.exitAt).toBe("2026-05-30T23:42:00.000Z");
  });

  it("editDate + editEntryTime + editExitTime 全変更 + score + passed → 全フィールド含む", () => {
    const body = buildEditPatchBody({
      editDate: "2026-05-31",
      editEntryTime: "09:00",
      editExitTime: "11:00",
      initialEditDate: "2026-05-30",
      initialEditEntryTime: "08:41",
      initialEditExitTime: "08:42",
      editScore: "80",
      editPassed: "true",
    });
    expect(body).toEqual({
      entryAt: "2026-05-31T00:00:00.000Z",
      exitAt: "2026-05-31T02:00:00.000Z",
      quizScore: 80,
      quizPassed: true,
    });
  });

  it("editDate 空文字 → 時刻フィールド変更があっても entryAt/exitAt 不含 (anti-NaN ガード)", () => {
    const body = buildEditPatchBody({
      ...initial,
      editDate: "",
      editEntryTime: "09:00",
    });
    expect(body.entryAt).toBeUndefined();
    expect(body.exitAt).toBeUndefined();
  });

  it("editEntryTime 空文字 → entryAt 不含 (但し exitAt は exitTime あれば送信可)", () => {
    const body = buildEditPatchBody({
      ...initial,
      editEntryTime: "",
      editExitTime: "11:00",
    });
    expect(body.entryAt).toBeUndefined();
    expect(body.exitAt).toBe("2026-05-30T02:00:00.000Z");
  });

  it("editScore='' → quizScore 不含 (デフォルト空文字は『未編集』扱い)", () => {
    const body = buildEditPatchBody({ ...initial, editScore: "" });
    expect(body.quizScore).toBeUndefined();
  });

  it("editScore='0' → quizScore=0 含む (0 を未編集と混同しない)", () => {
    const body = buildEditPatchBody({ ...initial, editScore: "0" });
    expect(body.quizScore).toBe(0);
  });
});
