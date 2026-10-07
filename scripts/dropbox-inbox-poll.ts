#!/usr/bin/env bun
/**
 * Holt Prompts aus dem Dropbox-Inbox-Ordner nach ~/inbox/.
 * Aufruf durch den systemd-user-Timer `dropbox-inbox.timer` (alle 10 s).
 *
 * Fehlt der Dropbox-Zugang (EA_DROPBOX_*), endet das Skript still mit 0 —
 * dann ist das Feature einfach nicht eingerichtet.
 */
import { createDropboxAdapter } from '../src/adapters/dropbox.js';
import { processDropboxInboxOnce } from '../src/modules/dropbox-inbox/index.js';

const appKey = process.env.EA_DROPBOX_APP_KEY;
const appSecret = process.env.EA_DROPBOX_APP_SECRET;
const refreshToken = process.env.EA_DROPBOX_REFRESH_TOKEN;

if (!appKey || !appSecret || !refreshToken) {
  process.exit(0);
}

const adapter = createDropboxAdapter({ appKey, appSecret, refreshToken });

try {
  const results = await processDropboxInboxOnce({
    adapter,
    homeDir: process.env.HOME || '/home/biko',
    logger: {
      info: (m: string) => process.stdout.write(m + '\n'),
      warn: (m: string) => process.stderr.write(m + '\n'),
    },
  });
  if (results.length > 0) {
    process.stdout.write(`Dropbox-Inbox: ${results.length} Datei(en) nach ~/inbox/ gelegt.\n`);
  }
} catch (e: any) {
  process.stderr.write(`Dropbox-Inbox Fehler: ${e.message}\n`);
  process.exit(1);
}
