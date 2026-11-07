/**
 * Briefing-Ausbau (Owner-Auftrag 26.10.2026): Textbausteine, Taktgeber und
 * Mailversand. Ohne Netz und ohne Datenbank — der Graph-Aufruf ist gemockt.
 */
import { describe, test, expect } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  RUBRIK, ausfallZeile, alsTelegramHtml,
  ccEinordnung, ccAbschnittMorgen, ccAbschnittAbend,
  nkAbschnitt, bankingAbschnitt, tradingZeilen, reisenAbschnitt, gewichtAlterZusatz,
  abendZeilen, naechsteAktion,
  leseCcReports, ccLoginZeile, leseCcLoginStand,
} from '../index.js';
import type { CcReport, KontoStand } from '../index.js';

const cc = (statusRoh: string, titel = 'T', aktion = 'keine', strang: 'bikosoc' | 'hdcc' = 'bikosoc'): CcReport =>
  ({ datei: `report-${titel}.md`, strang, titel, statusRoh, aktion, zeit: '2026-10-26T10:00:00Z' });

describe('Telegram-HTML', () => {
  test('maskiert Inhalt und setzt nur Rubriken fett', () => {
    const html = alsTelegramHtml([`${RUBRIK}📆 Kalender`, '09:00 A<b>&C']);
    expect(html).toBe('<b>📆 Kalender</b>\n09:00 A&lt;b&gt;&amp;C');
  });
  test('Ausfallzeile ist eindeutig', () => {
    expect(ausfallZeile('Kalender')).toBe('⚠️ Kalender nicht abrufbar');
  });
});

describe('cc-Aufträge aus Reportköpfen', () => {
  test('Einordnung beider Stränge', () => {
    for (const s of ['aktion', 'fehler', 'wartet', 'BLOCKED', 'PARTIAL', 'REVIEW — wartet auf Owner-Freigabe',
      'DONE — wartet auf /arm fuer roten CLAUDE.md-Commit']) expect(ccEinordnung(s)).toBe('offen');
    for (const s of ['ok', 'hinweis', 'DONE']) expect(ccEinordnung(s)).toBe('erledigt');
    for (const s of ['uebergeben', '', 'approved_for_final']) expect(ccEinordnung(s)).toBe('ignorieren');
  });

  test('Morgen: nur offene, mit Aktion; ohne offene kein Abschnitt', () => {
    expect(ccAbschnittMorgen([cc('ok')])).toEqual([]);
    const z = ccAbschnittMorgen([cc('ok', 'A'), cc('aktion', 'Push nötig', 'Push geben'), cc('BLOCKED', 'Gate', 'keine', 'hdcc')]);
    expect(z[1]).toBe(`${RUBRIK}📋 Offene cc-Aufträge (24 h)`);
    expect(z).toContain('• 👉 Push nötig — Ihre Aktion: Push geben');
    expect(z).toContain('• ⏸ Gate [HDCC]');
    expect(z.join('\n')).not.toContain('• ✅');
  });

  test('Abend: erledigt als Anzahl, offen mit Titel', () => {
    const z = ccAbschnittAbend([cc('ok'), cc('hinweis'), cc('DONE', 'X', 'keine', 'hdcc'), cc('fehler', 'Kaputt')]);
    expect(z).toContain('• Erledigt: 3');
    expect(z).toContain('• Offen: 1');
    expect(z).toContain('  ❌ Kaputt');
    expect(ccAbschnittAbend([])).toContain('• Offen: keine');
  });

  test('liest Kopfblöcke, überspringt Übernahmen, alte und fremde Dateien', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'briefing-cc-'));
    const kopf = (status: string, typ = 'ergebnis') =>
      `---\ntyp: ${typ}\ntitel: Titel ${status}\nstatus: ${status}\naufgabe: a\nergebnis: [ "x" ]\naktion: "Tun"\n---\n# R\n`;
    fs.writeFileSync(path.join(dir, 'report-a.md'), kopf('aktion'));
    fs.writeFileSync(path.join(dir, 'report-b.md'), kopf('BLOCKED'));
    fs.writeFileSync(path.join(dir, 'report-c.md'), kopf('uebergeben', 'uebernahme'));
    fs.writeFileSync(path.join(dir, 'notiz.md'), kopf('fehler'));
    fs.writeFileSync(path.join(dir, 'report-alt.md'), kopf('fehler'));
    const alt = new Date('2026-01-01T00:00:00Z');
    fs.utimesSync(path.join(dir, 'report-alt.md'), alt, alt);

    const r = leseCcReports(new Date('2026-06-01T00:00:00Z'), [{ strang: 'hdcc', dir }]);
    expect(r.map(x => x.datei).sort()).toEqual(['report-a.md', 'report-b.md']);
    expect(r.find(x => x.datei === 'report-b.md')!.statusRoh).toBe('BLOCKED');
    expect(r[0].aktion).toBe('Tun');
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

describe('NK-Fristen', () => {
  const f = [
    { objekt: 'N24', bezeichnung: 'Wiedervorlage', termin: '2026-10-22', tage: -4 },
    { objekt: 'MG24', bezeichnung: 'NK 2025', termin: '2026-12-31', tage: 66, vorlaufHeute: false },
    { objekt: 'L19', bezeichnung: 'NK 2025', termin: '2026-12-31', tage: 45, vorlaufHeute: true },
    { objekt: 'D4', bezeichnung: 'Heute', termin: '2026-10-26', tage: 0 },
  ];
  test('Grenze 30 Tage, Vorlauf heute zusätzlich, nach Objekt sortiert', () => {
    const z = nkAbschnitt(f, 30, '🏠 NK-Fristen (30 Tage)');
    expect(z.slice(2)).toEqual([
      '• D4 — Heute: heute fällig ⚠️',
      '• L19 — NK 2025: in 45 Tagen (31.12.)',
      '• N24 — Wiedervorlage: überfällig seit 4 Tagen (22.10.) 🔴',
    ]);
  });
  test('nichts fällig → kein Abschnitt', () => {
    expect(nkAbschnitt([f[1]], 30, 'x')).toEqual([]);
  });
});

describe('Banking', () => {
  const jetzt = new Date('2026-10-26T06:00:00Z');
  const k = (b: number | null, sync: string | null, typ: string | null = 'giro', status = 'active'): KontoStand =>
    ({ status, accountType: typ, currency: 'EUR', currentBalance: b, lastSyncAt: sync });

  test('Summe ohne Darlehen, Warnung bei altem Saldo', () => {
    const z = bankingAbschnitt([
      k(1000.5, '2026-10-26T05:00:00Z'),
      k(-200, '2026-10-23T18:29:00Z'),
      k(-638625.53, '2026-10-26T05:00:00Z', 'darlehen'),
    ], jetzt);
    expect(z).toContain('• Kontensumme: 800,50 € (2 Konten, ohne Darlehen)');
    expect(z).toContain('⚠️ 1 Konto mit Saldo älter als 2 Tage (ältester Stand 23.10.)');
  });
  test('Mehrzahl: „Konten"', () => {
    const z = bankingAbschnitt([k(1, '2026-10-20T05:00:00Z'), k(2, '2026-10-21T05:00:00Z')], jetzt);
    expect(z).toContain('⚠️ 2 Konten mit Saldo älter als 2 Tage (ältester Stand 20.10.)');
  });
  test('alles frisch → keine Warnung', () => {
    const z = bankingAbschnitt([k(5, '2026-10-25T12:00:00Z')], jetzt);
    expect(z.some(x => x.startsWith('⚠️'))).toBe(false);
  });
});

describe('Trading', () => {
  const tage = [
    { date: '2026-10-22', report: { netLiquidation: 975606.73 } },
    { date: '2026-10-23', report: { netLiquidation: 975649.28 } },
    { date: '2026-10-26' },
  ];
  test('Verbindung und Vortageswert aus der Nettoliquidation', () => {
    expect(tradingZeilen({ connected: true }, tage, '2026-10-26')[2]).toBe('• verbunden · Vortag (23.10.): +42,55 $');
  });
  test('ohne Status: Ausfallzeile; ohne Berichte: Hinweis', () => {
    expect(tradingZeilen(null, tage, '2026-10-26')[2]).toBe('⚠️ Trading-Agent nicht abrufbar');
    expect(tradingZeilen({ connected: false }, [], '2026-10-26')[2]).toBe('• NICHT verbunden ⚠️ · Vortag: kein Tagesbericht');
  });
});

describe('Reisen und Gewicht', () => {
  test('laufende und in 7 Tagen beginnende Reisen', () => {
    const z = reisenAbschnitt([
      { name: 'Winnipeg', start_date: '2026-11-07', end_date: '2026-11-25' },
      { name: 'Köln', start_date: '2026-10-28', end_date: '2026-10-29' },
      { name: 'Jetzt', start_date: '2026-10-25', end_date: '2026-10-27' },
    ], '2026-10-26');
    expect(z.slice(2)).toEqual(['• Jetzt: unterwegs bis 27.10.', '• Köln: ab 28.10. (in 2 Tagen)']);
    expect(reisenAbschnitt([], '2026-10-26')).toEqual([]);
  });
  test('Messdatum nur, wenn älter als 2 Tage', () => {
    const jetzt = new Date('2026-10-26T06:00:00Z');
    expect(gewichtAlterZusatz('2026-10-25T06:00:00Z', jetzt)).toBe('');
    expect(gewichtAlterZusatz('2026-10-20T06:00:00Z', jetzt)).toBe(' — Messung vom 20.10.');
    expect(gewichtAlterZusatz(null, jetzt)).toBe('');
  });
});

describe('Abendbriefing-Text', () => {
  test('alle Abschnitte, Ausfälle sichtbar', () => {
    const z = abendZeilen({
      datumLang: 'Montag, 26. Oktober 2026',
      ccReports: [cc('ok'), cc('aktion', 'Push', 'Push geben')],
      termineMorgen: null,
      fuhrpark: ['• 🚗 Auto — TÜV in 10 Tagen (05.11.2026) ⚠️'],
      nkFristen: [{ objekt: 'N24', bezeichnung: 'W', termin: '2026-10-22', tage: -4 }],
    });
    const t = z.join('\n');
    expect(z[0]).toBe(`${RUBRIK}🌙 Abendbriefing — Montag, 26. Oktober 2026`);
    expect(t).toContain('• Erledigt: 1');
    expect(t).toContain('👉 Push — Ihre Aktion: Push geben');
    expect(t).toContain('⚠️ Kalender nicht abrufbar');
    expect(t).toContain('TÜV in 10 Tagen');
    expect(t).toContain('• N24 — W: überfällig seit 4 Tagen');
  });
  test('leere Quellen sagen „keine"', () => {
    const t = abendZeilen({ datumLang: 'x', ccReports: [], termineMorgen: [], fuhrpark: [], nkFristen: [] }).join('\n');
    expect(t).toContain('• keine Termine');
    expect(t).toContain('⏳ Fristen (14 Tage)\n• keine');
  });
});

describe('Taktgeber: erzeugen, nachholen, melden', () => {
  test('planmäßig nur in der Sollminute und nur einmal', () => {
    expect(naechsteAktion('07:00', '07:00', null)).toBe('erzeugen');
    expect(naechsteAktion('07:00', '07:00', { status: 'erzeugt', versuche: 1, fehlerGemeldet: false })).toBe(null);
    expect(naechsteAktion('07:01', '07:00', null)).toBe(null);
    expect(naechsteAktion('06:59', '07:00', null)).toBe(null);
  });
  test('zugestellt → nichts mehr', () => {
    expect(naechsteAktion('07:15', '07:00', { status: 'gesendet', versuche: 1, fehlerGemeldet: false })).toBe(null);
  });
  test('Timeout um 07:00 → um 07:15 einmal nachholen', () => {
    expect(naechsteAktion('07:15', '07:00', { status: 'fehler', versuche: 1, fehlerGemeldet: false })).toBe('nachholen');
  });
  test('Gateway um 07:00 aus → um 07:15 erster Versuch als Nachholen', () => {
    expect(naechsteAktion('07:15', '07:00', null)).toBe('nachholen');
    expect(naechsteAktion('07:40', '07:00', null)).toBe('nachholen');
  });
  test('auch der Nachholversuch scheiterte → Fehlermeldung, genau einmal', () => {
    expect(naechsteAktion('07:16', '07:00', { status: 'fehler', versuche: 2, fehlerGemeldet: false })).toBe('fehlermeldung');
    expect(naechsteAktion('07:17', '07:00', { status: 'fehler', versuche: 2, fehlerGemeldet: true })).toBe(null);
  });
  test('nach dem Fenster ist der Anlass vorbei', () => {
    expect(naechsteAktion('08:00', '07:00', null)).toBe(null);
  });
  test('Abendzeit 21:00 gleich behandelt', () => {
    expect(naechsteAktion('21:00', '21:00', null)).toBe('erzeugen');
    expect(naechsteAktion('21:15', '21:00', { status: 'fehler', versuche: 1, fehlerGemeldet: false })).toBe('nachholen');
  });
});

describe('Abendbriefing nur per Telegram (Owner-Vorgabe 27.10.2026)', () => {
  /* Die Mail-Ausnahme vom 26.10.2026 ist zurückgenommen. Diese Tests halten
     fest, dass kein Weg zurück in den Mailversand führt. */
  const wurzel = path.resolve(import.meta.dir, '..', '..', '..', '..');
  const code = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');

  test('das Briefing-Modul enthält keinen Mailversand', () => {
    const dir = path.resolve(import.meta.dir, '..');
    expect(fs.existsSync(path.join(dir, 'mail.ts'))).toBe(false);
    const treffer = fs.readdirSync(dir).filter(f => f.endsWith('.ts'))
      .filter(f => /sendMail|graphPost|createReply|createForward/.test(code(fs.readFileSync(path.join(dir, f), 'utf-8'))));
    expect(treffer).toEqual([]);
  });

  test('der Taktgeber stellt nur per Telegram zu', () => {
    const quelle = fs.readFileSync(path.join(wurzel, 'index.ts'), 'utf-8');
    const start = quelle.indexOf('async function briefingLauf(');
    const ende = quelle.indexOf('async function meldeAusfall(', start);
    expect(start).toBeGreaterThan(-1);
    const block = code(quelle.slice(start, ende));
    expect(block).toContain('sendTelegramHtmlWithMarkup(chatId, text');
    expect(block).not.toMatch(/sendMail|graphPost|sendeAbendbriefingMail|Mail/);
    expect(block).toContain('mailOk: null');
  });
});

/* ── Offene Aktionen: Postfachprüfung und 7-Tage-Regel (Owner-Auftrag 29.10.2026) ── */
import {
  mailZiele, betreffNormal, betreffKern, entwurfStand, berichtTag, offeneAktionen, istSendeAktion,
  pruefeOffeneAktionen, ladeErledigt, leseSekretariatFristen, AKTION_ZEILEN_MAX,
} from '../index.js';

const PORSCHE_REPORT = [
  '---', 'titel: Entwurf Unfallschaden Panamera', 'status: aktion', 'aufgabe: x', 'ergebnis: [ "a" ]',
  'aktion: "Entwurf im Postfach prüfen und senden"', 'tests: n/a', 'rote_zone: nein', 'dauer_min: 5', '---', '',
  '- **An:** info@porsche-villingen.de · **Cc:** keiner',
  '- **Betreff:** Unfallschaden Porsche Panamera TUT-ZZ 2E – Unfall 28.10.2026 Zürich',
].join('\n');
const MAXIM_TEXT = [
  '| Betreff | RE: Follow-up: share transfer | gleich |',
  '| An / Cc | dsullivan@maximgrp.com / corporateservices@maximgrp.com | gleich |',
].join('\n');

describe('Offene Aktionen: Entwurf gesendet?', () => {
  test('Empfänger und Betreff aus Aufzählung und Tabelle, Cc zählt nicht', () => {
    expect(mailZiele(PORSCHE_REPORT)).toEqual({
      an: ['info@porsche-villingen.de'],
      betreffe: ['unfallschaden porsche panamera tut-zz 2e – unfall 28.10.2026 zürich'],
      genau: ['unfallschaden porsche panamera tut-zz 2e – unfall 28.10.2026 zürich'],
    });
    expect(mailZiele(MAXIM_TEXT)).toEqual({ an: ['dsullivan@maximgrp.com'], betreffe: ['follow-up: share transfer'], genau: ['re: follow-up: share transfer'] });
    expect(mailZiele('- **An:** a@x.de · **Cc:** b@y.de').an).toEqual(['a@x.de']);
  });

  test('Betreff ohne RE:/AW:, Anführungszeichen und Gross/klein', () => {
    expect(betreffNormal('„AW: RE:  Zählerfragen  MG24“')).toBe('zählerfragen mg24');
  });

  test('Notizen nach dem Betreff fallen weg (Doris-Reports 28.10.)', () => {
    expect(betreffKern('N24 Nebenkostenabrechnung 2025 – Probeabrechnung v4 zur Prüfung (unverändert)'))
      .toBe('N24 Nebenkostenabrechnung 2025 – Probeabrechnung v4 zur Prüfung');
    expect(betreffKern('„RE: N24 Nebenkostenabrechnung 2025 – Probeabrechnung v4 zur Prüfung“: Antwort auf ihre Mail vom 28.10.'))
      .toBe('RE: N24 Nebenkostenabrechnung 2025 – Probeabrechnung v4 zur Prüfung');
    expect(mailZiele('| Betreff | Thema X (unverändert) |\n| An / Cc | d@b.com / – (unverändert) |'))
      .toEqual({ an: ['d@b.com'], betreffe: ['thema x', 'thema x (unverändert)'], genau: ['thema x', 'thema x (unverändert)'] });
  });

  test('Review 1: Antwort-Entwurf liegt noch, Erstmail im Strang gesendet → nicht gesendet', () => {
    const ziel = mailZiele('| Betreff | RE: Angebot v5 |\n| An | d@b.com |');
    const gesendet = [{ betreff: 'Angebot v5', an: ['d@b.com'], zeit: '2026-10-28T04:57:00Z' }];
    const entwuerfe = [{ betreff: 'RE: Angebot v5', an: ['d@b.com'], zeit: '2026-10-28T19:38:00Z' }];
    expect(entwurfStand(ziel, gesendet, entwuerfe, '2026-10-28T00:00:00Z').stand).toBe('entwurf');
  });
  test('Review 2: ohne Betreff im Report nie „gesendet"', () => {
    const ziel = mailZiele('- **An:** d@b.com');
    expect(entwurfStand(ziel, [{ betreff: 'Irgendwas', an: ['d@b.com'], zeit: '2026-10-29T09:00:00Z' }], [], '2026-10-29T00:00:00Z').stand).toBe('fehlt');
  });
  test('Review 5: Klammer, die zum Betreff gehört, passt trotzdem', () => {
    const ziel = mailZiele('- **An:** d@b.com\n- **Betreff:** Nebenkosten 2025 (MG24)');
    expect(entwurfStand(ziel, [{ betreff: 'Nebenkosten 2025 (MG24)', an: ['d@b.com'], zeit: '2026-10-29T09:00:00Z' }], [], '2026-10-29T00:00:00Z').stand).toBe('gesendet');
  });

  test('genauer Betreff hat Vorrang: Erstmail und Antwort im selben Strang', () => {
    const post = [
      { betreff: 'N24 NK 2025 v4', an: ['d@b.com'], zeit: '2026-10-28T05:57:45Z' },
      { betreff: 'RE: N24 NK 2025 v4', an: ['d@b.com'], zeit: '2026-10-28T20:38:52Z' },
    ];
    expect(entwurfStand(mailZiele('| Betreff | „RE: N24 NK 2025 v4“: Antwort |\n| An | d@b.com |'), post, [], '2026-10-28T00:00:00Z'))
      .toEqual({ stand: 'gesendet', zeit: '2026-10-28T20:38:52Z', an: 'd@b.com' });
    expect(entwurfStand(mailZiele('| Betreff | N24 NK 2025 v4 (unverändert) |\n| An / Cc | d@b.com / – |'), post, [], '2026-10-28T00:00:00Z'))
      .toEqual({ stand: 'gesendet', zeit: '2026-10-28T05:57:45Z', an: 'd@b.com' });
  });

  test('Sendeaktion erkennen', () => {
    expect(istSendeAktion('Entwurf an Derek Sullivan prüfen und senden')).toBe(true);
    expect(istSendeAktion('Entwürfe prüfen und senden')).toBe(true);
    expect(istSendeAktion('Steuererklärungen unterschreiben')).toBe(false);
  });

  const ziel = { an: ['dsullivan@maximgrp.com'], betreffe: ['follow-up: share transfer'] };
  const gesendet = [{ betreff: 'RE: Follow-up: share transfer', an: ['dsullivan@maximgrp.com'], zeit: '2026-10-29T08:23:48Z' }];
  test('gesendet: gleicher Empfänger, gleicher Betreff, nach dem Berichtstag', () => {
    expect(entwurfStand(ziel, gesendet, [], '2026-10-29T00:00:00Z'))
      .toEqual({ stand: 'gesendet', zeit: '2026-10-29T08:23:48Z', an: 'dsullivan@maximgrp.com' });
  });
  test('nicht gesendet: alter Versand vor dem Bericht, anderer Betreff, anderer Empfänger', () => {
    expect(entwurfStand(ziel, gesendet, [], '2026-10-30T00:00:00Z').stand).toBe('fehlt');
    expect(entwurfStand(ziel, [{ ...gesendet[0], betreff: 'Anderes Thema' }], [], '2026-10-29T00:00:00Z').stand).toBe('fehlt');
    expect(entwurfStand(ziel, [{ ...gesendet[0], an: ['x@y.de'] }], [], '2026-10-29T00:00:00Z').stand).toBe('fehlt');
  });
  test('Entwurf liegt noch: bleibt offen ohne Hinweis', () => {
    expect(entwurfStand(ziel, [], [{ ...gesendet[0], zeit: '2026-10-29T07:00:00Z' }], '2026-10-29T00:00:00Z').stand).toBe('entwurf');
  });
  test('mehrere Empfänger: erst erledigt, wenn alle eine Mail bekamen', () => {
    const zwei = { an: ['a@x.de', 'b@x.de'], betreffe: ['s'] };
    const nurA = [{ betreff: 's', an: ['a@x.de'], zeit: '2026-10-29T09:00:00Z' }];
    expect(entwurfStand(zwei, nurA, [], '2026-10-29T00:00:00Z').stand).toBe('fehlt');
    expect(entwurfStand(zwei, [...nurA, { betreff: 'AW: s', an: ['b@x.de'], zeit: '2026-10-29T10:00:00Z' }], [], '2026-10-29T00:00:00Z'))
      .toEqual({ stand: 'gesendet', zeit: '2026-10-29T10:00:00Z', an: 'a@x.de, b@x.de' });
  });
});

describe('Offene Aktionen: 7-Tage-Regel und Darstellung', () => {
  const r = (datei: string, titel = datei) => ({ ...cc('aktion', titel, 'Etwas tun'), datei, zeit: '2026-10-29T10:00:00Z' });
  test('Berichtstag aus dem Dateinamen, sonst Änderungszeit', () => {
    expect(berichtTag('report-x-20261022.md', '2026-10-29T10:00:00Z')).toBe('2026-10-22');
    expect(berichtTag('report-neuheiten-stunde-20261029-1407.md', '')).toBe('2026-10-29');
    expect(berichtTag('report-ohne-datum.md', '2026-10-27T10:00:00Z')).toBe('2026-10-27');
    // 00:30 Berlin = 23:30 UTC des Vortags → Berliner Tag zählt
    expect(berichtTag('report-ohne-datum.md', '2026-10-27T23:30:00Z')).toBe('2026-10-28');
  });
  test('eigenes Fenster einzeln, Vortage ≤ 7 Tage gezählt, älter gezählt, erledigt weg', () => {
    const o = offeneAktionen([r('report-a-20261029.md'), r('report-b-20261022.md'), r('report-c-20261021.md'), r('report-d-20261029.md')],
      '2026-10-29', '2026-10-29', new Set(['bikosoc:report-d-20261029.md']));
    expect(o.aktuell.map(x => x.datei)).toEqual(['report-a-20261029.md']);
    expect(o.vortage).toBe(1);
    expect(o.aelter).toBe(1);
    const morgen = offeneAktionen([r('report-a-20261028.md'), r('report-b-20261027.md')], '2026-10-29', '2026-10-28', new Set());
    expect(morgen.aktuell.map(x => x.datei)).toEqual(['report-a-20261028.md']);
    expect(morgen.vortage).toBe(1);
  });
  test('Abend: Liste, Hinweis, Sammelzeilen; ohne Offenes „keine"', () => {
    const viele = Array.from({ length: AKTION_ZEILEN_MAX + 2 }, (_, i) => ({ ...r(`report-${i}-20261029.md`, `T${i}`) }));
    const z = ccAbschnittAbend([cc('ok')], { aktuell: [{ ...viele[0], hinweis: 'Entwurf nicht mehr in Entwürfe' }, ...viele.slice(1)], vortage: 4, aelter: 3 });
    expect(z).toContain('• Erledigt: 1');
    expect(z).toContain(`• Offen: ${AKTION_ZEILEN_MAX + 2}`);
    expect(z.some(x => x.includes('T0 — Ihre Aktion: Etwas tun (Entwurf nicht mehr in Entwürfe)'))).toBe(true);
    expect(z).toContain('  … weitere 2 offene Aktionen');
    expect(z).toContain('  offene Aktionen der Vortage (≤ 7 Tage): 4');
    expect(z).toContain('  ältere offene Aktionen: 3');
    expect(ccAbschnittAbend([], { aktuell: [], vortage: 0, aelter: 0 })).toEqual(['', `${RUBRIK}📋 cc-Aufträge heute`, '• Erledigt: 0', '• Offen: keine']);
    const lang = ccAbschnittAbend([], { aktuell: [{ ...r('report-l-20261029.md', 'L'), aktion: 'x'.repeat(500) }], vortage: 0, aelter: 0 });
    expect(lang.find(z => z.includes('Ihre Aktion'))!.length).toBeLessThan(220);
  });
  test('Morgen mit geprüfter Liste; nichts offen → kein Abschnitt', () => {
    expect(ccAbschnittMorgen([], { aktuell: [], vortage: 0, aelter: 0 })).toEqual([]);
    expect(ccAbschnittMorgen([], { aktuell: [], vortage: 0, aelter: 2 })).toContain('• ältere offene Aktionen: 2');
  });
});

describe('pruefeOffeneAktionen: Postfach, Merkdatei, Ausfall', () => {
  const ablage = () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aktionen-'));
    fs.writeFileSync(path.join(dir, 'report-mail-entwurf-porsche-20261029.md'), PORSCHE_REPORT);
    fs.writeFileSync(path.join(dir, 'report-heni-20261029.md'), PORSCHE_REPORT
      .replace('Entwurf Unfallschaden Panamera', 'Heni').replace('Entwurf im Postfach prüfen und senden', 'Steuererklärungen unterschreiben'));
    fs.writeFileSync(path.join(dir, 'report-alt-20261001.md'), PORSCHE_REPORT.replace('Entwurf Unfallschaden Panamera', 'Alt'));
    // Reportzeit wie im echten Fall: Report 07:29, gesendet 07:33
    const t = new Date('2026-10-29T07:29:42Z');
    for (const f of fs.readdirSync(dir)) fs.utimesSync(path.join(dir, f), t, t);
    return dir;
  };
  const gesendet = [{ betreff: 'Unfallschaden Porsche Panamera TUT-ZZ 2E – Unfall 28.10.2026 Zürich', an: ['info@porsche-villingen.de'], zeit: '2026-10-29T07:33:37Z' }];

  test('gesendeter Entwurf fällt heraus und wird vermerkt; Report bleibt unverändert', async () => {
    const dir = ablage();
    const merk = path.join(dir, '.aktionen-erledigt.json');
    const vorher = fs.statSync(path.join(dir, 'report-mail-entwurf-porsche-20261029.md')).mtimeMs;
    let abfragen = 0;
    const holePostfach = async () => { abfragen++; return { gesendet, entwuerfe: [] }; };
    const e = await pruefeOffeneAktionen({ heute: '2026-10-29', abTag: '2026-10-29', holePostfach, ablagen: [{ strang: 'bikosoc', dir }], erledigtDatei: merk });
    expect(e.offen.aktuell.map(x => x.titel)).toEqual(['Heni']);
    expect(e.offen.aelter).toBe(1);
    expect(e.postfachAusfall).toBe(false);
    expect(ladeErledigt(merk)).toEqual([expect.objectContaining({
      schluessel: 'bikosoc:report-mail-entwurf-porsche-20261029.md', grund: 'gesendet 2026-10-29T07:33:37Z an info@porsche-villingen.de' })]);
    expect(fs.statSync(path.join(dir, 'report-mail-entwurf-porsche-20261029.md')).mtimeMs).toBe(vorher);
    // Zweiter Lauf: aus der Merkdatei erledigt, keine erneute Postfachabfrage
    const e2 = await pruefeOffeneAktionen({ heute: '2026-10-29', abTag: '2026-10-29', holePostfach, ablagen: [{ strang: 'bikosoc', dir }], erledigtDatei: merk });
    expect(e2.offen.aktuell.map(x => x.titel)).toEqual(['Heni']);
    expect(abfragen).toBe(1);
    expect(ladeErledigt(merk).length).toBe(1);
  });

  test('Entwurf liegt noch → bleibt gelistet; Postfach fällt aus → Liste ohne Prüfung, Ausfall gemeldet', async () => {
    const dir = ablage();
    const merk = path.join(dir, '.aktionen-erledigt.json');
    const liegt = await pruefeOffeneAktionen({ heute: '2026-10-29', abTag: '2026-10-29', ablagen: [{ strang: 'bikosoc', dir }], erledigtDatei: merk,
      holePostfach: async () => ({ gesendet: [], entwuerfe: [{ ...gesendet[0], zeit: '2026-10-29T07:00:00Z' }] }) });
    expect(liegt.offen.aktuell.map(x => [x.titel, x.hinweis]).sort()).toEqual([['Entwurf Unfallschaden Panamera', undefined], ['Heni', undefined]]);
    const aus = await pruefeOffeneAktionen({ heute: '2026-10-29', abTag: '2026-10-29', ablagen: [{ strang: 'bikosoc', dir }], erledigtDatei: merk,
      holePostfach: async () => { throw new Error('graph down'); } });
    expect(aus.postfachAusfall).toBe(true);
    expect(aus.offen.aktuell.length).toBe(2);
    expect(fs.existsSync(merk)).toBe(false);
  });

  test('langsames Postfach: Zeitlimit greift, Briefing bekommt die Liste mit Ausfall', async () => {
    const dir = ablage();
    const start = Date.now();
    const e = await pruefeOffeneAktionen({ heute: '2026-10-29', abTag: '2026-10-29', ablagen: [{ strang: 'bikosoc', dir }],
      erledigtDatei: path.join(dir, '.m.json'), zeitlimitMs: 50, holePostfach: () => new Promise(() => {}) });
    expect(Date.now() - start).toBeLessThan(2000);
    expect(e.postfachAusfall).toBe(true);
    expect(e.offen.aktuell.length).toBe(2);
  });

  test('Entwurf weder gesendet noch in Entwürfe → gelistet mit Hinweis', async () => {
    const dir = ablage();
    const e = await pruefeOffeneAktionen({ heute: '2026-10-29', abTag: '2026-10-29', ablagen: [{ strang: 'bikosoc', dir }], erledigtDatei: path.join(dir, '.m.json'),
      holePostfach: async () => ({ gesendet: [], entwuerfe: [] }) });
    expect(e.offen.aktuell.find(x => x.titel === 'Entwurf Unfallschaden Panamera')?.hinweis)
      .toBe('Entwurf nicht mehr in Entwürfe, keine gesendete Mail gefunden');
  });
});

describe('Sekretariat-Fristen im Abendbriefing', () => {
  const datei = () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sek-'));
    const p = path.join(dir, 'vorgaenge.json');
    fs.writeFileSync(p, JSON.stringify({ vorgaenge: [
      { kennung: 'v-1', objekt: 'privat', titel: 'ELSTER', status: 'offen', fristen: [
        { termin: '2026-12-31', was: 'ELSTER: Bekanntgabe annehmen oder widersprechen', vorlaufTage: 14 },
        { termin: '2027-02-28', was: 'Steuererklärung 2025 über Heni abgeben', vorlaufTage: 14 }] },
      { kennung: 'v-2', objekt: 'privat', titel: 'Erledigt', status: 'erledigt', fristen: [{ termin: '2026-12-20', was: 'x' }] },
    ] }));
    return p;
  };
  test('erst ab Vorlauf sichtbar, bis zur Erledigung auch überfällig', () => {
    const p = datei();
    expect(leseSekretariatFristen('2026-12-16', p)).toEqual([]);
    expect(leseSekretariatFristen('2026-12-17', p)).toEqual([{ objekt: 'privat', bezeichnung: 'ELSTER: Bekanntgabe annehmen oder widersprechen', termin: '2026-12-31', tage: 14 }]);
    expect(leseSekretariatFristen('2027-01-02', p).map(f => f.tage)).toEqual([-2]);
    expect(leseSekretariatFristen('2027-02-14', p).map(f => f.termin)).toEqual(['2026-12-31', '2027-02-28']);
  });
  test('Vorlauf leer oder null → 14 Tage', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sek-'));
    const p = path.join(dir, 'vorgaenge.json');
    fs.writeFileSync(p, JSON.stringify({ vorgaenge: [{ kennung: 'v', objekt: 'privat', status: 'offen',
      fristen: [{ termin: '2026-12-31', was: 'a', vorlaufTage: null }, { termin: '2026-12-31', was: 'b', vorlaufTage: '' }] }] }));
    expect(leseSekretariatFristen('2026-12-17', p).length).toBe(2);
    expect(leseSekretariatFristen('2026-12-16', p).length).toBe(0);
  });
  test('Abendtext zeigt die Frist; Ausfall als eigene Zeile', () => {
    const t = abendZeilen({ datumLang: 'x', ccReports: [], termineMorgen: [], fuhrpark: [], nkFristen: [],
      sekretariatFristen: leseSekretariatFristen('2026-12-17', datei()) }).join('\n');
    expect(t).toContain('• privat — ELSTER: Bekanntgabe annehmen oder widersprechen: in 14 Tagen (31.12.)');
    const aus = abendZeilen({ datumLang: 'x', ccReports: [], termineMorgen: [], fuhrpark: [], nkFristen: [], sekretariatFristen: null }).join('\n');
    expect(aus).toContain('⚠️ Sekretariat-Fristen nicht abrufbar');
  });
});


describe('cc-Login im Abendbriefing (02.11.2026)', () => {
  const ok = { tokenDa: true, rechte: '600', ablauf: '2027-10-25' };
  test('Schwellen wie die Smoke-Prüfung', () => {
    expect(ccLoginZeile(ok, '2026-11-02')).toBe('🔑 cc-Login: ok (bis 25.10.2027)');
    expect(ccLoginZeile(ok, '2027-10-05')).toBe('⚠️ cc-Login: läuft ab in 20 Tagen (25.10.2027)');
    expect(ccLoginZeile(ok, '2027-10-24')).toBe('❌ cc-Login: läuft ab in 1 Tag (25.10.2027)');
    expect(ccLoginZeile(ok, '2027-10-26')).toBe('❌ cc-Login: abgelaufen am 25.10.2027');
    expect(ccLoginZeile({ ...ok, tokenDa: false }, '2026-11-02')).toBe('❌ cc-Login: Token-Datei fehlt');
    expect(ccLoginZeile({ ...ok, rechte: '644' }, '2026-11-02')).toMatch(/Rechte 644 statt 600/);
    expect(ccLoginZeile({ ...ok, ablauf: null }, '2026-11-02')).toBe('⚠️ cc-Login: Ablaufdatum unbekannt');
  });

  test('Zeile am Ende des Abendbriefings, Ausfall sichtbar, ohne Angabe nichts', () => {
    const basis = { datumLang: 'x', ccReports: [], termineMorgen: [], fuhrpark: [], nkFristen: [] };
    const z = abendZeilen({ ...basis, ccLogin: '🔑 cc-Login: ok (bis 25.10.2027)' });
    expect(z[z.length - 1]).toBe('🔑 cc-Login: ok (bis 25.10.2027)');
    expect(abendZeilen({ ...basis, ccLogin: null }).join('\n')).toContain('cc-Login nicht abrufbar');
    expect(abendZeilen(basis).join('\n')).not.toContain('cc-Login');
  });

  test('leseCcLoginStand liest nur Rechte und Ablaufdatei', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'cclogin-'));
    expect(leseCcLoginStand(home)).toEqual({ tokenDa: false, rechte: null, ablauf: null });
    fs.writeFileSync(path.join(home, '.claude-oauth-token'), 'geheim', { mode: 0o600 });
    fs.writeFileSync(path.join(home, '.claude-oauth-token.expires'), '2027-10-25\n');
    const stand = leseCcLoginStand(home);
    expect(stand).toEqual({ tokenDa: true, rechte: '600', ablauf: '2027-10-25' });
    expect(JSON.stringify(stand)).not.toContain('geheim');
    fs.rmSync(home, { recursive: true, force: true });
  });
});

/* ── Vorschlag 4b (Owner-Freigabe 07.11.2026): ohne Betreff, Yahoo ── */
import { yahooPostfachStand, postfaecherVereint } from '../index.js';

describe('4b: Versandprüfung ohne Betreff und mit Yahoo', () => {
  const ohneBetreff = mailZiele('- **An:** jens.fehr@swtenergie.de · **Cc:** sandro.winter@swtenergie.de');
  const berichtZeit = '2026-11-06T08:05:36Z';
  const seit = '2026-11-06T07:05:36Z';
  const fehrMail = { betreff: 'RE: PV-Abrechnung La Perla', an: ['jens.fehr@swtenergie.de'], zeit: '2026-11-06T08:18:25Z' };

  test('ohne Betreff + nach der Reportzeit gesendet → gesendet', () => {
    expect(ohneBetreff.betreffe).toEqual([]);
    expect(entwurfStand(ohneBetreff, [fehrMail], [], seit, berichtZeit))
      .toEqual({ stand: 'gesendet', zeit: '2026-11-06T08:18:25Z', an: 'jens.fehr@swtenergie.de' });
  });

  test('ohne Betreff + Entwurf liegt noch → entwurf', () => {
    expect(entwurfStand(ohneBetreff, [fehrMail], [{ ...fehrMail, zeit: '2026-11-06T08:00:00Z' }], seit, berichtZeit).stand).toBe('entwurf');
  });

  test('andere Mail an denselben Empfänger VOR der Reportzeit zählt nicht', () => {
    const frueher = { ...fehrMail, zeit: '2026-11-06T07:30:00Z' };
    expect(entwurfStand(ohneBetreff, [frueher], [], seit, berichtZeit).stand).toBe('fehlt');
  });

  test('ohne Reportzeit bleibt es bei „fehlt“ (alter Aufruf)', () => {
    expect(entwurfStand(ohneBetreff, [fehrMail], [], seit).stand).toBe('fehlt');
  });

  test('alle An-Empfänger nötig', () => {
    const zwei = mailZiele('- **An:** a@x.de, b@x.de');
    expect(entwurfStand(zwei, [{ betreff: 'x', an: ['a@x.de'], zeit: '2026-11-06T09:00:00Z' }], [], seit, berichtZeit).stand).toBe('fehlt');
  });

  test('Kopfzeile betreff: wird gelesen', () => {
    const z = mailZiele('---\naktion: "Entwurf senden"\nbetreff: "RE: Einspruch 8728"\n---\n- **An:** kundenservice@swtenergie.de');
    expect(z.betreffe).toEqual(['einspruch 8728']);
  });

  function fakeImap(sent: any[], drafts: any[]) {
    const gesperrt: string[] = [];
    let offen = '';
    return {
      gesperrt,
      list: async () => [{ path: 'Inbox' }, { path: 'Sent', specialUse: '\\Sent' }, { path: 'Draft', specialUse: '\\Drafts' }, { path: 'Bulk', specialUse: '\\Junk' }],
      getMailboxLock: async (p: string, o: { readOnly: true }) => { expect(o.readOnly).toBe(true); gesperrt.push(p); offen = p; return { release: () => { offen = ''; } }; },
      search: async () => (offen === 'Sent' ? sent : drafts).map((_, i) => i + 1),
      fetch: async function* () { for (const m of offen === 'Sent' ? sent : drafts) yield m; },
    };
  }

  test('Yahoo: Sent ab Grenze, Draft komplett, nur lesend', async () => {
    const c = fakeImap(
      [{ envelope: { subject: 'Re: Rückversand – Bestellung 51854', to: [{ address: 'Info@Digitale-Fotografien.com' }], date: new Date('2026-10-30T08:40:52Z') } },
       { envelope: { subject: 'alt', to: [{ address: 'x@y.de' }], date: new Date('2026-10-20T08:00:00Z') } }],
      [{ envelope: { subject: 'Re: Helly', to: [{ address: 'support.de.de@hellyhansen.com' }], date: new Date('2026-11-07T11:06:19Z') } }],
    );
    const st = await yahooPostfachStand(c as any, '2026-10-29T00:00:00Z');
    expect(c.gesperrt).toEqual(['Sent', 'Draft']);
    expect(st.gesendet).toEqual([{ betreff: 'Re: Rückversand – Bestellung 51854', an: ['info@digitale-fotografien.com'], zeit: '2026-10-30T08:40:52.000Z' }]);
    expect(st.entwuerfe.length).toBe(1);
    // Yahoo-Treffer schließt einen Anker-Report ohne Betreff
    const anker = mailZiele('- **An:** info@digitale-fotografien.com');
    const pf = postfaecherVereint({ gesendet: [], entwuerfe: [] }, st);
    expect(entwurfStand(anker, pf.gesendet, pf.entwuerfe, '2026-10-30T07:38:31Z', '2026-10-30T08:38:31Z').stand).toBe('gesendet');
  });
});

/* ── Vorschlag 4a: Abschnitt „Zuordnungsfragen" ── */
import { zuordnungsAbschnitt, leseVorbriefing, abendZeilen as abendZeilen4a } from '../index.js';

describe('4a: Zuordnungsfragen im Briefing', () => {
  const jetzt = new Date('2026-11-08T06:00:00Z');
  const basis = { zeit: '2026-11-08T05:52:00Z', dauerSek: 300, kostenUsd: 0.4, quellen: [{ name: 'juergen.bickel@', ok: true }], fragen: [] as any[] };
  const frage = (i: number) => ({ kurz: `K${i}`, frage: `Frage ${i}`, freigabe: `Freigabe Vorgang K${i}` });

  test('Aufbau: höchstens 5 Zeilen mit Freigabewort, Rest gezählt', () => {
    const z = zuordnungsAbschnitt({ ...basis, fragen: [1, 2, 3, 4, 5, 6, 7].map(frage) }, jetzt);
    expect(z[1]).toContain('Zuordnungsfragen');
    expect(z.filter(x => x.startsWith('• K')).length).toBe(5);
    expect(z).toContain('• K1: Frage 1 → Freigabe Vorgang K1');
    expect(z).toContain('• … und 2 weitere im Stundenreport');
  });
  test('ohne Fragen: Hinweis statt Leerstelle', () => {
    expect(zuordnungsAbschnitt(basis, jetzt)).toContain('• keine offenen Zuordnungsfragen');
  });
  test('Quellenausfall: „Quelle X nicht abrufbar"', () => {
    const z = zuordnungsAbschnitt({ ...basis, quellen: [{ name: 'Gesendet Yahoo', ok: false, grund: 'timeout' }, { name: 'data@', ok: true }] }, jetzt);
    expect(z).toContain('⚠️ Quelle Gesendet Yahoo nicht abrufbar');
    expect(z.some(x => x.includes('data@'))).toBe(false);
  });
  test('Kostendeckel / Abbruch und veralteter Stand werden gemeldet', () => {
    const z = zuordnungsAbschnitt({ ...basis, zeit: '2026-11-07T19:52:00Z', abbruch: 'Kostendeckel 1.50 $ erreicht – Rest im nächsten Lauf' }, jetzt);
    expect(z.some(x => x.startsWith('⚠️ Vorlauf-Suche nicht aktuell'))).toBe(true);
    expect(z).toContain('⚠️ Vorlauf-Suche vorzeitig beendet: Kostendeckel 1.50 $ erreicht – Rest im nächsten Lauf');
  });
  test('keine Datei → Ausfallzeile; Abendbriefing nimmt den Abschnitt auf', () => {
    expect(leseVorbriefing(path.join(os.tmpdir(), 'gibt-es-nicht.json'))).toBeNull();
    expect(zuordnungsAbschnitt(null, jetzt)).toContain('⚠️ Vorlauf-Suche nicht abrufbar');
    const a = abendZeilen4a({ datumLang: 'x', ccReports: [], termineMorgen: [], fuhrpark: [], nkFristen: [], zuordnung: zuordnungsAbschnitt(basis, jetzt) });
    expect(a.some(x => x.includes('Zuordnungsfragen'))).toBe(true);
  });
});
