import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { MultiSelectFilter, type FilterOption } from "../multi-select-filter";

const OPTIONS: FilterOption[] = [
  { value: "l1", label: "1. Googleワークスペースの概要" },
  { value: "l2", label: "2.Googleドライブの活用" },
  { value: "l3", label: "3.Googleチャットの活用" },
];

function openPopover() {
  fireEvent.click(screen.getByRole("button", { name: /レッスン/ }));
}

describe("MultiSelectFilter 全選択", () => {
  it("未選択がある状態で開くと「全選択」ボタンが表示される", () => {
    render(
      <MultiSelectFilter label="レッスン" options={OPTIONS} selected={new Set()} onChange={vi.fn()} />
    );
    openPopover();

    expect(screen.getByRole("button", { name: "全選択" })).toBeInTheDocument();
  });

  it("「全選択」クリックで全option valueを含むSetでonChangeが呼ばれる", () => {
    const onChange = vi.fn();
    render(
      <MultiSelectFilter label="レッスン" options={OPTIONS} selected={new Set()} onChange={onChange} />
    );
    openPopover();
    fireEvent.click(screen.getByRole("button", { name: "全選択" }));

    expect(onChange).toHaveBeenCalledWith(new Set(["l1", "l2", "l3"]));
  });

  it("全選択済みの状態では「全選択」ボタンを表示しない", () => {
    render(
      <MultiSelectFilter
        label="レッスン"
        options={OPTIONS}
        selected={new Set(["l1", "l2", "l3"])}
        onChange={vi.fn()}
      />
    );
    openPopover();

    expect(screen.queryByRole("button", { name: "全選択" })).not.toBeInTheDocument();
  });

  it("一部選択済みでも「選択をクリア」は従来通り表示される", () => {
    render(
      <MultiSelectFilter
        label="レッスン"
        options={OPTIONS}
        selected={new Set(["l1", "l2"])}
        onChange={vi.fn()}
      />
    );
    openPopover();

    expect(screen.getByRole("button", { name: "選択をクリア" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "全選択" })).toBeInTheDocument();
  });

  it("検索で絞り込んだ状態の「全選択」は表示中のoptionのみを対象にする", () => {
    const onChange = vi.fn();
    render(
      <MultiSelectFilter
        label="レッスン"
        options={OPTIONS}
        selected={new Set()}
        onChange={onChange}
        searchable
      />
    );
    openPopover();
    fireEvent.change(screen.getByPlaceholderText("検索..."), { target: { value: "ドライブ" } });
    fireEvent.click(screen.getByRole("button", { name: "全選択" }));

    expect(onChange).toHaveBeenCalledWith(new Set(["l2"]));
  });
});
