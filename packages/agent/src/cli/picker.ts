/**
 * Pure picker logic: fuzzy subsequence filter and viewport windowing.
 * Used by ViewportPicker and unit-tested without a TTY.
 */

export interface PickerViewport {
  scrollOffset: number;
  startIndex: number;
  endIndex: number;
  aboveCount: number;
  belowCount: number;
}

export interface PickerKeyInput {
  upArrow?: boolean;
  downArrow?: boolean;
  pageUp?: boolean;
  pageDown?: boolean;
  escape?: boolean;
  return?: boolean;
  tab?: boolean;
  backspace?: boolean;
  delete?: boolean;
  inputStr?: string;
  ctrl?: boolean;
  meta?: boolean;
}

export type PickerKeyAction =
  | { type: "none" }
  | { type: "close" }
  | { type: "select" }
  | { type: "update"; selectedIndex: number; filter: string };

export interface PickerNavigationState {
  selectedIndex: number;
  filter: string;
}

/** fzf-style subsequence match (case-insensitive). Empty query matches everything. */
export function fuzzySubsequenceMatch(query: string, target: string): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  const t = target.toLowerCase();
  let qi = 0;
  for (let ti = 0; ti < t.length && qi < q.length; ti++) {
    if (t[ti] === q[qi]) qi++;
  }
  return qi === q.length;
}

/** Filter items by fuzzy subsequence match on `getSearchText(item)`. */
export function filterPickerItems<T>(
  items: readonly T[],
  filter: string,
  getSearchText: (item: T) => string,
): T[] {
  const q = filter.trim();
  if (!q) return [...items];
  return items.filter((item) => fuzzySubsequenceMatch(q, getSearchText(item)));
}

/**
 * Rows available for the scrollable item list (excluding title/filter chrome
 * and fixed UI like prompt + status bar).
 */
export function computePickerListRows(
  terminalRows: number,
  reservedRows: number,
  headerRows: number,
): number {
  return Math.max(1, terminalRows - reservedRows - headerRows);
}

/**
 * Compute which slice of items to render, keeping `selectedIndex` visible.
 * `maxListRows` is the number of rows allocated to the list area (may include
 * up to two overflow indicator lines).
 */
export function computePickerViewport(
  itemCount: number,
  selectedIndex: number,
  maxListRows: number,
): PickerViewport {
  if (itemCount <= 0 || maxListRows <= 0) {
    return { scrollOffset: 0, startIndex: 0, endIndex: 0, aboveCount: 0, belowCount: 0 };
  }

  const selected = Math.max(0, Math.min(selectedIndex, itemCount - 1));

  if (itemCount <= maxListRows) {
    return {
      scrollOffset: 0,
      startIndex: 0,
      endIndex: itemCount,
      aboveCount: 0,
      belowCount: 0,
    };
  }

  // Reserve one row per overflow indicator when needed.
  let itemRows = Math.max(1, maxListRows - 1);
  let start = Math.max(0, Math.min(selected - Math.floor(itemRows / 2), itemCount - itemRows));
  let end = start + itemRows;
  let above = start;
  let below = itemCount - end;

  if (above > 0 && below > 0) {
    itemRows = Math.max(1, maxListRows - 2);
    start = Math.max(0, Math.min(selected - Math.floor(itemRows / 2), itemCount - itemRows));
    end = start + itemRows;
    above = start;
    below = itemCount - end;
  }

  return {
    scrollOffset: start,
    startIndex: start,
    endIndex: end,
    aboveCount: above,
    belowCount: below,
  };
}

function clampIndex(index: number, itemCount: number): number {
  if (itemCount <= 0) return 0;
  return Math.max(0, Math.min(index, itemCount - 1));
}

/**
 * Handle navigation keys for a modal picker. Filter changes reset selection to 0.
 */
export function handlePickerKey(
  key: PickerKeyInput,
  state: PickerNavigationState,
  itemCount: number,
  maxListRows: number,
  options?: { filterable?: boolean },
): PickerKeyAction {
  const filterable = options?.filterable ?? true;

  if (key.escape) {
    return { type: "close" };
  }

  if (key.return || key.tab) {
    if (itemCount > 0) return { type: "select" };
    return { type: "none" };
  }

  if (filterable && (key.backspace || key.delete)) {
    const nextFilter = state.filter.slice(0, -1);
    return { type: "update", selectedIndex: 0, filter: nextFilter };
  }

  if (filterable && key.inputStr && !key.ctrl && !key.meta) {
    return {
      type: "update",
      selectedIndex: 0,
      filter: state.filter + key.inputStr,
    };
  }

  if (itemCount === 0) {
    return { type: "none" };
  }

  const viewport = computePickerViewport(itemCount, state.selectedIndex, maxListRows);
  const pageSize = Math.max(1, viewport.endIndex - viewport.startIndex);

  if (key.upArrow) {
    return {
      type: "update",
      selectedIndex: clampIndex(state.selectedIndex - 1, itemCount),
      filter: state.filter,
    };
  }

  if (key.downArrow) {
    return {
      type: "update",
      selectedIndex: clampIndex(state.selectedIndex + 1, itemCount),
      filter: state.filter,
    };
  }

  if (key.pageUp) {
    return {
      type: "update",
      selectedIndex: clampIndex(state.selectedIndex - pageSize, itemCount),
      filter: state.filter,
    };
  }

  if (key.pageDown) {
    return {
      type: "update",
      selectedIndex: clampIndex(state.selectedIndex + pageSize, itemCount),
      filter: state.filter,
    };
  }

  return { type: "none" };
}
