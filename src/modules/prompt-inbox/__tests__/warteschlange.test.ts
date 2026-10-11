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
import {
  pruefeBereitschaft, auftragsKennung, erkenneArmWartung, armMeldung,
} from '../bereitschaft.js';
import { processPromptInboxOnce, leerlaufWaechter, offeneAuftraege, hatReport } from '../index.js';
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

/* Die Tatsachenpruefung auf eine wartende Armierung fragt Git und die
   Datenbank. In diesen Tests ist sie abgeschaltet: Geprueft wird hier die
   Warteschlange, nicht die Armierungserkennung — die hat ihre eigenen Tests
   in arm-status. */
const KEIN_BEDARF = async () => ({ wartet: false });

function sammler(): { calls: { args: string[] }[]; runner: TmuxRunner } {
  const calls: { args: string[] }[] = [];
  return { calls, runner: (_f, args) => { calls.push({ args }); } };
}

// ── Bereitschaftserkennung ─────────────────────────────────────────────────

describe('pruefeBereitschaft', () => {
  it('erkennt einen laufenden Durchgang an "esc to interrupt"', async () => {
    const b = pruefeBereitschaft(PANE_ARBEITET);
    expect(b.bereit).toBe(false);
    expect(b.grund).toBe('laufender_durchgang');
  });

  it('erkennt ein ruhendes Pane als bereit', async () => {
    expect(pruefeBereitschaft(PANE_RUHT).bereit).toBe(true);
  });

  it('behandelt ein leeres Pane als NICHT bereit', async () => {
    // Leer heisst: tmux nicht erreichbar oder Sitzung weg. Dann wird nicht
    // getippt — ins Leere zu tippen verliert den Auftrag still.
    expect(pruefeBereitschaft('').bereit).toBe(false);
    expect(pruefeBereitschaft('   \n  ').grund).toBe('pane_leer');
  });

  it('erkennt die Laufzeitanzeige auch ohne "esc to interrupt"', async () => {
    const b = pruefeBereitschaft('✶ Denke nach… (3m 12s · ↓ 40k tokens)\n❯ ');
    expect(b.bereit).toBe(false);
    expect(b.grund).toBe('laufender_durchgang');
  });
});

describe('pruefeBereitschaft — Missbrauchsfälle (C7)', () => {
  it('sperrt bei offener Freigabefrage', async () => {
    const b = pruefeBereitschaft(PANE_DIALOG);
    expect(b.bereit).toBe(false);
    expect(b.grund).toBe('dialog_offen');
  });

  it('sperrt bei offenem Plan-Gate', async () => {
    expect(pruefeBereitschaft(PANE_PLAN_GATE).grund).toBe('dialog_offen');
  });

  it('sperrt NICHT bei numerierten Zeilen aus einem Auftragstext', async () => {
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

  it('sperrt NICHT bei einem Dialogtext weit oben im Scrollback', async () => {
    /* Nur die letzten Zeilen zählen. Ein beantworteter Dialog von vor einer
       Stunde steht noch im Scrollback und darf nicht dauerhaft sperren. */
    const pane = [PANE_DIALOG, ...Array(30).fill('  ⎿  … Arbeit …'), '❯ '].join('\n');
    expect(pruefeBereitschaft(pane).bereit).toBe(true);
  });

  it('sperrt bei einem Dialog, der unten steht und noch wartet', async () => {
    const pane = [...Array(30).fill('  ⎿  … Arbeit …'), PANE_DIALOG].join('\n');
    expect(pruefeBereitschaft(pane).grund).toBe('dialog_offen');
  });
});

// ── Zustellung ─────────────────────────────────────────────────────────────

describe('processPromptInboxOnce — Zustellung nur bei Bereitschaft', () => {
  it('stellt NICHT zu, solange Claude Code arbeitet, und lässt die Datei liegen', async () => {
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

  it('stellt NICHT zu, solange ein Dialog wartet', async () => {
    const homeDir = tempHome();
    const datei = lege(path.join(homeDir, 'inbox'), 'auftrag.txt', '1. Yes');
    const { calls, runner } = sammler();

    const lauf = processPromptInboxOnce({ homeDir, runner, paneText: PANE_DIALOG });

    expect(lauf.zugestellt).toHaveLength(0);
    expect(calls).toHaveLength(0);
    expect(fs.existsSync(datei)).toBe(true);
  });

  it('stellt zu, sobald das Pane ruht', async () => {
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
  it('stellt höchstens EINE Datei pro Lauf zu', async () => {
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

  it('hält die Reihenfolge nach Dateizeit, nicht nach Name', async () => {
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

  it('arbeitet die Warteschlange über mehrere Läufe ab', async () => {
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
  it('schält die Kennung aus einem Dropbox-Dateinamen', async () => {
    expect(auftragsKennung(
      '2026-10-10T21-18-20-906Z-dropbox-20261010-231720-paket3c-casameta-hybrid-20261010.txt'))
      .toBe('paket3c-casameta-hybrid');
  });

  it('kommt mit einem von Hand abgelegten Namen zurecht', async () => {
    expect(auftragsKennung('meine-aufgabe.txt')).toBe('meine-aufgabe');
  });

  it('gibt null bei zu kurzem Rest', async () => {
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

  it('nennt einen Auftrag ohne Report', async () => {
    const { doneDir, reportDir } = aufbau();
    fs.writeFileSync(path.join(doneDir, '2026-10-11T06-00-00-000Z-dropbox-20261011-060000-paket9-irgendwas-20261011.txt'), 'x');
    const offen = offeneAuftraege({ doneDir, reportDir, now: new Date('2026-10-11T07:00:00Z') });
    expect(offen.map(o => o.kennung)).toEqual(['paket9-irgendwas']);
  });

  it('nennt einen Auftrag mit Report NICHT', async () => {
    const { doneDir, reportDir } = aufbau();
    fs.writeFileSync(path.join(doneDir, '2026-10-11T06-00-00-000Z-dropbox-20261011-060000-paket9-irgendwas-20261011.txt'), 'x');
    fs.writeFileSync(path.join(reportDir, 'report-paket9-irgendwas-20261011.md'), '# fertig');
    const offen = offeneAuftraege({ doneDir, reportDir, now: new Date('2026-10-11T07:00:00Z') });
    expect(offen).toHaveLength(0);
  });

  it('übergeht die eigenen Quittungen des Pollers', async () => {
    const { doneDir, reportDir } = aufbau();
    fs.writeFileSync(path.join(doneDir, '2026-10-11T06-00-00-000Z-prompt-inbox-20261011.txt'), 'x');
    expect(offeneAuftraege({ doneDir, reportDir, now: new Date('2026-10-11T07:00:00Z') })).toHaveLength(0);
  });

  /* ── Die beiden Faelle vom 11.10.2026 ───────────────────────────────────
     Beide Auftraege waren am 08.10. erledigt und hatten einen Report. Der
     Waechter stupste sie trotzdem, weil er `report-prompt-<stamm>-` suchte,
     der Report aber `report-<stamm>-` heisst. */

  it('erkennt den Report zu prompt-golink-spacing2 (Fall vom 11.10.2026)', async () => {
    const { doneDir, reportDir } = aufbau();
    fs.writeFileSync(path.join(doneDir,
      '2026-10-08T08-46-20-904Z-dropbox-20261008-104520-prompt-golink-spacing2-20261008.txt'), 'x');
    fs.writeFileSync(path.join(reportDir, 'report-golink-spacing2-20261008.md'), '# fertig');
    expect(offeneAuftraege({
      doneDir, reportDir, now: new Date('2026-10-08T09:00:00Z'),
    })).toHaveLength(0);
  });

  it('erkennt den Report zu prompt-cue-agent-label (Fall vom 11.10.2026)', async () => {
    const { doneDir, reportDir } = aufbau();
    fs.writeFileSync(path.join(doneDir,
      '2026-10-08T08-15-20-903Z-dropbox-20261008-101420-prompt-cue-agent-label-20261008.txt'), 'x');
    fs.writeFileSync(path.join(reportDir, 'report-cue-agent-label-20261008.md'), '# fertig');
    expect(offeneAuftraege({
      doneDir, reportDir, now: new Date('2026-10-08T09:00:00Z'),
    })).toHaveLength(0);
  });

  it('akzeptiert einen Report vom Folgetag als Nachweis', async () => {
    // Ein Auftrag von abends, der Report von morgens danach — das Datum im
    // Reportnamen darf nicht verglichen werden.
    const { doneDir, reportDir } = aufbau();
    fs.writeFileSync(path.join(doneDir,
      '2026-10-10T20-00-00-000Z-dropbox-20261010-220000-prompt-paket9-20261010.txt'), 'x');
    fs.writeFileSync(path.join(reportDir, 'report-paket9-20261011-0730.md'), '# fertig');
    expect(offeneAuftraege({
      doneDir, reportDir, now: new Date('2026-10-11T09:00:00Z'),
    })).toHaveLength(0);
  });

  it('akzeptiert einen Nachtrag-Report als Nachweis', async () => {
    const { doneDir, reportDir } = aufbau();
    fs.writeFileSync(path.join(doneDir,
      '2026-10-11T06-00-00-000Z-dropbox-20261011-060000-prompt-golink-spacing2-20261011.txt'), 'x');
    fs.writeFileSync(path.join(reportDir, 'report-golink-spacing2-nachpruefung-20261011.md'), '# fertig');
    expect(offeneAuftraege({
      doneDir, reportDir, now: new Date('2026-10-11T07:00:00Z'),
    })).toHaveLength(0);
  });

  it('haelt einen Auftrag ohne Report weiterhin fuer offen — auch mit prompt-Vorsatz', async () => {
    /* Gegenprobe: Die Lockerung darf die Erkennung nicht blind machen. */
    const { doneDir, reportDir } = aufbau();
    fs.writeFileSync(path.join(doneDir,
      '2026-10-11T06-00-00-000Z-dropbox-20261011-060000-prompt-ganz-neue-sache-20261011.txt'), 'x');
    fs.writeFileSync(path.join(reportDir, 'report-etwas-anderes-20261011.md'), '# fremd');
    expect(offeneAuftraege({
      doneDir, reportDir, now: new Date('2026-10-11T07:00:00Z'),
    }).map(o => o.kennung)).toEqual(['prompt-ganz-neue-sache']);
  });

  it('verwechselt zwei Auftraege mit gemeinsamem Namensanfang nicht', async () => {
    /* `report-golink-spacing-...` darf NICHT als Nachweis fuer
       `golink-spacing2` zaehlen — der Bindestrich hinter dem Stamm trennt. */
    const { doneDir, reportDir } = aufbau();
    fs.writeFileSync(path.join(doneDir,
      '2026-10-11T06-00-00-000Z-dropbox-20261011-060000-prompt-golink-spacing2-20261011.txt'), 'x');
    fs.writeFileSync(path.join(reportDir, 'report-golink-spacing-20261008.md'), '# anderer Auftrag');
    expect(offeneAuftraege({
      doneDir, reportDir, now: new Date('2026-10-11T07:00:00Z'),
    }).map(o => o.kennung)).toEqual(['prompt-golink-spacing2']);
  });

  it('laesst Auftraege vor dem Beobachtungsbeginn aus', async () => {
    const { doneDir, reportDir } = aufbau();
    const p = path.join(doneDir,
      '2026-10-08T08-00-00-000Z-dropbox-20261008-100000-prompt-altes-ding-20261008.txt');
    fs.writeFileSync(p, 'x');
    const alt = new Date('2026-10-08T08:00:00Z');
    fs.utimesSync(p, alt, alt);
    expect(offeneAuftraege({
      doneDir, reportDir, now: new Date('2026-10-11T07:00:00Z'),
      nichtVor: new Date('2026-10-11T00:00:00Z'),
    })).toHaveLength(0);
  });

  it('übergeht alte Aufträge', async () => {
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

describe('hatReport', () => {
  const berichte = [
    'report-golink-spacing2-20261008.md',
    'report-cue-agent-label-nachzug-20261011.md',
    'report-weiter-v041-paket4-20261011.md',
  ];

  it('findet den Report ohne prompt-Vorsatz', async () => {
    expect(hatReport(berichte, 'prompt-golink-spacing2')).toBe(true);
    expect(hatReport(berichte, 'prompt-cue-agent-label')).toBe(true);
  });

  it('findet den Report auch ohne Vorsatz in der Kennung', async () => {
    expect(hatReport(berichte, 'weiter-v041-paket4')).toBe(true);
  });

  it('meldet nichts fuer einen unbekannten Auftrag', async () => {
    expect(hatReport(berichte, 'prompt-noch-nie-dagewesen')).toBe(false);
  });

  it('nimmt einen laengeren Namen nicht als Treffer fuer den kuerzeren', async () => {
    // `golink-spacing` ist ein ANDERER Auftrag als `golink-spacing2`.
    expect(hatReport(berichte, 'prompt-golink-spacing')).toBe(false);
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

  it('stupst keinen Auftrag, der vor dem Beobachtungsbeginn zugestellt wurde', async () => {
    /* Der Fall vom 11.10.2026 auf Waechter-Ebene: Ein frisch ausgerollter
       Waechter darf die Auftraege der letzten drei Tage nicht nachholen — er
       weiss nicht, wie sie ausgegangen sind. */
    const a = aufbau(false);
    const doneDir = path.join(a.inboxDir, 'done');
    const alt = path.join(doneDir,
      '2026-10-08T08-00-00-000Z-dropbox-20261008-100000-prompt-altes-ding-20261008.txt');
    fs.writeFileSync(alt, 'x');
    const vor3Tagen = new Date('2026-10-08T08:00:00Z');
    fs.utimesSync(alt, vor3Tagen, vor3Tagen);
    const neu2 = path.join(doneDir,
      '2026-10-11T06-30-00-000Z-dropbox-20261011-063000-prompt-neues-ding-20261011.txt');
    fs.writeFileSync(neu2, 'x');
    fs.writeFileSync(path.join(a.reportDir, 'report-neues-ding-20261011.md'), '# fertig');

    const { calls, runner } = sammler();
    await leerlaufWaechter({ armBedarf: KEIN_BEDARF, ...a, runner, paneText: PANE_RUHT, now: new Date('2026-10-11T07:00:00Z') });
    const w = await leerlaufWaechter({ armBedarf: KEIN_BEDARF,
      ...a, runner, paneText: PANE_RUHT, now: new Date('2026-10-11T07:11:00Z'),
    });
    expect(w).toEqual({ ruht: 'kein offener Auftrag' });
    expect(calls).toHaveLength(0);
    // Der Beobachtungsbeginn steht auf der Zustellzeit des juengsten Auftrags.
    const zustand = JSON.parse(fs.readFileSync(a.zustandPfad, 'utf-8'));
    expect(new Date(zustand.beobachtetSeit).getTime())
      .toBe(fs.statSync(neu2).mtimeMs);
  });

  it('stupst nicht, solange Claude Code arbeitet', async () => {
    const a = aufbau();
    const { calls, runner } = sammler();
    const w = await leerlaufWaechter({ armBedarf: KEIN_BEDARF, ...a, runner, paneText: PANE_ARBEITET, now: new Date('2026-10-11T07:00:00Z') });
    expect(w).toEqual({ ruht: 'Claude Code arbeitet gerade' });
    expect(calls).toHaveLength(0);
  });

  it('stupst nicht beim ersten ruhenden Lauf — die Uhr beginnt erst', async () => {
    const a = aufbau();
    const { calls, runner } = sammler();
    const w = await leerlaufWaechter({ armBedarf: KEIN_BEDARF, ...a, runner, paneText: PANE_RUHT, now: new Date('2026-10-11T07:00:00Z') });
    expect(w).toEqual({ ruht: 'Leerlauf beginnt gerade' });
    expect(calls).toHaveLength(0);
  });

  it('stupst nach Ablauf der Leerlaufzeit mit "weiter mit <Datei>"', async () => {
    const a = aufbau();
    const { calls, runner } = sammler();
    await leerlaufWaechter({ armBedarf: KEIN_BEDARF, ...a, runner, paneText: PANE_RUHT, now: new Date('2026-10-11T07:00:00Z') });
    const w = await leerlaufWaechter({ armBedarf: KEIN_BEDARF,
      ...a, runner, paneText: PANE_RUHT, now: new Date('2026-10-11T07:11:00Z'),
    });
    expect(w).toMatchObject({ kennung: 'paket9-steht', versuch: 1, gemeldet: false });
    const text = calls.find(c => c.args.includes('--'))?.args[4] || '';
    expect(text).toContain('weiter mit');
    expect(text).toContain('paket9-steht');
  });

  it('meldet nach dem zweiten erfolglosen Stups und ruht dann', async () => {
    const a = aufbau();
    const { runner } = sammler();
    const meldungen: string[] = [];
    const melde = (t: string) => meldungen.push(t);

    // Uhr starten, erster Stups.
    await leerlaufWaechter({ armBedarf: KEIN_BEDARF, ...a, runner, melde, paneText: PANE_RUHT, now: new Date('2026-10-11T07:00:00Z') });
    await leerlaufWaechter({ armBedarf: KEIN_BEDARF, ...a, runner, melde, paneText: PANE_RUHT, now: new Date('2026-10-11T07:11:00Z') });
    // Uhr erneut starten, zweiter Stups.
    await leerlaufWaechter({ armBedarf: KEIN_BEDARF, ...a, runner, melde, paneText: PANE_RUHT, now: new Date('2026-10-11T07:12:00Z') });
    await leerlaufWaechter({ armBedarf: KEIN_BEDARF, ...a, runner, melde, paneText: PANE_RUHT, now: new Date('2026-10-11T07:23:00Z') });
    // Uhr erneut starten, jetzt muss gemeldet werden.
    await leerlaufWaechter({ armBedarf: KEIN_BEDARF, ...a, runner, melde, paneText: PANE_RUHT, now: new Date('2026-10-11T07:24:00Z') });
    const w = await leerlaufWaechter({ armBedarf: KEIN_BEDARF,
      ...a, runner, melde, paneText: PANE_RUHT, now: new Date('2026-10-11T07:35:00Z'),
    });

    expect(w).toMatchObject({ gemeldet: true });
    expect(meldungen).toHaveLength(1);
    expect(meldungen[0]).toContain('paket9-steht');
    expect(meldungen[0]).toContain('Stupse ohne Wirkung');

    // Danach ruht der Waechter fuer diesen Auftrag — kein Dauerstups.
    await leerlaufWaechter({ armBedarf: KEIN_BEDARF, ...a, runner, melde, paneText: PANE_RUHT, now: new Date('2026-10-11T08:00:00Z') });
    const w2 = await leerlaufWaechter({ armBedarf: KEIN_BEDARF,
      ...a, runner, melde, paneText: PANE_RUHT, now: new Date('2026-10-11T08:20:00Z'),
    });
    expect(w2).toMatchObject({ ruht: 'Auftrag paket9-steht ist gemeldet' });
    expect(meldungen).toHaveLength(1);
  });

  it('stupst nicht, wenn kein Auftrag offen ist', async () => {
    const a = aufbau(false);
    const { calls, runner } = sammler();
    await leerlaufWaechter({ armBedarf: KEIN_BEDARF, ...a, runner, paneText: PANE_RUHT, now: new Date('2026-10-11T07:00:00Z') });
    const w = await leerlaufWaechter({ armBedarf: KEIN_BEDARF, ...a, runner, paneText: PANE_RUHT, now: new Date('2026-10-11T07:11:00Z') });
    expect(w).toEqual({ ruht: 'kein offener Auftrag' });
    expect(calls).toHaveLength(0);
  });

  it('stupst nicht, wenn noch eine Datei in der Inbox wartet', async () => {
    // Dann erledigt das der normale Lauf — ein Stups waere doppelt.
    const a = aufbau();
    fs.writeFileSync(path.join(a.inboxDir, 'neu.txt'), 'noch was');
    const { calls, runner } = sammler();
    await leerlaufWaechter({ armBedarf: KEIN_BEDARF, ...a, runner, paneText: PANE_RUHT, now: new Date('2026-10-11T07:00:00Z') });
    const w = await leerlaufWaechter({ armBedarf: KEIN_BEDARF, ...a, runner, paneText: PANE_RUHT, now: new Date('2026-10-11T07:11:00Z') });
    expect(w).toEqual({ ruht: 'Datei wartet in der Inbox' });
    expect(calls).toHaveLength(0);
  });

  it('setzt die Leerlaufuhr zurück, sobald wieder gearbeitet wird', async () => {
    const a = aufbau();
    const { calls, runner } = sammler();
    await leerlaufWaechter({ armBedarf: KEIN_BEDARF, ...a, runner, paneText: PANE_RUHT, now: new Date('2026-10-11T07:00:00Z') });
    // Zwischendurch arbeitet Claude Code — die Uhr muss neu beginnen.
    await leerlaufWaechter({ armBedarf: KEIN_BEDARF, ...a, runner, paneText: PANE_ARBEITET, now: new Date('2026-10-11T07:05:00Z') });
    await leerlaufWaechter({ armBedarf: KEIN_BEDARF, ...a, runner, paneText: PANE_RUHT, now: new Date('2026-10-11T07:06:00Z') });
    const w = await leerlaufWaechter({ armBedarf: KEIN_BEDARF, ...a, runner, paneText: PANE_RUHT, now: new Date('2026-10-11T07:12:00Z') });
    expect(w).toMatchObject({ ruht: expect.stringContaining('untaetig') });
    expect(calls).toHaveLength(0);
  });

  it('stupst nachts genauso', async () => {
    const a = aufbau();
    const { runner } = sammler();
    await leerlaufWaechter({ armBedarf: KEIN_BEDARF, ...a, runner, paneText: PANE_RUHT, now: new Date('2026-10-11T02:00:00Z') });
    const w = await leerlaufWaechter({ armBedarf: KEIN_BEDARF, ...a, runner, paneText: PANE_RUHT, now: new Date('2026-10-11T02:11:00Z') });
    expect(w).toMatchObject({ versuch: 1 });
  });
});

// ── Armierungs-Wartung (Ergänzung Owner-Freigabe 11.10.2026) ───────────────
//
// Wartet cc auf `/arm`, hilft kein Stups: Der rote Schritt lässt sich nicht
// ausführen, und „weiter mit …" wiederholt nur den blockierten Versuch.
// Gebraucht wird der Owner — einmal und sofort.

/** Protokollzeilen in der Form, die der Deny-Hook schreibt. */
function hookZeile(zeit: string, art: 'BLOCK' | 'ARMED', rest: string): string {
  return art === 'BLOCK'
    ? `${zeit} [BLOCK] [bikosoc] not armed (/home/biko/.armed-bikosoc fehlt): ${rest}`
    : `${zeit} [ARMED] [bikosoc] Armed-Flag verbraucht (/home/biko/.armed-bikosoc) durch: ${rest}`;
}

const JETZT = new Date('2026-10-11T08:00:00Z');

describe('erkenneArmWartung', () => {
  it('erkennt eine frische Blockade auf einen roten Pfad', async () => {
    const log = hookZeile('2026-10-11T07:50:00Z', 'BLOCK',
      'red path: src/modules/assets/migrations/V041__x.sql matches */migrations/*.sql');
    const w = erkenneArmWartung(log, JETZT);
    expect(w.wartet).toBe(true);
    expect(w.gegenstand).toContain('V041');
    expect(w.zeitpunkt).toBe('2026-10-11T07:50:00Z');
  });

  it('erkennt eine Blockade auf einen roten Befehl', async () => {
    const log = hookZeile('2026-10-11T07:55:00Z', 'BLOCK', 'red command: psql.*openclaw_core');
    expect(erkenneArmWartung(log, JETZT).wartet).toBe(true);
  });

  it('meldet NICHT, wenn nach der Blockade armiert wurde', async () => {
    /* Der entscheidende Fall: Die Blockade ist erledigt, sobald das Flag
       eingelöst wurde. Ohne diese Prüfung käme die Meldung noch Stunden
       später. */
    const log = [
      hookZeile('2026-10-11T07:40:00Z', 'BLOCK', 'red path: …/V041__x.sql matches …'),
      hookZeile('2026-10-11T07:45:00Z', 'ARMED', 'red path: …/V041__x.sql matches …'),
    ].join('\n');
    expect(erkenneArmWartung(log, JETZT).wartet).toBe(false);
  });

  it('meldet NICHT bei einer alten Blockade', async () => {
    const log = hookZeile('2026-10-10T20:00:00Z', 'BLOCK', 'red path: …/V040__x.sql matches …');
    expect(erkenneArmWartung(log, JETZT).wartet).toBe(false);
  });

  it('meldet NICHT bei leerem oder fremdem Protokoll', async () => {
    expect(erkenneArmWartung('', JETZT).wartet).toBe(false);
    expect(erkenneArmWartung('2026-10-11T07:50:00Z [BLOCK] [hdcc] not armed: red path: x',
      JETZT).wartet).toBe(false);
  });

  it('nimmt die JÜNGSTE Blockade, wenn mehrere vorliegen', async () => {
    const log = [
      hookZeile('2026-10-11T07:10:00Z', 'BLOCK', 'red path: alt.sql matches …'),
      hookZeile('2026-10-11T07:50:00Z', 'BLOCK', 'red path: neu.sql matches …'),
    ].join('\n');
    expect(erkenneArmWartung(log, JETZT).gegenstand).toContain('neu.sql');
  });

  it('baut eine Meldung mit antippbarem Link', async () => {
    const text = armMeldung({ wartet: true, gegenstand: 'red path: V041__x.sql', zeitpunkt: '2026-10-11T07:50:00Z' });
    expect(text).toContain('wartet auf /arm');
    expect(text).toContain('V041__x.sql');
    expect(text).toContain('t.me/share/url?url=%2Farm%20push');
  });
});

describe('leerlaufWaechter — Armierung geht vor Stups', () => {
  function aufbau() {
    const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'inbox-arm-'));
    const inboxDir = path.join(homeDir, 'inbox');
    const doneDir = path.join(inboxDir, 'done');
    const reportDir = path.join(homeDir, 'bikosoc-spec');
    fs.mkdirSync(doneDir, { recursive: true });
    fs.mkdirSync(reportDir, { recursive: true });
    fs.writeFileSync(
      path.join(doneDir, '2026-10-11T06-00-00-000Z-dropbox-20261011-060000-paket9-steht-20261011.txt'),
      'AUTO — Paket 9.');
    return { homeDir, inboxDir, reportDir, zustandPfad: path.join(homeDir, 'waechter.json') };
  }

  const PANE_RUHIG = '  Fertig.\n───────\n> \n───────\n  bypass permissions on · 1 shell\n';
  const BLOCKADE = hookZeile('2026-10-11T07:50:00Z', 'BLOCK',
    'red path: src/modules/assets/migrations/V041__x.sql matches */migrations/*.sql');

  it('meldet sofort statt zu stupsen — ohne die zehn Minuten abzuwarten', async () => {
    const a = aufbau();
    const meldungen: string[] = [];
    const getippt: string[] = [];
    const runner = (_f: string, args: string[]) => { if (args.includes('--')) getippt.push(args[4]); };

    const w = await leerlaufWaechter({ armBedarf: KEIN_BEDARF,
      ...a, runner, melde: (t) => meldungen.push(t),
      paneText: PANE_RUHIG, hookProtokoll: BLOCKADE, now: JETZT,
    });

    expect(w).toMatchObject({ armWartung: expect.stringContaining('V041') });
    expect(meldungen).toHaveLength(1);
    expect(meldungen[0]).toContain('t.me/share/url');
    // Kein Stups: Der wuerde nur den blockierten Versuch wiederholen.
    expect(getippt).toHaveLength(0);
  });

  it('meldet dieselbe Blockade nur EINMAL', async () => {
    const a = aufbau();
    const meldungen: string[] = [];
    const runner = () => {};
    const opts = {
      ...a, runner, melde: (t: string) => meldungen.push(t),
      paneText: PANE_RUHIG, hookProtokoll: BLOCKADE,
    };
    await leerlaufWaechter({ armBedarf: KEIN_BEDARF, ...opts, now: JETZT });
    const w = await leerlaufWaechter({ armBedarf: KEIN_BEDARF, ...opts, now: new Date('2026-10-11T08:30:00Z') });
    expect(meldungen).toHaveLength(1);
    expect(w).toMatchObject({ ruht: 'Armierung wartet, bereits gemeldet' });
  });

  it('stupst wieder normal, sobald armiert wurde', async () => {
    const a = aufbau();
    const getippt: string[] = [];
    const runner = (_f: string, args: string[]) => { if (args.includes('--')) getippt.push(args[4]); };
    const erledigt = [
      BLOCKADE,
      hookZeile('2026-10-11T07:55:00Z', 'ARMED', 'red path: …/V041__x.sql matches …'),
    ].join('\n');
    const opts = { ...a, runner, paneText: PANE_RUHIG, hookProtokoll: erledigt };

    await leerlaufWaechter({ armBedarf: KEIN_BEDARF, ...opts, now: JETZT });                                  // Uhr startet
    const w = await leerlaufWaechter({ armBedarf: KEIN_BEDARF, ...opts, now: new Date('2026-10-11T08:11:00Z') });
    expect(w).toMatchObject({ versuch: 1 });
    expect(getippt[0]).toContain('weiter mit');
  });
});

describe('leerlaufWaechter — Tatsachenweg zur Armierung', () => {
  const PANE_LEISE = '  Fertig.\n───────\n> \n───────\n  bypass permissions on · 1 shell\n';

  function aufbau() {
    const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'inbox-fakt-'));
    const doneDir = path.join(homeDir, 'inbox', 'done');
    fs.mkdirSync(doneDir, { recursive: true });
    fs.mkdirSync(path.join(homeDir, 'bikosoc-spec'), { recursive: true });
    fs.writeFileSync(
      path.join(doneDir, '2026-10-11T06-00-00-000Z-dropbox-20261011-060000-paket9-steht-20261011.txt'),
      'AUTO — Paket 9.');
    return {
      homeDir, reportDir: path.join(homeDir, 'bikosoc-spec'),
      zustandPfad: path.join(homeDir, 'waechter.json'),
    };
  }

  it('meldet, wenn ungepushte Arbeit an einem roten Pfad liegt', async () => {
    /* Der Fall, den das Hook-Protokoll NICHT sieht: Claude Code hat den Push
       gar nicht versucht, weil es wusste, dass er blockiert wird. */
    const a = aufbau();
    const meldungen: string[] = [];
    const getippt: string[] = [];
    const runner = (_f: string, args: string[]) => { if (args.includes('--')) getippt.push(args[4]); };

    const w = await leerlaufWaechter({
      ...a, runner, melde: (t) => meldungen.push(t),
      paneText: PANE_LEISE, hookProtokoll: '',
      armBedarf: async () => ({
        wartet: true,
        gegenstand: '1 noch nicht gepushte Änderung an rotem Pfad: src/modules/assets/migrations/V042__x.sql',
        kennung: 'push:V042',
      }),
      now: new Date('2026-10-11T09:00:00Z'),
    });

    expect(w).toMatchObject({ armWartung: expect.stringContaining('V042') });
    expect(meldungen).toHaveLength(1);
    expect(meldungen[0]).toContain('t.me/share/url');
    expect(getippt).toHaveLength(0);
  });

  it('meldet dieselbe Lage nur einmal', async () => {
    const a = aufbau();
    const meldungen: string[] = [];
    const opts = {
      ...a, runner: () => {}, melde: (t: string) => meldungen.push(t),
      paneText: PANE_LEISE, hookProtokoll: '',
      armBedarf: async () => ({ wartet: true, gegenstand: 'x', kennung: 'push:gleich' }),
    };
    await leerlaufWaechter({ ...opts, now: new Date('2026-10-11T09:00:00Z') });
    const w = await leerlaufWaechter({ ...opts, now: new Date('2026-10-11T09:30:00Z') });
    expect(meldungen).toHaveLength(1);
    expect(w).toMatchObject({ ruht: 'Armierung wartet, bereits gemeldet' });
  });

  it('meldet erneut, wenn sich die Lage ändert', async () => {
    const a = aufbau();
    const meldungen: string[] = [];
    const basis = {
      ...a, runner: () => {}, melde: (t: string) => meldungen.push(t),
      paneText: PANE_LEISE, hookProtokoll: '',
    };
    await leerlaufWaechter({
      ...basis, armBedarf: async () => ({ wartet: true, gegenstand: 'a', kennung: 'push:a' }),
      now: new Date('2026-10-11T09:00:00Z'),
    });
    await leerlaufWaechter({
      ...basis, armBedarf: async () => ({ wartet: true, gegenstand: 'b', kennung: 'push:b' }),
      now: new Date('2026-10-11T09:05:00Z'),
    });
    expect(meldungen).toHaveLength(2);
  });

  it('schweigt bei einem Fehler in der Tatsachenprüfung statt zu melden', async () => {
    /* Ein Fehler beim Git- oder Datenbankzugriff darf keine Meldung erzeugen —
       sonst meldet der Waechter bei jedem Ausfall. */
    const a = aufbau();
    const meldungen: string[] = [];
    const opts = {
      ...a, runner: () => {}, melde: (t: string) => meldungen.push(t),
      paneText: PANE_LEISE, hookProtokoll: '',
      armBedarf: async () => { throw new Error('git kaputt'); },
    };
    await leerlaufWaechter({ ...opts, now: new Date('2026-10-11T09:00:00Z') });
    const w = await leerlaufWaechter({ ...opts, now: new Date('2026-10-11T09:11:00Z') });
    expect(meldungen).toHaveLength(0);
    // Stattdessen laeuft der normale Stups.
    expect(w).toMatchObject({ versuch: 1 });
  });

  it('gibt dem Hook-Protokoll den Vorrang vor der Tatsachenprüfung', async () => {
    const a = aufbau();
    const meldungen: string[] = [];
    const w = await leerlaufWaechter({
      ...a, runner: () => {}, melde: (t) => meldungen.push(t), paneText: PANE_LEISE,
      hookProtokoll: '2026-10-11T08:50:00Z [BLOCK] [bikosoc] not armed (x): red path: aus-dem-protokoll.sql matches y',
      armBedarf: async () => ({ wartet: true, gegenstand: 'aus-der-tatsache', kennung: 'k' }),
      now: new Date('2026-10-11T09:00:00Z'),
    });
    expect(w).toMatchObject({ armWartung: expect.stringContaining('aus-dem-protokoll') });
    expect(meldungen[0]).toContain('aus-dem-protokoll');
  });
});
