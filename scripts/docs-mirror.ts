#!/usr/bin/env bun
/**
 * Spiegelt die Markdown-Dokumentation der drei bikosoc-Repos nach Dropbox.
 *
 * Aufrufer:
 *   - git post-commit in executive-agent, executive-dashboard und workspace
 *     (scripts/hooks/post-commit, im Hintergrund)
 *   - systemd-user-Timer `docs-mirror.timer` als Sicherheitsnetz
 *     (taeglich 04:30 Europe/Berlin)
 *   - von Hand:  bun scripts/docs-mirror.ts [--dry-run] [--json]
 *
 * Fehlt der Dropbox-Zugang (EA_DROPBOX_*), endet das Skript still mit 0 —
 * dann ist das Feature einfach nicht eingerichtet.
 */
import path from 'node:path';
import { createDropboxAdapter } from '../src/adapters/dropbox.js';
import {
  DEFAULT_INDEX_PATH, defaultDocsMirrorRepos, formatDocsMirrorSummary, mirrorDocsOnce,
} from '../src/modules/docs-mirror/index.js';

const dryRun = process.argv.includes('--dry-run');
const alsJson = process.argv.includes('--json');

const home = process.env.HOME || '/home/biko';
const workspaceRoot = process.env.OPENCLAW_WORKSPACE || path.join(home, '.openclaw/workspace');
const indexPath = path.join(home, DEFAULT_INDEX_PATH);

const appKey = process.env.EA_DROPBOX_APP_KEY;
const appSecret = process.env.EA_DROPBOX_APP_SECRET;
const refreshToken = process.env.EA_DROPBOX_REFRESH_TOKEN;

if (!appKey || !appSecret || !refreshToken) {
  if (alsJson) process.stdout.write('{"skipped":"dropbox_not_configured"}\n');
  process.exit(0);
}

const adapter = createDropboxAdapter({ appKey, appSecret, refreshToken });

try {
  const result = await mirrorDocsOnce({
    adapter,
    repos: defaultDocsMirrorRepos(workspaceRoot),
    indexPath,
    dryRun,
    logger: {
      info: (m: string) => { if (!alsJson) process.stdout.write(`${m}\n`); },
      warn: (m: string) => process.stderr.write(`${m}\n`),
    },
  });

  if (alsJson) {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } else {
    process.stdout.write(
      `docs-mirror${dryRun ? ' (Trockenlauf)' : ''}: ${formatDocsMirrorSummary(result)}\n`,
    );
  }

  // Ein fehlgeschlagener Upload ist ein Fehler, aber kein Grund, den naechsten
  // Lauf zu verhindern — der Index behaelt fuer die Datei den alten Stand.
  process.exit(result.errors.length > 0 ? 1 : 0);
} catch (e: any) {
  process.stderr.write(`docs-mirror Fehler: ${e?.message}\n`);
  process.exit(1);
}
