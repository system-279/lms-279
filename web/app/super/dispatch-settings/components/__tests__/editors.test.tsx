/**
 * ScheduleEditor / MessageBodyEditor (Phase 6 PR-F1) のテスト。
 * controlled component なので onChange の呼び出し内容と表示を検証する。
 */
import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { ScheduleEditor } from "../ScheduleEditor";
import { MessageBodyEditor } from "../MessageBodyEditor";

describe("ScheduleEditor", () => {
  it("曜日チェックでトグルし sorted な配列で onChange する", () => {
    const onChange = vi.fn();
    render(
      <ScheduleEditor daysOfWeek={[4]} hourJst={9} onChange={onChange} />,
    );
    // 月曜 (index 1) を追加
    fireEvent.click(screen.getByLabelText("月曜日"));
    expect(onChange).toHaveBeenCalledWith({ daysOfWeek: [1, 4], hourJst: 9 });
  });

  it("既選択の曜日をクリックすると外れる", () => {
    const onChange = vi.fn();
    render(
      <ScheduleEditor daysOfWeek={[1, 4]} hourJst={9} onChange={onChange} />,
    );
    fireEvent.click(screen.getByLabelText("月曜日"));
    expect(onChange).toHaveBeenCalledWith({ daysOfWeek: [4], hourJst: 9 });
  });

  it("曜日未選択時は警告を表示", () => {
    render(<ScheduleEditor daysOfWeek={[]} hourJst={0} onChange={vi.fn()} />);
    expect(
      screen.getByText("曜日が未選択のため配信されません。"),
    ).toBeInTheDocument();
  });
});

describe("MessageBodyEditor", () => {
  it("文字数カウンタを表示する", () => {
    render(
      <MessageBodyEditor
        signatureName="運営"
        completionMessageBody="本文"
        onChange={vi.fn()}
      />,
    );
    expect(screen.getByText("2 / 100")).toBeInTheDocument();
    expect(screen.getByText("2 / 4000")).toBeInTheDocument();
  });

  it("本文入力で onChange する", () => {
    const onChange = vi.fn();
    render(
      <MessageBodyEditor
        signatureName="運営"
        completionMessageBody="本文"
        onChange={onChange}
      />,
    );
    fireEvent.change(screen.getByPlaceholderText("受講お疲れ様でした。..."), {
      target: { value: "新本文" },
    });
    expect(onChange).toHaveBeenCalledWith({
      signatureName: "運営",
      completionMessageBody: "新本文",
    });
  });

  it("プレビューに本文と署名が反映される", () => {
    render(
      <MessageBodyEditor
        signatureName="運営スタッフ"
        completionMessageBody="お疲れ様でした"
        onChange={vi.fn()}
      />,
    );
    // プレビュー領域に本文 + 署名が含まれる
    const preview = screen.getByTestId("message-preview");
    expect(preview).toHaveTextContent("お疲れ様でした");
    expect(preview).toHaveTextContent("運営スタッフ");
  });
});
