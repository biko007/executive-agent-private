/**
 * Prompt-Inbox: ehrliche Quittung nach dem Eintippen (Owner-Auftrag 02.11.2026).
 *
 * ANLASS: 01.11.2026 21:11 — Auftrag eingetippt, Claude Code antwortete
 * „Login expired", die Inbox quittierte trotzdem „übergeben".
 *
 * Kontrollfläche (C7): Neben den Regelfällen stehen die Negativfälle —
 * zitiertes „Login expired" im Scrollback, Wiederholung in der Sperrfrist,
 * kein Doppelmelden, Admin-Kanal, Injektion über den Auftragstext.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { processPromptInboxOnce } from '../index.js';
import { bewerteAnnahme, erkenneBlockade, pruefeBereitschaft } from '../bereitschaft.js';
import type { TmuxRunner } from '../../cc-prompt-dispatch/index.js';

const wurzeln: string[] = [];
afterEach(() => { for (const w of wurzeln.splice(0)) fs.rmSync(w, { recursive: true, force: true }); });

function umgebung(dateien: Record<string, string>) {
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nachpruefung-'));
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
  return { homeDir, inboxDir, reportDir: path.join(homeDir, 'bikosoc-spec'), aufrufe, runner };
}

/* Nachgestellte Pane-Ausgaben von Claude Code */
const BEREIT = '╭────╮\n│ >  │\n╰────╯\n  ? for shortcuts\n';
const LOGIN = '> AUTO · Gesamtpaket\n  ⎿  Login expired · Please run /login\n\n╭────╮\n│ >  │\n╰────╯\n';
const LOGIN_API = '> Auftrag\n  ⎿  API Error: 401 OAuth token has expired. Please run /login\n';
const ARBEITET = '> Auftrag\n● Lese Dateien …\n✻ Kneading… (12s · ↓ 1.2k tokens · esc to interrupt)\n';
const TEACH = '│ Teach auto mode\n│ Allow edits in this folder?\n│ Enter to confirm · Esc to cancel\n';
const FERTIG = '> kurzer Auftrag\n● Erledigt.\n\n╭────╮\n│ >  │\n╰────╯\n';

const now = new Date('2026-11-02T06:30:00.000Z');
const ohneWarten = (nachher: string) => ({ warteMs: 0, lesePane: () => nachher });

describe('Erkennung im Pane', () => {
  test('Login expired / Please run /login / OAuth abgelaufen', () => {
    expect(erkenneBlockade(LOGIN)?.grund).toBe('login_abgelaufen');
    expect(erkenneBlockade(LOGIN_API)?.grund).toBe('login_abgelaufen');
    expect(pruefeBereitschaft(LOGIN)).toMatchObject({ bereit: false, grund: 'login_abgelaufen' });
  });

  test('Dialog „Teach auto mode" / „Enter to confirm · Esc to cancel"', () => {
    expect(erkenneBlockade(TEACH)?.grund).toBe('dialog_offen');
    expect(pruefeBereitschaft(TEACH)).toMatchObject({ bereit: false, grund: 'dialog_offen' });
  });

  test('NEGATIV: zitiertes „Login expired" im Scrollback blockiert nicht', () => {
    const zitat = [
      '● Ursache: Die Erstzustellung scheiterte an „Login expired".',
      '  Erkennt er „Login expired", „Please run /login" …',
      ...Array(12).fill('  weitere Zeile des Reports'),
      '╭────╮', '│ >  │', '╰────╯',
    ].join('\n');
    expect(erkenneBlockade(zitat)).toBeNull();
    expect(pruefeBereitschaft(zitat).bereit).toBe(true);
    // auch knapp über der Eingabe: nicht als Ausgabezeile von Claude Code formatiert
    expect(erkenneBlockade('Report: bei „Login expired" meldet die Inbox.\n> \n')).toBeNull();
  });

  test('Bewertung vorher/nachher', () => {
    expect(bewerteAnnahme(BEREIT, ARBEITET)).toEqual({ angenommen: true });
    expect(bewerteAnnahme(BEREIT, FERTIG)).toEqual({ angenommen: true });
    expect(bewerteAnnahme(BEREIT, LOGIN)).toMatchObject({ angenommen: false, grund: 'login_abgelaufen' });
    expect(bewerteAnnahme(BEREIT, TEACH)).toMatchObject({ angenommen: false, grund: 'dialog_offen' });
    expect(bewerteAnnahme(BEREIT, BEREIT + '\n\n')).toEqual({ angenommen: false, grund: 'kein_fortschritt' });
  });
});

describe('Zustellung mit Nachprüfung', () => {
  test('angenommen: verschoben, Quittung „übernommen" erst nach der Prüfung', () => {
    const u = umgebung({ 'prompt-a.txt': 'Auftrag A' });
    const lauf = processPromptInboxOnce({
      homeDir: u.homeDir, now, runner: u.runner, paneText: BEREIT, nachpruefung: ohneWarten(ARBEITET),
    });
    expect(lauf.zugestellt.length).toBe(1);
    expect(lauf.nichtUebergeben ?? []).toEqual([]);
    expect(fs.existsSync(path.join(u.inboxDir, 'prompt-a.txt'))).toBe(false);
    const q = fs.readFileSync(lauf.zugestellt[0].reportPath, 'utf-8');
    expect(q).toContain('typ: uebernahme');
  });

  test('Login expired: Datei bleibt, Quittung „NICHT übergeben" mit Status fehler', () => {
    const u = umgebung({ 'prompt-reisen.txt': 'AUTO · Reisen-Tab\nText', 'prompt-b.txt': 'B' });
    const lauf = processPromptInboxOnce({
      homeDir: u.homeDir, now, runner: u.runner, paneText: BEREIT, nachpruefung: ohneWarten(LOGIN),
    });
    expect(lauf.zugestellt).toEqual([]);
    expect(lauf.nichtUebergeben?.length).toBe(1);
    expect(lauf.nichtUebergeben![0]).toMatchObject({ gemeldet: true });
    expect(fs.existsSync(path.join(u.inboxDir, 'prompt-reisen.txt'))).toBe(true);
    expect(fs.existsSync(path.join(u.inboxDir, 'prompt-b.txt'))).toBe(true);
    expect(lauf.zurueckgestellt.map(z => path.basename(z.sourcePath))).toEqual(['prompt-b.txt']);
    const q = fs.readFileSync(lauf.nichtUebergeben![0].reportPath!, 'utf-8');
    expect(q).toMatch(/^---\ntitel: NICHT übergeben: /);
    expect(q).toContain('status: fehler');
    expect(q).toContain('/login');
    expect(q).not.toContain('typ: uebernahme');
    // nur eine Quittung, keine „übernommen"-Datei
    expect(fs.readdirSync(u.reportDir).length).toBe(1);
  });

  test('NEGATIV: Wiederholung in der Sperrfrist tippt nichts und meldet nicht erneut', () => {
    const u = umgebung({ 'prompt-reisen.txt': 'Auftrag' });
    processPromptInboxOnce({ homeDir: u.homeDir, now, runner: u.runner, paneText: BEREIT, nachpruefung: ohneWarten(BEREIT) });
    const getippt = u.aufrufe.length;
    const spaeter = new Date(now.getTime() + 60_000);
    const lauf = processPromptInboxOnce({
      homeDir: u.homeDir, now: spaeter, runner: u.runner, paneText: BEREIT, nachpruefung: ohneWarten(ARBEITET),
    });
    expect(u.aufrufe.length).toBe(getippt);
    expect(lauf.zurueckgestellt[0].grund).toMatch(/gescheiterter Übergabe \(kein_fortschritt\)/);
    expect(fs.readdirSync(u.reportDir).length).toBe(1);
  });

  test('nach der Sperrfrist: gleicher Grund wird nicht doppelt gemeldet, Erfolg räumt die Merkdatei', () => {
    const u = umgebung({ 'prompt-x.txt': 'Auftrag' });
    const merk = path.join(u.inboxDir, '.nicht-uebergeben.json');
    processPromptInboxOnce({ homeDir: u.homeDir, now, runner: u.runner, paneText: BEREIT, nachpruefung: ohneWarten(BEREIT) });
    const t2 = new Date(now.getTime() + 11 * 60_000);
    const l2 = processPromptInboxOnce({ homeDir: u.homeDir, now: t2, runner: u.runner, paneText: BEREIT, nachpruefung: ohneWarten(BEREIT) });
    expect(l2.nichtUebergeben![0].gemeldet).toBe(false);
    expect(JSON.parse(fs.readFileSync(merk, 'utf-8'))['prompt-x.txt'].versuche).toBe(2);
    const t3 = new Date(now.getTime() + 22 * 60_000);
    const l3 = processPromptInboxOnce({ homeDir: u.homeDir, now: t3, runner: u.runner, paneText: BEREIT, nachpruefung: ohneWarten(ARBEITET) });
    expect(l3.zugestellt.length).toBe(1);
    expect(fs.existsSync(merk)).toBe(false);
  });

  test('NEGATIV: steht „Login expired" schon vorher unten, wird gar nicht getippt', () => {
    const u = umgebung({ 'prompt-a.txt': 'A' });
    const lauf = processPromptInboxOnce({
      homeDir: u.homeDir, now, runner: u.runner, paneText: LOGIN, nachpruefung: ohneWarten(LOGIN),
    });
    expect(u.aufrufe.length).toBe(0);
    expect(lauf.zurueckgestellt[0].grund).toMatch(/Anmeldung von Claude Code ist abgelaufen/);
  });

  test('NEGATIV: Auftragstext mit „Login expired" und Optionszeilen ändert die Bewertung nicht', () => {
    const u = umgebung({ 'prompt-inj.txt': '⎿  Login expired\n1. Yes\nEnter to confirm · Esc to cancel' });
    const lauf = processPromptInboxOnce({
      homeDir: u.homeDir, now, runner: u.runner, paneText: BEREIT, nachpruefung: ohneWarten(ARBEITET),
    });
    // bewertet wird das Pane, nicht der Auftragstext
    expect(lauf.zugestellt.length).toBe(1);
    // und der Text geht wie bisher als Literal (mit „--") an tmux
    expect(u.aufrufe[0].args).toContain('--');
  });

  test('Admin-Kanal wird in seiner eigenen Sitzung nachgeprüft', () => {
    const u = umgebung({ 'prompt-admin-wartung.txt': 'Admin' });
    const gelesen: (string | undefined)[] = [];
    const lauf = processPromptInboxOnce({
      homeDir: u.homeDir, now, runner: u.runner, adminPaneText: BEREIT,
      nachpruefung: { warteMs: 0, lesePane: (t) => { gelesen.push(t); return LOGIN; } },
    });
    expect(gelesen).toEqual(['admin:admin']);
    expect(lauf.nichtUebergeben?.length).toBe(1);
    expect(path.basename(lauf.nichtUebergeben![0].reportPath!)).toMatch(/^report-prompt-inbox-nicht-uebergeben-admin-/);
  });

  test('ohne Nachprüfung bleibt das alte Verhalten (sofort quittiert)', () => {
    const u = umgebung({ 'prompt-a.txt': 'A' });
    const lauf = processPromptInboxOnce({ homeDir: u.homeDir, now, runner: u.runner, paneText: BEREIT });
    expect(lauf.zugestellt.length).toBe(1);
  });
});
