import { Box, Text } from "ink";
import {
  computePickerListRows,
  computePickerViewport,
  type PickerViewport,
} from "./picker.js";

export interface ViewportPickerItem {
  key: string;
  label: string;
}

export interface ViewportPickerProps<T extends ViewportPickerItem> {
  title: string;
  items: readonly T[];
  selectedIndex: number;
  filter?: string;
  showFilter?: boolean;
  terminalRows: number;
  /** Rows used by status bar, prompt, and live content above the picker. */
  reservedRows: number;
  renderItem?: (item: T, index: number, selected: boolean) => string;
  emptyMessage?: string;
}

export function getPickerViewport<T extends ViewportPickerItem>(
  props: Pick<
    ViewportPickerProps<T>,
    "items" | "selectedIndex" | "terminalRows" | "reservedRows" | "showFilter" | "filter"
  >,
): { viewport: PickerViewport; listRows: number } {
  const headerRows = 1 + (props.showFilter !== false ? 1 : 0);
  const listRows = computePickerListRows(props.terminalRows, props.reservedRows, headerRows);
  const viewport = computePickerViewport(props.items.length, props.selectedIndex, listRows);
  return { viewport, listRows };
}

export function ViewportPicker<T extends ViewportPickerItem>({
  title,
  items,
  selectedIndex,
  filter = "",
  showFilter = true,
  terminalRows,
  reservedRows,
  renderItem,
  emptyMessage = "No matches.",
}: ViewportPickerProps<T>) {
  const { viewport } = getPickerViewport({
    items,
    selectedIndex,
    terminalRows,
    reservedRows,
    showFilter,
    filter,
  });

  const visibleItems = items.slice(viewport.startIndex, viewport.endIndex);

  return (
    <Box flexDirection="column" marginY={1} paddingLeft={2}>
      <Text bold>{title}</Text>
      {showFilter && (
        <Text dimColor>Filter: {filter || "(type to filter)"}</Text>
      )}
      {items.length === 0 && <Text color="gray">{emptyMessage}</Text>}
      {viewport.aboveCount > 0 && (
        <Text dimColor>▲ {viewport.aboveCount} more</Text>
      )}
      {visibleItems.map((item, offset) => {
        const idx = viewport.startIndex + offset;
        const selected = idx === selectedIndex;
        const text = renderItem ? renderItem(item, idx, selected) : item.label;
        return (
          <Text
            key={item.key}
            color={selected ? "cyan" : "gray"}
            bold={selected}
          >
            {text}
          </Text>
        );
      })}
      {viewport.belowCount > 0 && (
        <Text dimColor>▼ {viewport.belowCount} more</Text>
      )}
    </Box>
  );
}
