#!/usr/bin/env bun
import { processPromptInboxOnce } from '../src/modules/prompt-inbox/index.js';

const homeDir = process.env.HOME || '/home/biko';

try {
  const results = processPromptInboxOnce({ homeDir });
  if (results.length > 0) {
    process.stdout.write(`Prompt-Inbox: ${results.length} Datei(en) uebergeben.\n`);
  }
} catch (e: any) {
  process.stderr.write(`Prompt-Inbox Fehler: ${e.message}\n`);
  process.exit(1);
}
