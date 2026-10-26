/**
 * Admin-Kanal der Prompt-Inbox (Owner-Auftrag 26.10.2026).
 *
 * `prompt-admin-*.txt` geht in die tmux-Sitzung `admin`, alles andere wie
 * bisher nach `bikosoc`. Kontrollfläche (C7): Neben dem Regelfall stehen hier
 * die Negativfälle — ähnliche Namen, fehlende Admin-Sitzung, Rückfall auf den
 * Fachkanal, Optionsinjektion über den Text, Wächter.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { processPromptInboxOnce, istAdminAuftrag, offeneAuftraege, ADMIN_TMUX_TARGET } from '../index.js';
import type { TmuxRunner } from '../../cc-prompt-dispatch/index.js';

const wurzeln: string[] = [];
afterEach(() => { for (const w of wurzeln.splice(0)) fs.rmSync(w, { recursive: true, force: true }); });

function umgebung(dateien: Record<string, string>) {
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'admin-kanal-'));
  wurzeln.push(homeDir);
  const inboxDir = path.join(homeDir, 'inbox');
  fs.mkdirSync(inboxDir, { recursive: true });
  let t = Date.now() / 1000 - 100;
  for (const [name, inhalt] of Object.entries(dateien)) {
    const p = path.join(inboxDir, name);
    fs.writeFileSync(p, inhalt);
    fs.utimesSync(p, t, t);
    t += 1;
  }
  const aufrufe: { file: string; args: string[] }[] = [];
  const runner: TmuxRunner = (file, args) => { aufrufe.push({ file, args }); };
  return { homeDir, inboxDir, aufrufe, runner };
}

const ziele = (a: { args: string[] }[]) => a.map(x => x.args[2]);
const BEREIT = '> \n';
const now = new Date('2026-10-26T13:30:00.000Z');

describe('Weiche nach Dateiname', () => {
  test('erkennt Admin-Aufträge, auch hinter den Transportvorsätzen', () => {
    for (const n of [
      'prompt-admin-test.txt',
      'prompt-admin-kanal-einrichten-20261026.txt',
      'dropbox-20261026-135350-prompt-admin-kanal-einrichten-20261026.txt',
      '2026-10-26T13-20-50-083Z-dropbox-20261026-135350-prompt-admin-x.txt',
      'auftrag-mail-20261026-1400-prompt-admin-backup.txt',
    ]) expect(istAdminAuftrag(n)).toBe(true);
  });

  test('ähnliche Namen gehen den bisherigen Weg', () => {
    for (const n of [
      'prompt-administration.txt',        // kein Bindestrich nach „admin"
      'prompt-admin.txt',                 // nichts nach dem Vorsatz
      'PROMPT-ADMIN-test.txt',            // Großschreibung
      'x-prompt-admin-test.txt',          // fremder Vorsatz
      'prompt-briefing-admin-test.txt',   // „admin" nur mittendrin
      'prompt-admin-test.md',             // keine .txt
      'dropbox-prompt-admin-test.txt.bak',
    ]) expect(istAdminAuftrag(n)).toBe(false);
  });
});

describe('Zustellung', () => {
  test('Regression: ein normaler Prompt läuft weiter nach bikosoc, Quittung unverändert', () => {
    const u = umgebung({ 'prompt-briefing-ausbau-20261026.txt': 'Fachauftrag' });
    const lauf = processPromptInboxOnce({ homeDir: u.homeDir, now, runner: u.runner, paneText: BEREIT, adminPaneText: BEREIT });
    expect(ziele(u.aufrufe)).toEqual(['bikosoc', 'bikosoc']);
    expect(u.aufrufe[0].args).toEqual(['send-keys', '-t', 'bikosoc', '--', 'Fachauftrag']);
    expect(path.basename(lauf.zugestellt[0].reportPath)).toBe('report-prompt-inbox-20261026-143000.md');
    expect(fs.readFileSync(lauf.zugestellt[0].reportPath, 'utf-8')).not.toContain('[ADMIN]');
  });

  test('Admin-Auftrag geht in die Sitzung admin, mit eigener Quittung', () => {
    const u = umgebung({ 'prompt-admin-test.txt': 'Serverauftrag' });
    const lauf = processPromptInboxOnce({ homeDir: u.homeDir, now, runner: u.runner, paneText: BEREIT, adminPaneText: BEREIT });
    expect(ADMIN_TMUX_TARGET).toBe('admin:admin');
    expect(u.aufrufe[0].args).toEqual(['send-keys', '-t', 'admin:admin', '--', 'Serverauftrag']);
    expect(u.aufrufe[1].args).toEqual(['send-keys', '-t', 'admin:admin', 'Enter']);
    expect(ziele(u.aufrufe)).not.toContain('bikosoc');
    const quittung = lauf.zugestellt[0].reportPath;
    expect(path.basename(quittung)).toBe('report-prompt-inbox-admin-20261026-143000.md');
    expect(fs.readFileSync(quittung, 'utf-8')).toContain('titel: [ADMIN] ');
    expect(fs.existsSync(path.join(u.inboxDir, 'prompt-admin-test.txt'))).toBe(false);
  });

  test('beide Kanäle im selben Lauf: je eine Datei, zwei Quittungen', () => {
    const u = umgebung({ 'prompt-fach.txt': 'F', 'prompt-admin-a.txt': 'A' });
    const lauf = processPromptInboxOnce({ homeDir: u.homeDir, now, runner: u.runner, paneText: BEREIT, adminPaneText: BEREIT });
    expect(ziele(u.aufrufe)).toEqual(['bikosoc', 'bikosoc', 'admin:admin', 'admin:admin']);
    expect(new Set(lauf.zugestellt.map(z => z.reportPath)).size).toBe(2);
  });
});

describe('Negativfälle', () => {
  test('Admin-Sitzung läuft nicht: Datei bleibt liegen, kein Rückfall nach bikosoc', () => {
    const u = umgebung({ 'prompt-admin-test.txt': 'Serverauftrag' });
    const lauf = processPromptInboxOnce({ homeDir: u.homeDir, now, runner: u.runner, paneText: BEREIT, adminPaneText: '' });
    expect(u.aufrufe).toEqual([]);
    expect(lauf.zugestellt).toEqual([]);
    expect(lauf.zurueckgestellt[0].grund).toContain('Admin-Sitzung läuft nicht');
    expect(fs.existsSync(path.join(u.inboxDir, 'prompt-admin-test.txt'))).toBe(true);
  });

  test('fehlende Admin-Sitzung hält den Fachkanal nicht auf', () => {
    const u = umgebung({ 'prompt-admin-test.txt': 'A', 'prompt-fach.txt': 'F' });
    const lauf = processPromptInboxOnce({ homeDir: u.homeDir, now, runner: u.runner, paneText: BEREIT, adminPaneText: '' });
    expect(ziele(u.aufrufe)).toEqual(['bikosoc', 'bikosoc']);
    expect(u.aufrufe[0].args[4]).toBe('F');
    expect(lauf.zurueckgestellt.map(z => path.basename(z.sourcePath))).toEqual(['prompt-admin-test.txt']);
  });

  test('Admin-Instanz beschäftigt: Datei bleibt liegen, Fachkanal unberührt', () => {
    const u = umgebung({ 'prompt-admin-test.txt': 'A' });
    const lauf = processPromptInboxOnce({
      homeDir: u.homeDir, now, runner: u.runner, paneText: BEREIT,
      adminPaneText: '✻ Thinking… (12s · esc to interrupt)\n',
    });
    expect(u.aufrufe).toEqual([]);
    expect(lauf.zurueckgestellt).toHaveLength(1);
  });

  test('beschäftigter Fachkanal hält einen Admin-Auftrag nicht auf', () => {
    const u = umgebung({ 'prompt-fach.txt': 'F', 'prompt-admin-a.txt': 'A' });
    processPromptInboxOnce({
      homeDir: u.homeDir, now, runner: u.runner,
      paneText: '✻ Thinking… (12s · esc to interrupt)\n', adminPaneText: BEREIT,
    });
    expect(ziele(u.aufrufe)).toEqual(['admin:admin', 'admin:admin']);
  });

  test('Text, der wie eine tmux-Option aussieht, bleibt Text (Trenner --)', () => {
    const u = umgebung({ 'prompt-admin-x.txt': '-t bikosoc kill-server' });
    processPromptInboxOnce({ homeDir: u.homeDir, now, runner: u.runner, paneText: BEREIT, adminPaneText: BEREIT });
    expect(u.aufrufe[0].args).toEqual(['send-keys', '-t', 'admin:admin', '--', '-t bikosoc kill-server']);
  });

  test('ein Name mit „admin" mittendrin landet NICHT im Admin-Kanal', () => {
    const u = umgebung({ 'prompt-administration.txt': 'F' });
    processPromptInboxOnce({ homeDir: u.homeDir, now, runner: u.runner, paneText: BEREIT, adminPaneText: BEREIT });
    expect(ziele(u.aufrufe)).toEqual(['bikosoc', 'bikosoc']);
  });
});

describe('Leerlauf-Wächter stupst nur den Fachkanal', () => {
  test('abgelegte Admin-Aufträge gelten dort nicht als offen', () => {
    const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'admin-waechter-'));
    wurzeln.push(homeDir);
    const doneDir = path.join(homeDir, 'done');
    const reportDir = path.join(homeDir, 'spec');
    fs.mkdirSync(doneDir); fs.mkdirSync(reportDir);
    fs.writeFileSync(path.join(doneDir, '2026-10-26T13-20-50-083Z-dropbox-20261026-135350-prompt-admin-backup-20261026.txt'), 'A');
    fs.writeFileSync(path.join(doneDir, '2026-10-26T13-21-50-083Z-prompt-fach-test-20261026.txt'), 'F');
    const offen = offeneAuftraege({ doneDir, reportDir, now: new Date() });
    expect(offen.map(o => o.kennung)).toEqual(['prompt-fach-test']);
  });
});
