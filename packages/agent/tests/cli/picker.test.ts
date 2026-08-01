import { describe, it, expect } from "vitest";
import {
  fuzzySubsequenceMatch,
  filterPickerItems,
  computePickerListRows,
  computePickerViewport,
  handlePickerKey,
} from "../../src/cli/picker.js";

describe("fuzzySubsequenceMatch", () => {
  it("matches empty query against any target", () => {
    expect(fuzzySubsequenceMatch("", "anthropic/claude")).toBe(true);
    expect(fuzzySubsequenceMatch("  ", "x")).toBe(true);
  });

  it("matches subsequence characters in order", () => {
    expect(fuzzySubsequenceMatch("mm2", "minimax/MiniMax-M2.7")).toBe(true);
    expect(fuzzySubsequenceMatch("cld", "anthropic/claude-3")).toBe(true);
  });

  it("is case-insensitive", () => {
    expect(fuzzySubsequenceMatch("MINI", "minimax/MiniMax")).toBe(true);
  });

  it("rejects when characters are out of order", () => {
    expect(fuzzySubsequenceMatch("2mm", "minimax/MiniMax-M2.7")).toBe(false);
  });
});

describe("filterPickerItems", () => {
  const models = [
    { alias: "fast", provider: "minimax", model: "MiniMax-M2.7" },
    { alias: "smart", provider: "anthropic", model: "claude-sonnet" },
  ];

  it("returns all items when filter is empty", () => {
    expect(
      filterPickerItems(models, "", (m) => `${m.provider}/${m.model} ${m.alias}`),
    ).toHaveLength(2);
  });

  it("narrows by provider + model subsequence", () => {
    const filtered = filterPickerItems(
      models,
      "anthclau",
      (m) => `${m.provider}/${m.model} ${m.alias}`,
    );
    expect(filtered).toHaveLength(1);
    expect(filtered[0]?.alias).toBe("smart");
  });
});

describe("computePickerListRows", () => {
  it("reserves header and fixed UI rows", () => {
    expect(computePickerListRows(24, 4, 2)).toBe(18);
    expect(computePickerListRows(5, 10, 2)).toBe(1);
  });
});

describe("computePickerViewport", () => {
  it("shows all items when they fit", () => {
    const vp = computePickerViewport(5, 2, 10);
    expect(vp).toEqual({
      scrollOffset: 0,
      startIndex: 0,
      endIndex: 5,
      aboveCount: 0,
      belowCount: 0,
    });
  });

  it("keeps selected item visible with overflow indicators", () => {
    const vp = computePickerViewport(30, 25, 8);
    expect(vp.startIndex).toBeLessThanOrEqual(25);
    expect(vp.endIndex).toBeGreaterThan(25);
    expect(vp.aboveCount).toBeGreaterThan(0);
    expect(vp.belowCount).toBeGreaterThan(0);
    expect(vp.endIndex - vp.startIndex).toBeLessThanOrEqual(6);
  });

  it("scrolls window when selection moves to top", () => {
    const vp = computePickerViewport(20, 0, 6);
    expect(vp.startIndex).toBe(0);
    expect(vp.aboveCount).toBe(0);
    expect(vp.belowCount).toBeGreaterThan(0);
  });
});

describe("handlePickerKey", () => {
  const state = { selectedIndex: 2, filter: "ab" };

  it("closes on escape", () => {
    expect(handlePickerKey({ escape: true }, state, 10, 6).type).toBe("close");
  });

  it("selects on enter when items exist", () => {
    expect(handlePickerKey({ return: true }, state, 10, 6).type).toBe("select");
  });

  it("moves selection on arrow keys", () => {
    const up = handlePickerKey({ upArrow: true }, state, 10, 6);
    expect(up).toEqual({ type: "update", selectedIndex: 1, filter: "ab" });

    const down = handlePickerKey({ downArrow: true }, state, 10, 6);
    expect(down).toEqual({ type: "update", selectedIndex: 3, filter: "ab" });
  });

  it("pages by viewport size", () => {
    const pageDown = handlePickerKey({ pageDown: true }, { selectedIndex: 0, filter: "" }, 30, 8);
    expect(pageDown.type).toBe("update");
    if (pageDown.type === "update") {
      expect(pageDown.selectedIndex).toBeGreaterThan(0);
    }
  });

  it("resets selection when filter changes", () => {
    const typed = handlePickerKey({ inputStr: "c" }, state, 10, 6);
    expect(typed).toEqual({ type: "update", selectedIndex: 0, filter: "abc" });

    const back = handlePickerKey({ backspace: true }, state, 10, 6);
    expect(back).toEqual({ type: "update", selectedIndex: 0, filter: "a" });
  });
});
