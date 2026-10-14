#!/usr/bin/env bun
/**
 * Ein Durchlauf der Prompt-Inbox plus Leerlauf-Wächter.
 *
 * Aufruf durch den systemd-user-Timer `prompt-inbox.timer` (alle 10 s).
 *
 * Zustellung erfolgt nur, wenn Claude Code aufnahmebereit ist — läuft gerade
 * ein Durchgang oder wartet ein Dialog, bleibt die Datei liegen. Der Wächter
 * stupst, wenn nichts mehr passiert, obwohl ein Auftrag offen ist.
 */
import { processPromptInboxOnce, leerlaufWaechter } from '../src/modules/prompt-inbox/index.js';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const homeDir = process.env.HOME || '/home/biko';

/** Telegram über den vorhandenen Weg; ein Fehler dabei darf den Lauf nicht kippen. */
function melde(text: string): void {
  try {
    execFileSync(`${homeDir}/.scripts/notify`, [text, 'warn', 'operativ'],
      { stdio: 'ignore', timeout: 10000 });
  } catch (e: any) {
    process.stderr.write(`Prompt-Inbox: Meldung fehlgeschlagen: ${e.message}\n`);
  }
}

/**
 * Wartemeldung der Roten Zone — ueber das Gateway, damit sie den Knopf
 * „Freigeben und übertragen" tragen kann. Ein Knopf braucht den Prozess, der
 * den Druck darauf entgegennimmt; dieser Waechter ist es nicht.
 */
function meldeArm(w: { gegenstand?: string; zeitpunkt?: string }): void {
  const token = leseToken();
  try {
    execFileSync('curl', [
      '-sS', '--max-time', '10', '-X', 'POST',
      'http://127.0.0.1:18789/api/internal/arm-wartet',
      '-H', 'Content-Type: application/json',
      ...(token ? ['-H', `Authorization: Bearer ${token}`] : []),
      '--data-raw', JSON.stringify({ grund: w.gegenstand ?? '', zeitpunkt: w.zeitpunkt ?? '' }),
    ], { stdio: 'ignore', timeout: 12000 });
  } catch (e: any) {
    process.stderr.write(`Prompt-Inbox: Wartemeldung fehlgeschlagen: ${e.message}\n`);
  }
}

/** Das Plugin-Token der Route. Fehlt es, laeuft der Aufruf ohne — die Route
 *  lehnt dann ab und der Waechter meldet es auf stderr. */
function leseToken(): string {
  try {
    const inhalt = readFileSync(`${homeDir}/.config/openclaw/env`, 'utf-8');
    return inhalt.match(/^CORE_SERVICE_TOKEN=(.+)$/m)?.[1]?.trim() ?? '';
  } catch { return ''; }
}

async function main() {
  const lauf = processPromptInboxOnce({ homeDir });

  if (lauf.zugestellt.length > 0) {
    process.stdout.write(`Prompt-Inbox: ${lauf.zugestellt.length} Datei(en) uebergeben.\n`);
  }
  for (const z of lauf.zurueckgestellt) {
    process.stdout.write(`Prompt-Inbox: zurueckgestellt (${z.grund}): ${z.sourcePath}\n`);
  }

  // Der Waechter laeuft nur, wenn nichts zugestellt wurde — sonst arbeitet
  // Claude Code ohnehin gerade an der gerade uebergebenen Datei.
  if (lauf.zugestellt.length === 0) {
    const w = await leerlaufWaechter({ homeDir, melde, meldeArm });
    if (w && 'armWartung' in w) {
      process.stdout.write(`Prompt-Inbox: wartet auf /arm (${w.armWartung}) — gemeldet.\n`);
    } else if (w && 'kennung' in w) {
      process.stdout.write(
        `Prompt-Inbox: Stups ${w.versuch} zu ${w.kennung}`
        + `${w.gemeldet ? ' (gemeldet, Waechter ruht jetzt)' : ''}\n`);
    }
  }
}

main()
  .then(() => process.exit(0))
  .catch((e: any) => {
    process.stderr.write(`Prompt-Inbox Fehler: ${e.message}\n`);
    process.exit(1);
  });
