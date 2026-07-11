#!/usr/bin/env node
/**
 * Standalone preview CLI for the output pipeline.
 *
 * Usage: node packages/agent/dist/output/preview.js --channel whatsapp <file.md>
 *
 * Prints rendered messages and attachment placeholders with PNG output paths.
 * No harness-CLI wiring — this is a standalone debugging tool.
 */

import { readFile } from 'node:fs/promises';
import { writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { renderToChannel } from './canonical.js';
import type { Channel } from './capabilities.js';
import { getCapabilities } from './capabilities.js';

const VALID_CHANNELS: readonly Channel[] = ['whatsapp', 'discord', 'signal', 'mail'];

function printUsage(): void {
  console.error(
    'Usage: preview --channel <channel> <file.md>\n' +
      'Channels: ' +
      VALID_CHANNELS.join(', '),
  );
  process.exit(1);
}

function parseArgs(argv: string[]): { channel: Channel; filePath: string } {
  let channel: Channel | null = null;
  let filePath: string | null = null;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === '--channel' || arg === '-c') {
      i++;
      const val = argv[i];
      if (!val || !VALID_CHANNELS.includes(val as Channel)) {
        console.error(`Invalid channel: ${val ?? '(missing)'}`);
        printUsage();
      }
      channel = val as Channel;
    } else if (!arg.startsWith('-')) {
      filePath = arg;
    }
  }

  if (!channel || !filePath) {
    printUsage();
  }

  return { channel: channel!, filePath: filePath! };
}

async function main(): Promise<void> {
  const { channel, filePath } = parseArgs(process.argv.slice(2));
  const caps = getCapabilities(channel);

  const markdown = await readFile(filePath, 'utf-8');
  const result = await renderToChannel(markdown, channel);

  console.log(`═══ Channel: ${channel} (maxLength: ${caps.maxLength}) ═══`);
  console.log(`═══ ${result.messages.length} message(s) ═══\n`);

  // Print tier log
  if (result.tierLog.length > 0) {
    console.log('─── Tier Log ───');
    for (const entry of result.tierLog) {
      const reason = entry.reason ? ` (${entry.reason})` : '';
      console.log(
        `  block[${entry.blockIndex}] ${entry.blockType} → ${entry.tier}${reason}`,
      );
    }
    console.log('');
  }

  // Print messages
  for (let i = 0; i < result.messages.length; i++) {
    const msg = result.messages[i]!;
    console.log(`─── Message ${i + 1}/${result.messages.length} ───`);

    if (msg.text) {
      console.log(msg.text);
    } else {
      console.log('(empty text)');
    }

    if (msg.attachments.length > 0) {
      console.log('\n  Attachments:');
      for (const att of msg.attachments) {
        // Write PNG to a file and print the path
        const outPath = join(
          dirname(fileURLToPath(import.meta.url)),
          '..',
          `preview-attachment-${i}.png`,
        );
        writeFileSync(outPath, att.data);
        console.log(
          `    [${att.type}] ${att.mimeType} (${att.data.length} bytes) → ${outPath}`,
        );
      }
    }

    console.log('');
  }
}

main().catch((err) => {
  console.error(
    'Preview failed:',
    err instanceof Error ? err.message : String(err),
  );
  process.exit(1);
});
