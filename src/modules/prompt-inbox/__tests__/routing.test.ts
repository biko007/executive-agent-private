/**
 * Session-Routing nach Präfix + Autostart (Spec Cowork-Platform §13.1).
 *
 * Kontrollfläche (C7): Neben dem Regelfall die Negativfälle — ungültige
 * Konfigzeilen, Sitzungsnamen mit tmux-Trennern, ähnliche Präfixe, fehlende
 * Sitzung mit gescheitertem Start, kein Rückfall auf bikosoc, Wächter.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { processPromptInboxOnce, offeneAuftraege, ccPromptBereit } from '../index.js';
import { parseRouting, routingPraefix, regelFuer, type SitzungsRegel } from '../routing.js';
import { auftragsKennung } from '../bereitschaft.js';
import { sitzungsZiel, starteCcSitzung, type TmuxRunner } from '../../cc-prompt-dispatch/index.js';

const wurzeln: string[] = [];
afterEach(() => { for (const w of wurzeln.splice(0)) fs.rmSync(w, { recursive: true, force: true }); });

const HOME = '/home/test';
const now = new Date('2026-11-05T19:40:00.000Z');
const BEREIT = 'Claude Code\n\n❯ \n  ⏵⏵ bypass permissions on (shift+tab to cycle)\n';
const TABELLE = parseRouting([
  'design=design:~/.openclaw/workspace/.openclaw/extensions/executive-dashboard',
  'test=inboxtest:~',
].join('\n'), HOME);

function umgebung(dateien: Record<string, string>) {
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'inbox-routing-'));
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

describe('Konfigdatei lesen', () => {
  test('gültige Regeln, ~ wird aufgelöst', () => {
    expect(TABELLE.fehler).toEqual([]);
    expect(TABELLE.regeln.get('design')).toEqual({
      praefix: 'design', sitzung: 'design',
      verzeichnis: '/home/test/.openclaw/workspace/.openclaw/extensions/executive-dashboard',
    });
    expect(TABELLE.regeln.get('test')?.verzeichnis).toBe('/home/test');
  });

  test('ungültige Zeilen werden übersprungen, nicht abgestürzt', () => {
    const t = parseRouting([
      '# Kommentar', '', 'design=design:~/x',
      'kaputt ohne gleich',
      'ohne=doppelpunkt',
      'Gross=a:~/y',                // Präfix nur Kleinbuchstaben
      'x=a:~/y',                    // Präfix zu kurz
      'pane=sitz.1:~/y',            // . wäre tmux-Pane-Trenner
      'opt=-t:~/y',                 // Sitzungsname als tmux-Option
      'rel=rel:relativ/pfad',
      'design=anders:~/z',          // doppelt: erste Regel gilt
      'leer=:~/y',
      'gut=gut:/abs',
    ].join('\n'), HOME);
    expect([...t.regeln.keys()]).toEqual(['design', 'gut']);
    expect(t.regeln.get('design')?.sitzung).toBe('design');
    expect(t.fehler.map(f => f.zeile)).toEqual([4, 5, 6, 7, 8, 9, 10, 11, 12]);
  });
});

describe('Präfix aus dem Dateinamen', () => {
  test('Schema mit und ohne Transportvorsätze', () => {
    expect(routingPraefix('20261105-2099-design-smoketest.txt')).toBe('design');
    expect(routingPraefix('dropbox-20261105-202950-20261105-2035-inbox-routing.txt')).toBe('inbox');
    expect(routingPraefix('2026-11-05T19-30-50-070Z-dropbox-20261105-202950-20261105-2035-design-x.txt')).toBe('design');
    expect(routingPraefix('auftrag-mail-20261105-1400-20261105-1400-design-y.txt')).toBe('design');
  });

  test('Namen außerhalb des Schemas haben kein Präfix → bikosoc', () => {
    for (const n of [
      'prompt-design-x.txt', 'design-x.txt', '20261105-design-x.txt',
      '20261105-2099-design.txt',         // kein Thema
      '20261105-2099-Design-x.txt',       // Großschreibung
      '20261105-2099-design-x.md',
      'x-20261105-2099-design-x.txt',     // fremder Vorsatz
    ]) expect(regelFuer(n, TABELLE)).toBeNull();
  });

  test('ähnliches Präfix trifft keine Regel', () => {
    expect(regelFuer('20261105-2099-designer-x.txt', TABELLE)).toBeNull();
    expect(regelFuer('20261105-2099-des-x.txt', TABELLE)).toBeNull();
  });

  test('eine Regel auf bikosoc ist der Normalweg', () => {
    const t = parseRouting('fach=bikosoc:~/x', HOME);
    expect(regelFuer('20261105-2099-fach-x.txt', t)).toBeNull();
  });

  test('Auftragskennung ohne führenden Stempel (Wächter findet den Report)', () => {
    expect(auftragsKennung('dropbox-20261105-202950-20261105-2035-inbox-routing.txt')).toBe('inbox-routing');
  });
});

describe('tmux-Ziel', () => {
  test('exakter Sitzungsname mit =, ungültige Namen werfen', () => {
    expect(sitzungsZiel('design')).toBe('=design:');
    for (const n of ['a:b', 'a.b', '-t', '', 'a b']) expect(() => sitzungsZiel(n)).toThrow();
  });

  test('Autostart übergibt nur den Skriptpfad, als argv', () => {
    const a: string[][] = [];
    starteCcSitzung('inboxtest', '/home/test', '/x/cc-sitzung-start.sh', (_f, args) => { a.push(args); });
    expect(a[0]).toEqual(['new-session', '-d', '-s', 'inboxtest', '-c', '/home/test', '/x/cc-sitzung-start.sh']);
    expect(() => starteCcSitzung('inboxtest', 'relativ', '/x', () => {})).toThrow();
  });

  test('Prompt-Erkennung: nackte Shell oder Dialog zählen nicht', () => {
    expect(ccPromptBereit(BEREIT)).toBe(true);
    expect(ccPromptBereit('biko@host:~$ ')).toBe(false);
    expect(ccPromptBereit('')).toBe(false);
  });
});

describe('Zustellung', () => {
  test('Präfix design → laufende Sitzung design, Quittung nennt Ziel', () => {
    const u = umgebung({ '20261105-2099-design-smoketest.txt': 'Antworte nur mit OK, keine Aktion' });
    const lauf = processPromptInboxOnce({
      homeDir: u.homeDir, now, runner: u.runner, paneText: BEREIT, routing: TABELLE,
      sitzungen: { laeuft: () => true, pane: () => BEREIT, starte: () => { throw new Error('nicht starten'); } },
    });
    expect(u.aufrufe[0].args).toEqual(['send-keys', '-t', '=design:', '--', 'Antworte nur mit OK, keine Aktion']);
    expect(u.aufrufe[1].args).toEqual(['send-keys', '-t', '=design:', 'Enter']);
    const q = fs.readFileSync(lauf.zugestellt[0].reportPath, 'utf-8');
    expect(path.basename(lauf.zugestellt[0].reportPath)).toBe('report-prompt-inbox-design-20261105-204000.md');
    expect(q).toContain('übergeben an design');
    expect(q).not.toContain('neu gestartet');
  });

  test('ohne Präfix-Treffer → bikosoc wie bisher, Quittung nennt bikosoc', () => {
    const u = umgebung({ '20261105-2099-unbekannt-smoketest.txt': 'Fachauftrag' });
    const lauf = processPromptInboxOnce({ homeDir: u.homeDir, now, runner: u.runner, paneText: BEREIT, routing: TABELLE });
    expect(u.aufrufe.map(a => a.args[2])).toEqual(['bikosoc', 'bikosoc']);
    expect(path.basename(lauf.zugestellt[0].reportPath)).toBe('report-prompt-inbox-20261105-204000.md');
    expect(fs.readFileSync(lauf.zugestellt[0].reportPath, 'utf-8')).toContain('übergeben an bikosoc');
  });

  test('fehlende Sitzung → Autostart, warten auf Prompt, dann einfügen', () => {
    const u = umgebung({ '20261105-2099-test-smoketest.txt': 'Antworte nur mit OK' });
    const gestartet: SitzungsRegel[] = [];
    let abfragen = 0;
    const lauf = processPromptInboxOnce({
      homeDir: u.homeDir, now, runner: u.runner, paneText: BEREIT, routing: TABELLE,
      sitzungen: {
        laeuft: () => gestartet.length > 0,
        starte: (r) => { gestartet.push(r); },
        pane: () => (++abfragen < 3 ? '' : BEREIT),
        startIntervallMs: 1, startWarteMs: 5000,
      },
    });
    expect(gestartet[0]).toMatchObject({ sitzung: 'inboxtest', verzeichnis: HOME });
    expect(u.aufrufe[0].args).toEqual(['send-keys', '-t', '=inboxtest:', '--', 'Antworte nur mit OK']);
    const q = fs.readFileSync(lauf.zugestellt[0].reportPath, 'utf-8');
    expect(q).toContain('übergeben an inboxtest (neu gestartet)');
    expect(q).toContain('ziel: inboxtest (neu gestartet)');
  });

  test('Start scheitert → Datei bleibt, Fehlquittung, kein Rückfall auf bikosoc, Sperrfrist', () => {
    const u = umgebung({ '20261105-2099-test-smoketest.txt': 'x' });
    const opts = {
      homeDir: u.homeDir, now, runner: u.runner, paneText: BEREIT, routing: TABELLE,
      sitzungen: { laeuft: () => false, starte: () => {}, pane: () => 'biko@host:~$ ', startIntervallMs: 1, startWarteMs: 20 },
    };
    const lauf = processPromptInboxOnce(opts);
    expect(u.aufrufe).toEqual([]);
    expect(fs.existsSync(path.join(u.inboxDir, '20261105-2099-test-smoketest.txt'))).toBe(true);
    expect(lauf.nichtUebergeben?.[0].gemeldet).toBe(true);
    const q = fs.readFileSync(lauf.nichtUebergeben![0].reportPath!, 'utf-8');
    expect(q).toContain('status: fehler');
    expect(q).toContain('Autostart');
    // Zweiter Lauf innerhalb der Sperrfrist: kein neuer Start, keine neue Meldung.
    let starts = 0;
    const zweiter = processPromptInboxOnce({ ...opts, sitzungen: { ...opts.sitzungen, starte: () => { starts++; } } });
    expect(starts).toBe(0);
    expect(zweiter.zurueckgestellt[0].grund).toContain('gescheitertem Autostart');
  });

  test('tmux-Fehler beim Start wird gemeldet statt abzustürzen', () => {
    const u = umgebung({ '20261105-2099-test-smoketest.txt': 'x' });
    const lauf = processPromptInboxOnce({
      homeDir: u.homeDir, now, runner: u.runner, paneText: BEREIT, routing: TABELLE,
      sitzungen: { laeuft: () => false, starte: () => { throw new Error('duplicate session'); } },
    });
    expect(lauf.nichtUebergeben?.[0].grund).toContain('nicht startbar');
  });

  test('beschäftigte Zielsitzung → Datei wartet, bikosoc bleibt unberührt', () => {
    const u = umgebung({ '20261105-2099-design-x.txt': 'x' });
    const lauf = processPromptInboxOnce({
      homeDir: u.homeDir, now, runner: u.runner, paneText: BEREIT, routing: TABELLE,
      sitzungen: { laeuft: () => true, pane: () => '✻ Cogitating… (esc to interrupt)\n' },
    });
    expect(u.aufrufe).toEqual([]);
    expect(lauf.zurueckgestellt).toHaveLength(1);
  });
});

describe('Leerlauf-Wächter', () => {
  test('geroutete Aufträge gelten in bikosoc nicht als offen', () => {
    const u = umgebung({});
    const doneDir = path.join(u.inboxDir, 'done');
    fs.mkdirSync(doneDir, { recursive: true });
    fs.writeFileSync(path.join(doneDir, '2026-11-05T19-30-00-000Z-20261105-2099-design-smoketest.txt'), 'x');
    fs.writeFileSync(path.join(doneDir, '2026-11-05T19-30-00-000Z-20261105-2099-fach-smoketest.txt'), 'x');
    const offen = offeneAuftraege({ doneDir, reportDir: path.join(u.homeDir, 'r'), now: new Date(), routing: TABELLE });
    expect(offen.map(o => o.kennung)).toEqual(['fach-smoketest']);
  });
});

describe('Report-Zuordnung bei Freigabeaufträgen', () => {
  test('freigabe-<stamm> findet report-<stamm>-…', async () => {
    const { hatReport } = await import('../index.js');
    expect(hatReport(['report-revolut-qcon-agi-20261103.md'], 'freigabe-revolut-qcon-agi')).toBe(true);
    expect(hatReport(['report-buchung-swt-n24-2026-20261105.md'], 'freigabe-buchung-swt-n24')).toBe(true);
    expect(hatReport(['report-anderes-20261105.md'], 'freigabe-revolut-qcon-agi')).toBe(false);
  });
});
