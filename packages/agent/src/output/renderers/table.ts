/**
 * Table renderer with 4-tier fallback chain:
 *
 * 1. native      — GFM markdown table (if channel supports it)
 * 2. monospace   — ASCII-aligned table inside a code fence
 * 3. image       — PNG rendered via satori + @resvg/resvg-js (if too wide/complex)
 * 4. linearize   — key-value list (ultimate fallback)
 *
 * Heuristic: image tier only when table is too wide or has too many columns
 *            for readable monospace rendering.
 */

import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import type { Table } from 'mdast';
import type { ReactNode } from 'react';
import satori from 'satori';
import { Resvg } from '@resvg/resvg-js';

import type { ChannelCapabilities } from '../capabilities.js';
import type {
  Attachment,
  RenderedBlock,
  TableTier,
  TierLog,
} from '../canonical.js';
import { extractRaw } from '../canonical.js';

// ─── Public API ───

export async function renderTable(
  table: Table,
  caps: ChannelCapabilities,
  fontPath: string,
  blockIndex: number,
  tierLog: TierLog[],
): Promise<RenderedBlock> {
  const rows = extractRows(table);

  // Tier 1: native GFM table
  if (caps.supportsNativeTables) {
    logTier(tierLog, blockIndex, 'native');
    return { text: tableToMarkdown(table), blockType: 'table', tier: 'native' };
  }

  // Tier 2: monospace ASCII-aligned in code fence
  const mono = tableToMonospace(rows, caps);
  if (mono.fits) {
    logTier(tierLog, blockIndex, 'monospace');
    return { text: mono.text, blockType: 'table', tier: 'monospace' };
  }

  // Tier 3: image (only if too wide/complex for monospace)
  try {
    const attachment = await tableToImage(rows, fontPath, caps.imageScale);
    logTier(tierLog, blockIndex, 'image', mono.reason);
    return {
      text: '',
      attachment,
      blockType: 'table',
      tier: 'image',
      reason: mono.reason,
    };
  } catch {
    // Tier 4: linearize as key-value list
    logTier(tierLog, blockIndex, 'linearize');
    return {
      text: tableToLinearized(rows),
      blockType: 'table',
      tier: 'linearize',
    };
  }
}

// ─── Tier 1: Native ───

/** Pass the raw GFM table through (channel renders it natively). */
function tableToMarkdown(table: Table): string {
  // We need the original markdown; reconstruct from AST if needed.
  // Since table nodes may not carry position in all callers, we rebuild.
  const lines: string[] = [];
  for (const child of table.children) {
    if (child.type === 'tableRow') {
      const cells = child.children
        .filter((c) => c.type === 'tableCell')
        .map((c) => cellText(c));
      lines.push('| ' + cells.join(' | ') + ' |');
    }
  }
  // Insert separator after first row (header)
  if (lines.length >= 1) {
    const colCount = lines[0]!.split('|').length - 2;
    const sep = '| ' + Array(colCount).fill('---').join(' | ') + ' |';
    lines.splice(1, 0, sep);
  }
  return lines.join('\n');
}

// ─── Tier 2: Monospace ───

interface MonospaceResult {
  fits: boolean;
  text: string;
  reason?: string;
}

function tableToMonospace(
  rows: string[][],
  caps: ChannelCapabilities,
): MonospaceResult {
  if (rows.length === 0) {
    return { fits: true, text: '' };
  }

  const colCount = rows[0]!.length;

  // Check column count
  if (colCount > caps.maxTableColumns) {
    return {
      fits: false,
      text: '',
      reason: `${colCount} columns exceed max ${caps.maxTableColumns}`,
    };
  }

  // Calculate column widths
  const widths: number[] = new Array(colCount).fill(0);
  for (const row of rows) {
    for (let c = 0; c < colCount; c++) {
      const cellLen = (row[c] ?? '').length;
      if (cellLen > widths[c]!) widths[c] = cellLen;
    }
  }

  // Total width = sum of column widths + padding + separators
  // Each cell: " content " + "|" = width + 3
  const totalWidth = widths.reduce((a, b) => a + b, 0) + colCount * 3 + 1;

  if (totalWidth > caps.maxMonospaceWidth) {
    return {
      fits: false,
      text: '',
      reason: `width ${totalWidth} exceeds max ${caps.maxMonospaceWidth}`,
    };
  }

  // Build ASCII-aligned table
  const lines: string[] = [];
  const header = rows[0]!;
  const data = rows.slice(1);

  const formatRow = (row: string[]): string => {
    const cells = row.map((cell, i) => {
      const w = widths[i]!;
      return ' ' + cell.padEnd(w) + ' ';
    });
    return '|' + cells.join('|') + '|';
  };

  const separator = () => {
    const cells = widths.map((w) => '-'.repeat(w + 2));
    return '|' + cells.join('|') + '|';
  };

  lines.push(formatRow(header));
  lines.push(separator());
  for (const row of data) {
    lines.push(formatRow(row));
  }

  return {
    fits: true,
    text: '```\n' + lines.join('\n') + '\n```',
  };
}

// ─── Tier 3: Image (satori + resvg) ───

async function tableToImage(
  rows: string[][],
  fontPath: string,
  imageScale: number,
): Promise<Attachment> {
  const fontData = await loadFont(fontPath);

  // Column widths: content widths only (padding/border added below)
  const maxCanvasWidth = 700;
  const colWidths = calculateColWidths(rows, maxCanvasWidth);
  // Total width = content + cell padding (10px each side) + right border per cell + root border
  const tableWidth = colWidths.reduce((a, b) => a + b, 0) + colWidths.length * 21 + 2;

  const elements = buildTableElement(rows, colWidths);

  // Let satori auto-layout the height — calling with width only
  // ensures cells that wrap to multiple lines are never clipped.
  const svg = await satori(elements as unknown as ReactNode, {
    width: tableWidth,
    fonts: [{ name: 'NotoSans', data: fontData, weight: 400 }],
  });

  const resvg = new Resvg(svg, {
    fitTo: { mode: 'zoom', value: imageScale },
    background: '#ffffff',
  });
  const png = resvg.render().asPng();

  return {
    type: 'image',
    mimeType: 'image/png',
    data: Buffer.from(png),
    filename: 'table.png',
  };
}

/** Build a satori-compatible element tree for a table. */
function buildTableElement(
  rows: string[][],
  colWidths: number[],
): Record<string, unknown> {
  const header = rows[0]!;
  const data = rows.slice(1);

  const makeCell = (
    text: string,
    width: number,
    isHeader: boolean,
  ): Record<string, unknown> => ({
    type: 'div',
    props: {
      style: {
        display: 'flex',
        width: `${width}px`,
        padding: '8px 10px',
        borderBottom: '1px solid #e0e0e0',
        borderRight: '1px solid #e0e0e0',
        fontSize: '13px',
        fontFamily: 'NotoSans',
        fontWeight: isHeader ? 700 : 400,
        color: '#1a1a1a',
        backgroundColor: isHeader ? '#f5f5f5' : '#ffffff',
        overflow: 'hidden',
        overflowWrap: 'break-word',
      },
      children: text,
    },
    key: null,
  });

  const makeRow = (
    cells: string[],
    isHeader: boolean,
  ): Record<string, unknown> => ({
    type: 'div',
    props: {
      style: {
        display: 'flex',
        flexDirection: 'row',
        width: '100%',
      },
      children: cells.map((text, i) =>
        makeCell(text, colWidths[i]!, isHeader),
      ),
    },
    key: null,
  });

  return {
    type: 'div',
    props: {
      style: {
        display: 'flex',
        flexDirection: 'column',
        width: '100%',
        border: '1px solid #d0d0d0',
        borderRadius: '4px',
        overflow: 'hidden',
      },
      children: [
        makeRow(header, true),
        ...data.map((row, i) => ({
          type: 'div',
          props: {
            style: { display: 'flex', flexDirection: 'row', width: '100%' },
            children: row.map((text, j: number) =>
              makeCell(text, colWidths[j]!, false),
            ),
          },
          key: `row-${i}`,
        })),
      ],
    },
    key: 'table-root',
  };
}

/**
 * Calculate content-aware column widths.
 *
 * Each column gets at least enough width to fit its longest single word
 * (header included), so headers like "Owner" never break mid-word.
 * The table is only as wide as the content requires, capped at maxWidth.
 * Narrow tables stay narrow instead of being stretched to the full canvas.
 */
function calculateColWidths(rows: string[][], maxWidth: number): number[] {
  const colCount = rows[0]?.length ?? 0;
  if (colCount === 0) return [];

  // Min width per column = longest single word across all rows (incl. header)
  const minWordLens: number[] = new Array(colCount).fill(1);
  // Preferred width per column = longest total cell content
  const contentLens: number[] = new Array(colCount).fill(1);

  for (const row of rows) {
    for (let c = 0; c < colCount; c++) {
      const cell = row[c] ?? '';
      const words = cell.split(/\s+/);
      for (const word of words) {
        // Approximate rendering width: char count × ~7px at 13px font
        const wordWidth = word.length;
        if (wordWidth > minWordLens[c]!) minWordLens[c] = wordWidth;
      }
      if (cell.length > contentLens[c]!) contentLens[c] = cell.length;
    }
  }

  const pxPerChar = 7;
  // makeCell adds 10px padding on each side, so 20px total horizontal padding per cell.
  const cellHorizontalPadding = 20;
  const minWidths = minWordLens.map((len) => len * pxPerChar);
  const preferredWidths = contentLens.map((len) => len * pxPerChar);

  // Natural width = at least min width, at most preferred content width
  let widths = preferredWidths.map((w, i) => Math.max(w, minWidths[i]!));
  const naturalContentWidth = widths.reduce((a, b) => a + b, 0);
  // Total rendered width = content + cell padding + 1px right border per cell + root left/right border
  const naturalWidth = naturalContentWidth + colCount * (cellHorizontalPadding + 1) + 2;

  if (naturalWidth > maxWidth) {
    // Content is too wide — scale down proportionally, but never below min width
    const excess = naturalWidth - maxWidth;
    const shrinkable = widths.map((w, i) => w - minWidths[i]!).reduce((a, b) => a + b, 0);
    if (shrinkable > 0) {
      widths = widths.map((w, i) => {
        const shrink = Math.round((w - minWidths[i]!) / shrinkable * excess);
        return Math.max(minWidths[i]!, w - shrink);
      });
    }
  }

  return widths;
}

async function loadFont(fontPath: string): Promise<Buffer> {
  if (!existsSync(fontPath)) {
    throw new Error(`Font not found: ${fontPath}`);
  }
  return readFile(fontPath);
}

// ─── Tier 4: Linearize ───

function tableToLinearized(rows: string[][]): string {
  if (rows.length < 2) return '';
  const headers = rows[0]!;
  const dataRows = rows.slice(1);
  const lines: string[] = [];

  for (const row of dataRows) {
    const pairs = headers.map((h, i) => `${h}: ${row[i] ?? ''}`);
    lines.push(pairs.join(' | '));
  }

  return lines.join('\n');
}

// ─── Helpers ───

/** Extract rows from an MDAST table node into string[][]. */
function extractRows(table: Table): string[][] {
  const rows: string[][] = [];
  for (const child of table.children) {
    if (child.type !== 'tableRow') continue;
    const row: string[] = [];
    for (const cell of child.children) {
      if (cell.type === 'tableCell') {
        row.push(cellText(cell));
      }
    }
    rows.push(row);
  }
  return rows;
}

/** Extract plain text from a table cell. */
function cellText(cell: { children: unknown[] }): string {
  return extractTextFromNodes(cell.children).trim();
}

/** Recursively extract plain text from MDAST nodes. */
function extractTextFromNodes(nodes: unknown[]): string {
  const parts: string[] = [];
  for (const node of nodes) {
    if (typeof node !== 'object' || node === null) continue;
    const n = node as { type?: string; value?: string; children?: unknown[] };
    if (n.type === 'text' && typeof n.value === 'string') {
      parts.push(n.value);
    } else if (n.children) {
      parts.push(extractTextFromNodes(n.children));
    } else if (typeof n.value === 'string') {
      parts.push(n.value);
    }
  }
  return parts.join('');
}

function logTier(
  tierLog: TierLog[],
  blockIndex: number,
  tier: TableTier,
  reason?: string,
): void {
  tierLog.push({ blockIndex, blockType: 'table', tier, reason });
}

/**
 * Re-export extractRaw for circular safety (used internally by tableToMarkdown
 * when we want the original markdown). Currently unused but available.
 */
export { extractRaw };
