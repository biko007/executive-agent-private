/**
 * prompt-inbox/__tests__/warteschlange.test.ts — Zustellung nur bei
 * Aufnahmebereitschaft, Reihenfolge, Leerlauf-Wächter.
 *
 * WARUM DIESE TESTS SO AUSFÜHRLICH SIND. Die Prompt-Inbox ist eine
 * Kontrollfläche: Sie tippt Text in das Pane, in dem Claude Code läuft. Nach
 * C7 ist jede Änderung daran review- und negativtestpflichtig. Der gefährliche
 * Fall ist nicht der verlorene Auftrag, sondern der FALSCH ZUGESTELLTE: Steht
 * ein Dialog mit numerierten Optionen offen, ist getippter Text keine
 * Nachricht, sondern eine Antwort — die erste Zeile eines Auftrags würde dann
 * eine Option auswählen, die niemand gewählt hat.
 *
 * Die Missbrauchsfälle unten prüfen genau das: echte Dialoge aus Claude Code
 * müssen die Zustellung sperren, harmlose Auftragstexte im Scrollback dürfen
 * sie NICHT sperren.
 */
import { describe, it, expect } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pruefeBereitschaft, auftragsKennung } from '../bereitschaft.js';
import { processPromptInboxOnce, leerlaufWaechter, offeneAuftraege } from '../index.js';
import type { TmuxRunner } from '../../cc-prompt-dispatch/index.js';

// ── Echte Pane-Texte ───────────────────────────────────────────────────────
//
// Die beiden ersten sind am 11.10.2026 aus der laufenden Sitzung abgegriffen.

const PANE_ARBEITET = [
  '',
  '✶ Fluttering… (58m 11s · ↓ 224.3k tokens)',
  '  ⎿  Tip: Use /clear to start fresh when switching topics',
  '────────────────────────────────────────────',
  '❯ ',
  '────────────────────────────────────────────',
  '  ⏵⏵ bypass permissions on · 1 shell · esc to interrupt · ← for agents · ↓ to manage',
].join('\n');

const PANE_RUHT = [
  '  ⎿  Fertig. Owner-Aktion: keine.',
  '',
  '────────────────────────────────────────────',
  '❯ ',
  '────────────────────────────────────────────',
  '  ⏵⏵ bypass permissions on · 1 shell · ← for agents · ↓ to manage',
].join('\n');

const PANE_DIALOG = [
  '  Bash command',
  '    git push',
  '',
  '  Do you want to proceed?',
  '  ❯ 1. Yes',
  '    2. Yes, and bypass permissions',
  '    3. No, and tell Claude what to do differently (esc)',
].join('\n');

const PANE_PLAN_GATE = [
  '  Ready to code?',
  '  ❯ 1. Yes, and auto-accept edits',
  '    2. Yes, and manually approve edits',
  '    3. No, keep planning',
].join('\n');

function tempHome(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'inbox-q-'));
}

function lege(inboxDir: string, name: string, text: string, mtime?: Date): string {
  fs.mkdirSync(inboxDir, { recursive: true });
  const p = path.join(inboxDir, name);
  fs.writeFileSync(p, text);
  if (mtime) fs.utimesSync(p, mtime, mtime);
  return p;
}

function sammler(): { calls: { args: string[] }[]; runner: TmuxRunner } {
  const calls: { args: string[] }[] = [];
  return { calls, runner: (_f, args) => { calls.push({ args }); } };
}

// ── Bereitschaftserkennung ─────────────────────────────────────────────────

describe('pruefeBereitschaft', () => {
  it('erkennt einen laufenden Durchgang an "esc to interrupt"', () => {
    const b = pruefeBereitschaft(PANE_ARBEITET);
    expect(b.bereit).toBe(false);
    expect(b.grund).toBe('laufender_durchgang');
  });

  it('erkennt ein ruhendes Pane als bereit', () => {
    expect(pruefeBereitschaft(PANE_RUHT).bereit).toBe(true);
  });

  it('behandelt ein leeres Pane als NICHT bereit', () => {
    // Leer heisst: tmux nicht erreichbar oder Sitzung weg. Dann wird nicht
    // getippt — ins Leere zu tippen verliert den Auftrag still.
    expect(pruefeBereitschaft('').bereit).toBe(false);
    expect(pruefeBereitschaft('   \n  ').grund).toBe('pane_leer');
  });

  it('erkennt die Laufzeitanzeige auch ohne "esc to interrupt"', () => {
    const b = pruefeBereitschaft('✶ Denke nach… (3m 12s · ↓ 40k tokens)\n❯ ');
    expect(b.bereit).toBe(false);
    expect(b.grund).toBe('laufender_durchgang');
  });
});

describe('pruefeBereitschaft — Missbrauchsfälle (C7)', () => {
  it('sperrt bei offener Freigabefrage', () => {
    const b = pruefeBereitschaft(PANE_DIALOG);
    expect(b.bereit).toBe(false);
    expect(b.grund).toBe('dialog_offen');
  });

  it('sperrt bei offenem Plan-Gate', () => {
    expect(pruefeBereitschaft(PANE_PLAN_GATE).grund).toBe('dialog_offen');
  });

  it('sperrt NICHT bei numerierten Zeilen aus einem Auftragstext', () => {
    /* Der Gegenfall: Ein Auftrag im Scrollback enthält eine Liste. Würde das
       als Dialog gelten, stellte die Inbox nie wieder zu — eine Sperre, die
       immer greift, ist so schlimm wie keine. */
    const pane = [
      '  Der Auftrag lautete:',
      '    1. Zuerst die Migration anwenden',
      '    2. Dann den Report schreiben',
      '    3. Danach pushen',
      '────────────────────────────────────────────',
      '❯ ',
      '  ⏵⏵ bypass permissions on · 1 shell · ← for agents',
    ].join('\n');
    expect(pruefeBereitschaft(pane).bereit).toBe(true);
  });

  it('sperrt NICHT bei einem Dialogtext weit oben im Scrollback', () => {
    /* Nur die letzten Zeilen zählen. Ein beantworteter Dialog von vor einer
       Stunde steht noch im Scrollback und darf nicht dauerhaft sperren. */
    const pane = [PANE_DIALOG, ...Array(30).fill('  ⎿  … Arbeit …'), '❯ '].join('\n');
    expect(pruefeBereitschaft(pane).bereit).toBe(true);
  });

  it('sperrt bei einem Dialog, der unten steht und noch wartet', () => {
    const pane = [...Array(30).fill('  ⎿  … Arbeit …'), PANE_DIALOG].join('\n');
    expect(pruefeBereitschaft(pane).grund).toBe('dialog_offen');
  });
});

// ── Zustellung ─────────────────────────────────────────────────────────────

describe('processPromptInboxOnce — Zustellung nur bei Bereitschaft', () => {
  it('stellt NICHT zu, solange Claude Code arbeitet, und lässt die Datei liegen', () => {
    const homeDir = tempHome();
    const inboxDir = path.join(homeDir, 'inbox');
    const datei = lege(inboxDir, 'auftrag.txt', 'AUTO — irgendwas tun.');
    const { calls, runner } = sammler();

    const lauf = processPromptInboxOnce({ homeDir, runner, paneText: PANE_ARBEITET });

    expect(lauf.zugestellt).toHaveLength(0);
    expect(lauf.zurueckgestellt).toHaveLength(1);
    expect(lauf.zurueckgestellt[0].grund).toContain('arbeitet');
    // Entscheidend: NICHTS getippt und die Datei liegt noch da.
    expect(calls).toHaveLength(0);
    expect(fs.existsSync(datei)).toBe(true);
  });

  it('stellt NICHT zu, solange ein Dialog wartet', () => {
    const homeDir = tempHome();
    const datei = lege(path.join(homeDir, 'inbox'), 'auftrag.txt', '1. Yes');
    const { calls, runner } = sammler();

    const lauf = processPromptInboxOnce({ homeDir, runner, paneText: PANE_DIALOG });

    expect(lauf.zugestellt).toHaveLength(0);
    expect(calls).toHaveLength(0);
    expect(fs.existsSync(datei)).toBe(true);
  });

  it('stellt zu, sobald das Pane ruht', () => {
    const homeDir = tempHome();
    const datei = lege(path.join(homeDir, 'inbox'), 'auftrag.txt', 'AUTO — weiter.');
    const { calls, runner } = sammler();

    const lauf = processPromptInboxOnce({ homeDir, runner, paneText: PANE_RUHT });

    expect(lauf.zugestellt).toHaveLength(1);
    expect(fs.existsSync(datei)).toBe(false);
    // Text und Enter als zwei getrennte Tastenschuebe.
    expect(calls).toHaveLength(2);
    expect(calls[1].args).toEqual(['send-keys', '-t', 'bikosoc', 'Enter']);
  });
});

describe('processPromptInboxOnce — Reihenfolge und Drosselung', () => {
  it('stellt höchstens EINE Datei pro Lauf zu', () => {
    /* Nach der Zustellung arbeitet Claude Code. Eine zweite Datei im selben
       Lauf träfe genau den Zustand, den die Pruefung verhindern soll. */
    const homeDir = tempHome();
    const inboxDir = path.join(homeDir, 'inbox');
    lege(inboxDir, 'a.txt', 'erster', new Date('2026-10-11T06:00:00Z'));
    lege(inboxDir, 'b.txt', 'zweiter', new Date('2026-10-11T06:00:10Z'));
    const { runner } = sammler();

    const lauf = processPromptInboxOnce({ homeDir, runner, paneText: PANE_RUHT });

    expect(lauf.zugestellt).toHaveLength(1);
    expect(lauf.zurueckgestellt).toHaveLength(1);
    expect(fs.existsSync(path.join(inboxDir, 'b.txt'))).toBe(true);
  });

  it('hält die Reihenfolge nach Dateizeit, nicht nach Name', () => {
    /* Der Dateiname traegt den Zeitstempel der Dropbox-Uebergabe, nicht den
       der Ablage. Wer eine Datei von Hand nachlegt, soll nicht vordraengeln. */
    const homeDir = tempHome();
    const inboxDir = path.join(homeDir, 'inbox');
    lege(inboxDir, 'zzz-aelter.txt', 'ALT', new Date('2026-10-11T06:00:00Z'));
    lege(inboxDir, 'aaa-neuer.txt', 'NEU', new Date('2026-10-11T07:00:00Z'));
    const { calls, runner } = sammler();

    processPromptInboxOnce({ homeDir, runner, paneText: PANE_RUHT });

    expect(calls[0].args[4]).toBe('ALT');
  });

  it('arbeitet die Warteschlange über mehrere Läufe ab', () => {
    const homeDir = tempHome();
    const inboxDir = path.join(homeDir, 'inbox');
    lege(inboxDir, 'a.txt', 'erster', new Date('2026-10-11T06:00:00Z'));
    lege(inboxDir, 'b.txt', 'zweiter', new Date('2026-10-11T06:00:10Z'));
    const { calls, runner } = sammler();

    // Lauf 1: bereit → a. Lauf 2: arbeitet → nichts. Lauf 3: bereit → b.
    processPromptInboxOnce({ homeDir, runner, paneText: PANE_RUHT });
    processPromptInboxOnce({ homeDir, runner, paneText: PANE_ARBEITET });
    processPromptInboxOnce({ homeDir, runner, paneText: PANE_RUHT });

    const texte = calls.filter(c => c.args.includes('--')).map(c => c.args[4]);
    expect(texte).toEqual(['erster', 'zweiter']);
    expect(fs.readdirSync(inboxDir).filter(n => n.endsWith('.txt'))).toHaveLength(0);
  });
});

// ── Auftragskennung und offene Aufträge ────────────────────────────────────

describe('auftragsKennung', () => {
  it('schält die Kennung aus einem Dropbox-Dateinamen', () => {
    expect(auftragsKennung(
      '2026-10-10T21-18-20-906Z-dropbox-20261010-231720-paket3c-casameta-hybrid-20261010.txt'))
      .toBe('paket3c-casameta-hybrid');
  });

  it('kommt mit einem von Hand abgelegten Namen zurecht', () => {
    expect(auftragsKennung('meine-aufgabe.txt')).toBe('meine-aufgabe');
  });

  it('gibt null bei zu kurzem Rest', () => {
    expect(auftragsKennung('ab.txt')).toBeNull();
  });
});

describe('offeneAuftraege', () => {
  function aufbau() {
    const homeDir = tempHome();
    const doneDir = path.join(homeDir, 'inbox', 'done');
    const reportDir = path.join(homeDir, 'bikosoc-spec');
    fs.mkdirSync(doneDir, { recursive: true });
    fs.mkdirSync(reportDir, { recursive: true });
    return { homeDir, doneDir, reportDir };
  }

  it('nennt einen Auftrag ohne Report', () => {
    const { doneDir, reportDir } = aufbau();
    fs.writeFileSync(path.join(doneDir, '2026-10-11T06-00-00-000Z-dropbox-20261011-060000-paket9-irgendwas-20261011.txt'), 'x');
    const offen = offeneAuftraege({ doneDir, reportDir, now: new Date('2026-10-11T07:00:00Z') });
    expect(offen.map(o => o.kennung)).toEqual(['paket9-irgendwas']);
  });

  it('nennt einen Auftrag mit Report NICHT', () => {
    const { doneDir, reportDir } = aufbau();
    fs.writeFileSync(path.join(doneDir, '2026-10-11T06-00-00-000Z-dropbox-20261011-060000-paket9-irgendwas-20261011.txt'), 'x');
    fs.writeFileSync(path.join(reportDir, 'report-paket9-irgendwas-20261011.md'), '# fertig');
    const offen = offeneAuftraege({ doneDir, reportDir, now: new Date('2026-10-11T07:00:00Z') });
    expect(offen).toHaveLength(0);
  });

  it('übergeht die eigenen Quittungen des Pollers', () => {
    const { doneDir, reportDir } = aufbau();
    fs.writeFileSync(path.join(doneDir, '2026-10-11T06-00-00-000Z-prompt-inbox-20261011.txt'), 'x');
    expect(offeneAuftraege({ doneDir, reportDir, now: new Date('2026-10-11T07:00:00Z') })).toHaveLength(0);
  });

  it('übergeht alte Aufträge', () => {
    const { doneDir, reportDir } = aufbau();
    const p = path.join(doneDir, '2026-10-01T06-00-00-000Z-dropbox-20261001-060000-altes-paket-20261001.txt');
    fs.writeFileSync(p, 'x');
    const alt = new Date('2026-10-01T06:00:00Z');
    fs.utimesSync(p, alt, alt);
    expect(offeneAuftraege({
      doneDir, reportDir, now: new Date('2026-10-11T07:00:00Z'), maxAlterTage: 3,
    })).toHaveLength(0);
  });
});

// ── Leerlauf-Wächter ───────────────────────────────────────────────────────

describe('leerlaufWaechter', () => {
  function aufbau(mitOffenemAuftrag = true) {
    const homeDir = tempHome();
    const inboxDir = path.join(homeDir, 'inbox');
    const doneDir = path.join(inboxDir, 'done');
    const reportDir = path.join(homeDir, 'bikosoc-spec');
    fs.mkdirSync(doneDir, { recursive: true });
    fs.mkdirSync(reportDir, { recursive: true });
    if (mitOffenemAuftrag) {
      fs.writeFileSync(
        path.join(doneDir, '2026-10-11T06-00-00-000Z-dropbox-20261011-060000-paket9-steht-20261011.txt'),
        'AUTO — Paket 9.');
    }
    return {
      homeDir, inboxDir, reportDir,
      zustandPfad: path.join(homeDir, 'waechter.json'),
    };
  }

  it('stupst nicht, solange Claude Code arbeitet', () => {
    const a = aufbau();
    const { calls, runner } = sammler();
    const w = leerlaufWaechter({ ...a, runner, paneText: PANE_ARBEITET, now: new Date('2026-10-11T07:00:00Z') });
    expect(w).toEqual({ ruht: 'Claude Code arbeitet gerade' });
    expect(calls).toHaveLength(0);
  });

  it('stupst nicht beim ersten ruhenden Lauf — die Uhr beginnt erst', () => {
    const a = aufbau();
    const { calls, runner } = sammler();
    const w = leerlaufWaechter({ ...a, runner, paneText: PANE_RUHT, now: new Date('2026-10-11T07:00:00Z') });
    expect(w).toEqual({ ruht: 'Leerlauf beginnt gerade' });
    expect(calls).toHaveLength(0);
  });

  it('stupst nach Ablauf der Leerlaufzeit mit "weiter mit <Datei>"', () => {
    const a = aufbau();
    const { calls, runner } = sammler();
    leerlaufWaechter({ ...a, runner, paneText: PANE_RUHT, now: new Date('2026-10-11T07:00:00Z') });
    const w = leerlaufWaechter({
      ...a, runner, paneText: PANE_RUHT, now: new Date('2026-10-11T07:11:00Z'),
    });
    expect(w).toMatchObject({ kennung: 'paket9-steht', versuch: 1, gemeldet: false });
    const text = calls.find(c => c.args.includes('--'))?.args[4] || '';
    expect(text).toContain('weiter mit');
    expect(text).toContain('paket9-steht');
  });

  it('meldet nach dem zweiten erfolglosen Stups und ruht dann', () => {
    const a = aufbau();
    const { runner } = sammler();
    const meldungen: string[] = [];
    const melde = (t: string) => meldungen.push(t);

    // Uhr starten, erster Stups.
    leerlaufWaechter({ ...a, runner, melde, paneText: PANE_RUHT, now: new Date('2026-10-11T07:00:00Z') });
    leerlaufWaechter({ ...a, runner, melde, paneText: PANE_RUHT, now: new Date('2026-10-11T07:11:00Z') });
    // Uhr erneut starten, zweiter Stups.
    leerlaufWaechter({ ...a, runner, melde, paneText: PANE_RUHT, now: new Date('2026-10-11T07:12:00Z') });
    leerlaufWaechter({ ...a, runner, melde, paneText: PANE_RUHT, now: new Date('2026-10-11T07:23:00Z') });
    // Uhr erneut starten, jetzt muss gemeldet werden.
    leerlaufWaechter({ ...a, runner, melde, paneText: PANE_RUHT, now: new Date('2026-10-11T07:24:00Z') });
    const w = leerlaufWaechter({
      ...a, runner, melde, paneText: PANE_RUHT, now: new Date('2026-10-11T07:35:00Z'),
    });

    expect(w).toMatchObject({ gemeldet: true });
    expect(meldungen).toHaveLength(1);
    expect(meldungen[0]).toContain('paket9-steht');
    expect(meldungen[0]).toContain('Stupse ohne Wirkung');

    // Danach ruht der Waechter fuer diesen Auftrag — kein Dauerstups.
    leerlaufWaechter({ ...a, runner, melde, paneText: PANE_RUHT, now: new Date('2026-10-11T08:00:00Z') });
    const w2 = leerlaufWaechter({
      ...a, runner, melde, paneText: PANE_RUHT, now: new Date('2026-10-11T08:20:00Z'),
    });
    expect(w2).toMatchObject({ ruht: 'Auftrag paket9-steht ist gemeldet' });
    expect(meldungen).toHaveLength(1);
  });

  it('stupst nicht, wenn kein Auftrag offen ist', () => {
    const a = aufbau(false);
    const { calls, runner } = sammler();
    leerlaufWaechter({ ...a, runner, paneText: PANE_RUHT, now: new Date('2026-10-11T07:00:00Z') });
    const w = leerlaufWaechter({ ...a, runner, paneText: PANE_RUHT, now: new Date('2026-10-11T07:11:00Z') });
    expect(w).toEqual({ ruht: 'kein offener Auftrag' });
    expect(calls).toHaveLength(0);
  });

  it('stupst nicht, wenn noch eine Datei in der Inbox wartet', () => {
    // Dann erledigt das der normale Lauf — ein Stups waere doppelt.
    const a = aufbau();
    fs.writeFileSync(path.join(a.inboxDir, 'neu.txt'), 'noch was');
    const { calls, runner } = sammler();
    leerlaufWaechter({ ...a, runner, paneText: PANE_RUHT, now: new Date('2026-10-11T07:00:00Z') });
    const w = leerlaufWaechter({ ...a, runner, paneText: PANE_RUHT, now: new Date('2026-10-11T07:11:00Z') });
    expect(w).toEqual({ ruht: 'Datei wartet in der Inbox' });
    expect(calls).toHaveLength(0);
  });

  it('setzt die Leerlaufuhr zurück, sobald wieder gearbeitet wird', () => {
    const a = aufbau();
    const { calls, runner } = sammler();
    leerlaufWaechter({ ...a, runner, paneText: PANE_RUHT, now: new Date('2026-10-11T07:00:00Z') });
    // Zwischendurch arbeitet Claude Code — die Uhr muss neu beginnen.
    leerlaufWaechter({ ...a, runner, paneText: PANE_ARBEITET, now: new Date('2026-10-11T07:05:00Z') });
    leerlaufWaechter({ ...a, runner, paneText: PANE_RUHT, now: new Date('2026-10-11T07:06:00Z') });
    const w = leerlaufWaechter({ ...a, runner, paneText: PANE_RUHT, now: new Date('2026-10-11T07:12:00Z') });
    expect(w).toMatchObject({ ruht: expect.stringContaining('untaetig') });
    expect(calls).toHaveLength(0);
  });

  it('stupst nachts genauso', () => {
    const a = aufbau();
    const { runner } = sammler();
    leerlaufWaechter({ ...a, runner, paneText: PANE_RUHT, now: new Date('2026-10-11T02:00:00Z') });
    const w = leerlaufWaechter({ ...a, runner, paneText: PANE_RUHT, now: new Date('2026-10-11T02:11:00Z') });
    expect(w).toMatchObject({ versuch: 1 });
  });
});
