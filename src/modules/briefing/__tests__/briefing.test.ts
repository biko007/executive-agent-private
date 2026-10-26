/**
 * Briefing-Ausbau (Owner-Auftrag 26.10.2026): Textbausteine, Taktgeber und
 * Mailversand. Ohne Netz und ohne Datenbank — der Graph-Aufruf ist gemockt.
 */
import { describe, test, expect } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  RUBRIK, ausfallZeile, alsTelegramHtml, alsMailText,
  ccEinordnung, ccAbschnittMorgen, ccAbschnittAbend,
  nkAbschnitt, bankingAbschnitt, tradingZeilen, reisenAbschnitt, gewichtAlterZusatz,
  abendZeilen, naechsteAktion,
  ABENDBRIEFING_EMPFAENGER, abendBetreff, abendMailAnfrage, sendeAbendbriefingMail,
  leseCcReports,
} from '../index.js';
import type { CcReport, KontoStand } from '../index.js';

const cc = (statusRoh: string, titel = 'T', aktion = 'keine', strang: 'bikosoc' | 'hdcc' = 'bikosoc'): CcReport =>
  ({ datei: `report-${titel}.md`, strang, titel, statusRoh, aktion, zeit: '2026-10-26T10:00:00Z' });

describe('Telegram-HTML und Mailtext', () => {
  test('maskiert Inhalt und setzt nur Rubriken fett', () => {
    const html = alsTelegramHtml([`${RUBRIK}📆 Kalender`, '09:00 A<b>&C']);
    expect(html).toBe('<b>📆 Kalender</b>\n09:00 A&lt;b&gt;&amp;C');
  });
  test('Mailtext ohne Steuerzeichen, Überschrift groß', () => {
    expect(alsMailText([`${RUBRIK}Termine morgen`, '• x'])).toBe('TERMINE MORGEN\n• x');
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

describe('Mailversand Abendbriefing — eng gefasste Ausnahme', () => {
  test('genau ein fester Empfänger: das eigene Postfach', () => {
    expect(ABENDBRIEFING_EMPFAENGER).toBe('juergen.bickel@bikolino.com');
    const { url, body } = abendMailAnfrage({ betreff: 'B', text: 'T' });
    expect(url).toBe('https://graph.microsoft.com/v1.0/users/juergen.bickel%40bikolino.com/sendMail');
    expect(body.message.toRecipients).toEqual([{ emailAddress: { address: 'juergen.bickel@bikolino.com' } }]);
    expect(body.message.ccRecipients).toBeUndefined();
    expect(body.message.bccRecipients).toBeUndefined();
    expect(body.message.body).toEqual({ contentType: 'Text', content: 'T' });
  });

  test('die Versandfunktion nimmt keinen Empfänger entgegen', () => {
    // Zwei Parameter: Graph-Aufruf und Mail (Betreff + Text). Kein dritter.
    expect(sendeAbendbriefingMail.length).toBe(2);
    expect(abendMailAnfrage({ betreff: 'B', text: 'T', an: 'fremd@example.com' } as any).body.message.toRecipients)
      .toEqual([{ emailAddress: { address: ABENDBRIEFING_EMPFAENGER } }]);
  });

  test('Versand ruft Graph genau einmal mit der festen Anfrage (gemockt)', async () => {
    const aufrufe: { url: string; body: any }[] = [];
    await sendeAbendbriefingMail(async (url, body) => { aufrufe.push({ url, body }); }, { betreff: abendBetreff('26.10.2026'), text: 'Hallo' });
    expect(aufrufe.length).toBe(1);
    expect(aufrufe[0].body.message.subject).toBe('Abendbriefing 26.10.2026');
  });

  test('Graph-Fehler wird weitergereicht', async () => {
    await expect(sendeAbendbriefingMail(async () => { throw new Error('401'); }, { betreff: 'B', text: 'T' }))
      .rejects.toThrow('401');
  });

  test('Testkennzeichnung im Betreff', () => {
    expect(abendBetreff('26.10.2026', true)).toBe('[TEST] Abendbriefing 26.10.2026');
  });

  test('kein weiterer sendMail-Aufruf im Modul', () => {
    const dir = path.resolve(import.meta.dir, '..');
    const treffer = fs.readdirSync(dir).filter(f => f.endsWith('.ts'))
      .filter(f => fs.readFileSync(path.join(dir, f), 'utf-8').includes('/sendMail'));
    expect(treffer).toEqual(['mail.ts']);
  });
});
