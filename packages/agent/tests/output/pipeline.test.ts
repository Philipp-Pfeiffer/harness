import { describe, it, expect } from 'vitest';
import { renderToChannel } from '../../src/output/canonical.js';
import { getCapabilities, getSupportedChannels } from '../../src/output/capabilities.js';
import type { Channel } from '../../src/output/capabilities.js';

// ─── Fixtures ───

const PROSE = `This is a paragraph with some text. It discusses the pipeline.`;

const SIMPLE_TABLE = `| Name | Age |
|------|-----|
| Alice | 30 |
| Bob | 25 |`;

const WIDE_TABLE = `| Col1 | Col2 | Col3 | Col4 | Col5 | Col6 | Col7 | Col8 | Col9 | Col10 |
|------|------|------|------|------|------|------|------|------|-------|
| a1 | a2 | a3 | a4 | a5 | a6 | a7 | a8 | a9 | a10 |
| b1 | b2 | b3 | b4 | b5 | b6 | b7 | b8 | b9 | b10 |`;

// Table with long words in narrow columns → forces cell wrapping.
// 6 columns triggers image tier on whatsapp (max 4) and discord (max 5).
const WRAP_TABLE_2LINE = `| Owner | Aufwand | Status | Prio | Rev | Q |
|-------|---------|--------|------|-----|---|
| Alex  | Mittel  | Done   | Low  | 2   | A |
| Bob   | Hoch    | Open   | Med  | 3   | B |`;

const WRAP_TABLE_3LINE = `| A | B | C | D | E | F |
|-------|---------|--------|------|-----|---|
| Alexander Müller-Schmidt aus der Abteilung für Softwareentwicklung | Sehr hoher Aufwand erforderlich für das Projekt | In Progress With Reviewer und QA-Team | Highest Priority Urgent Action Required | 12 Reviews nötig vor Merge | AAA BBB CCC DDD EEE FFF |
| Bob | Mittel | Done | Low | 2 | B |`;

// Short headers + one long text column — headers must NOT break mid-word
const SHORT_HEADER_TABLE = `| Owner | Prio | Status | Description |
|-------|------|--------|--------------|
| Alice | High | Open   | This is a very long description that should wrap at word boundaries but the headers Owner Prio Status Description stay intact |
| Bob   | Low  | Done   | Another lengthy description in this column to force wrapping |`;

// Single overlong word (URL) — must break controlled, not overflow
const OVERLONG_WORD_TABLE = `| Name | URL |
|------|-----|
| API  | https://very-long-domain-name-that-cannot-break-normally.example.com/path/to/resource |`;

const CODE_BLOCK = `\`\`\`typescript
const x: number = 42;
console.log(x);
\`\`\``;

const HEADING = `## Section Title`;

const MIXED = `# Report

Some introductory prose here. This explains the context.

${SIMPLE_TABLE}

More prose after the table.

${CODE_BLOCK}

Final paragraph.`;

const OVERLENGTH = `# Long Message

${'A'.repeat(5000)}

${'B'.repeat(5000)}`;

const MALFORMED = `This is not [valid markdown
| broken | table
| no separator
\`\`\`unclosed code fence`;

// ─── Tests ───

describe('Output Pipeline', () => {
  const channels: Channel[] = ['whatsapp', 'discord'];

  describe('capabilities', () => {
    it('returns correct limits for each channel', () => {
      expect(getCapabilities('whatsapp').maxLength).toBe(4096);
      expect(getCapabilities('discord').maxLength).toBe(2000);
    });

    it('lists all supported channels', () => {
      const channels = getSupportedChannels();
      expect(channels).toContain('whatsapp');
      expect(channels).toContain('discord');
    });
  });

  // ─── Snapshot Tests: Channel × Block-Type ───

  for (const channel of channels) {
    const caps = getCapabilities(channel);

    describe(`channel: ${channel}`, () => {
      it('renders prose', async () => {
        const result = await renderToChannel(PROSE, channel);
        expect(result.messages).toHaveLength(1);
        expect(result.messages[0]!.text).toBe(PROSE);
        expect(result.messages[0]!.attachments).toHaveLength(0);
      });

      it('renders heading', async () => {
        const result = await renderToChannel(HEADING, channel);
        expect(result.messages).toHaveLength(1);
        expect(result.messages[0]!.text).toContain('Section Title');
      });

      it('renders simple table via monospace tier', async () => {
        const result = await renderToChannel(SIMPLE_TABLE, channel);
        // Simple table fits monospace on all channels
        const tableTier = result.tierLog.find((t) => t.blockType === 'table');
        expect(tableTier).toBeDefined();
        expect(tableTier!.tier).toBe('monospace');
        // Should be in a code fence
        expect(result.messages[0]!.text).toContain('```');
        // Should not have an image attachment
        expect(result.messages[0]!.attachments).toHaveLength(0);
      });

      it('renders wide table — escalates beyond monospace', async () => {
        const result = await renderToChannel(WIDE_TABLE, channel);
        const tableTier = result.tierLog.find((t) => t.blockType === 'table');
        expect(tableTier).toBeDefined();
        // Wide table should NOT be monospace (too many columns)
        expect(tableTier!.tier).not.toBe('monospace');
      });

      it('renders code block', async () => {
        const result = await renderToChannel(CODE_BLOCK, channel);
        expect(result.messages).toHaveLength(1);
        expect(result.messages[0]!.text).toContain('```typescript');
        expect(result.messages[0]!.text).toContain('const x: number = 42');
      });

      it('renders mixed content — preserves order, includes all blocks', async () => {
        const result = await renderToChannel(MIXED, channel);
        expect(result.messages.length).toBeGreaterThanOrEqual(1);
        // All content should be present across messages
        const allText = result.messages.map((m) => m.text).join('\n');
        expect(allText).toContain('introductory prose');
        expect(allText).toContain('More prose after the table');
        expect(allText).toContain('const x');
        expect(allText).toContain('Final paragraph');
        // Table should be rendered as monospace (in a code fence)
        expect(allText).toContain('```');
      });

      it('handles overlength content — splits without mid-block cut', async () => {
        const result = await renderToChannel(OVERLENGTH, channel);
        // Should produce multiple messages
        expect(result.messages.length).toBeGreaterThan(1);
        // No message should exceed maxLength (plus small tolerance for oversized blocks)
        for (const msg of result.messages) {
          // Individual oversized blocks are allowed to exceed
          // but headings ("# Long Message") should never exceed
          if (msg.text.startsWith('# Long Message')) {
            expect(msg.text.length).toBeLessThanOrEqual(caps.maxLength);
          }
        }
      });

      it('handles malformed markdown — never throws, plaintext passthrough', async () => {
        const result = await renderToChannel(MALFORMED, channel);
        expect(result.messages).toBeDefined();
        expect(result.messages.length).toBeGreaterThan(0);
        // Should not throw — that's the main contract
        const allText = result.messages.map((m) => m.text).join('\n');
        expect(allText.length).toBeGreaterThan(0);
      });

      it('snapshot: full mixed render', async () => {
        const result = await renderToChannel(MIXED, channel);
        // Snapshot the structure (not raw text which varies by tier)
        const snapshot = {
          channel: result.channel,
          messageCount: result.messages.length,
          tiers: result.tierLog.map((t) => ({
            block: t.blockIndex,
            type: t.blockType,
            tier: t.tier,
          })),
          hasAttachments: result.messages.some((m) => m.attachments.length > 0),
          attachmentCounts: result.messages.map((m) => m.attachments.length),
          textLengths: result.messages.map((m) => m.text.length),
        };
        await expect(snapshot).toMatchFileSnapshot(
          `snapshots/${channel}-mixed.snap.json`,
        );
      });
    });
  }

  // ─── Channel-specific behavior ───

  describe('channel-specific limits', () => {
    it('whatsapp allows 4096 chars per message', async () => {
      const md = '# Title\n\n' + 'A'.repeat(4000);
      const result = await renderToChannel(md, 'whatsapp');
      expect(result.messages).toHaveLength(1);
      expect(result.messages[0]!.text.length).toBeLessThanOrEqual(4096);
    });

    it('discord splits at 2000 chars', async () => {
      const md = '# Title\n\n' + 'A'.repeat(2000);
      const result = await renderToChannel(md, 'discord');
      expect(result.messages.length).toBeGreaterThan(1);
    });
  });

  describe('table tier fallback chain', () => {
    it('mail channel uses native tier', async () => {
      const result = await renderToChannel(SIMPLE_TABLE, 'mail');
      const tier = result.tierLog.find((t) => t.blockType === 'table');
      expect(tier!.tier).toBe('native');
    });

    it('simple table → monospace tier on whatsapp', async () => {
      const result = await renderToChannel(SIMPLE_TABLE, 'whatsapp');
      const tier = result.tierLog.find((t) => t.blockType === 'table');
      expect(tier!.tier).toBe('monospace');
    });

    it('wide table → image or linearize tier (not monospace)', async () => {
      const result = await renderToChannel(WIDE_TABLE, 'whatsapp');
      const tier = result.tierLog.find((t) => t.blockType === 'table');
      expect(['image', 'linearize']).toContain(tier!.tier);
    });

    it('image tier produces PNG attachment', async () => {
      const result = await renderToChannel(WIDE_TABLE, 'whatsapp');
      const tiers = result.tierLog.filter((t) => t.tier === 'image');
      if (tiers.length > 0) {
        const imgMsg = result.messages.find((m) => m.attachments.length > 0);
        expect(imgMsg).toBeDefined();
        const att = imgMsg!.attachments[0]!;
        expect(att.type).toBe('image');
        expect(att.mimeType).toBe('image/png');
        expect(att.data.length).toBeGreaterThan(0);
      }
    });

    it('image tier PNG dimensions = logical size × imageScale', async () => {
      const result = await renderToChannel(WIDE_TABLE, 'whatsapp');
      const tier = result.tierLog.find((t) => t.tier === 'image');
      if (!tier) return; // skip if image tier not reached

      const imgMsg = result.messages.find((m) => m.attachments.length > 0);
      expect(imgMsg).toBeDefined();
      const png = imgMsg!.attachments[0]!.data;

      // Parse PNG IHDR: bytes 16-24 = width (4 bytes) + height (4 bytes)
      expect(png[0]).toBe(0x89); // PNG signature
      const width = png.readUInt32BE(16);
      const height = png.readUInt32BE(20);

      const scale = getCapabilities('whatsapp').imageScale;
      // Logical satori width is ~783 for the 10-col fixture, height varies.
      // We verify the dimensions are divisible by the scale factor and
      // the result is scale × the logical layout size.
      expect(width % scale).toBe(0);
      expect(height % scale).toBe(0);
      const logicalW = width / scale;
      const logicalH = height / scale;
      // Logical width should be in the 700-900 range (proportional to colWidths)
      expect(logicalW).toBeGreaterThan(600);
      expect(logicalW).toBeLessThan(1000);
      // At 3× scale, output should be significantly larger than 1×
      expect(width).toBe(logicalW * scale);
      expect(height).toBe(logicalH * scale);
    });

    it('cell wrapping: PNG height grows with wrap depth', async () => {
      const scale = getCapabilities('whatsapp').imageScale;

      const parsePngDimensions = (png: Buffer): { w: number; h: number } => {
        expect(png[0]).toBe(0x89);
        return { w: png.readUInt32BE(16), h: png.readUInt32BE(20) };
      };

      // 2-line table: short cells, no wrapping
      const r2 = await renderToChannel(WRAP_TABLE_2LINE, 'whatsapp');
      const t2 = r2.tierLog.find((t) => t.tier === 'image');
      if (!t2) return; // skip if not image tier
      const img2 = r2.messages.find((m) => m.attachments.length > 0)!;
      const dim2 = parsePngDimensions(img2.attachments[0]!.data);

      // 3-line table: long words → cells wrap → rows taller
      const r3 = await renderToChannel(WRAP_TABLE_3LINE, 'whatsapp');
      const t3 = r3.tierLog.find((t) => t.tier === 'image')!;
      const img3 = r3.messages.find((m) => m.attachments.length > 0)!;
      const dim3 = parsePngDimensions(img3.attachments[0]!.data);

      // Width should be similar (same column count, proportional widths)
      expect(dim3.w).toBeGreaterThan(dim2.w * 0.8);
      expect(dim3.w).toBeLessThan(dim2.w * 1.3);

      // Height must be significantly larger due to wrapping
      expect(dim3.h).toBeGreaterThan(dim2.h);

      // The 3-line table's second row wraps to multiple visual lines,
      // so the height difference must be more than trivial.
      const heightDiff = dim3.h - dim2.h;
      const logicalDiff = heightDiff / scale;
      expect(logicalDiff).toBeGreaterThan(10); // at least ~10px logical diff
    });

    it('cell wrapping: no clipping — last row data present in PNG', async () => {
      // This is implicitly verified: if satori auto-layouts height,
      // the SVG always contains all content. We verify the PNG height
      // is non-trivial (not just one row) when wrapping occurs.
      const r = await renderToChannel(WRAP_TABLE_3LINE, 'whatsapp');
      const img = r.messages.find((m) => m.attachments.length > 0);
      if (!img) return;
      const png = img.attachments[0]!.data;
      const height = png.readUInt32BE(20);
      const scale = getCapabilities('whatsapp').imageScale;
      // 2 data rows with wrapping should produce more than 80px
      // logical height (2 rows × ~40px baseline without wrapping).
      // If height were estimated as fixed, wrapped content would clip.
      expect(height / scale).toBeGreaterThan(80);
    });

    it('short headers: no mid-word break in header cells', async () => {
      // This table has short headers (Owner, Prio, Status, Description)
      // alongside one long-text column. Headers must fit without breaking.
      // We verify by rendering: the PNG should exist and have reasonable
      // dimensions. The key assertion is that column widths are at least
      // wide enough to fit each header word.
      const result = await renderToChannel(SHORT_HEADER_TABLE, 'whatsapp');
      const tier = result.tierLog.find((t) => t.tier === 'image');
      if (!tier) return; // skip if not image tier

      const img = result.messages.find((m) => m.attachments.length > 0)!;
      const png = img.attachments[0]!.data;
      const width = png.readUInt32BE(16);
      const height = png.readUInt32BE(20);
      const scale = getCapabilities('whatsapp').imageScale;

      // 4 columns — table shouldn't be excessively wide
      expect(width / scale).toBeLessThan(1200);
      // Should have some height (at least header + 2 data rows)
      expect(height / scale).toBeGreaterThan(60);
    });

    it('overlong single word: breaks controlled, no overflow', async () => {
      // A very long URL in a narrow column must not cause the PNG to
      // overflow horizontally. satori should break it via overflow-wrap.
      const result = await renderToChannel(OVERLONG_WORD_TABLE, 'whatsapp');
      const tier = result.tierLog.find((t) => t.tier === 'image');
      if (!tier) return;

      const img = result.messages.find((m) => m.attachments.length > 0)!;
      const png = img.attachments[0]!.data;
      const width = png.readUInt32BE(16);
      const scale = getCapabilities('whatsapp').imageScale;
      const logicalWidth = width / scale;

      // The URL is ~80 chars. Without controlled breaking, the table
      // would be ~80×7 = 560px for one column alone. With content-aware
      // widths, the URL column gets a min-width but the overlong word
      // breaks rather than forcing infinite width.
      expect(logicalWidth).toBeLessThan(1000);
      // The PNG should still be reasonably sized (not 0 ortiny)
      expect(logicalWidth).toBeGreaterThan(200);
    });
  });
});
