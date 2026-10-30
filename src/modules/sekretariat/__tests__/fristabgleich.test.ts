/**
 * Fristen-Abgleich gegen Gesendete Elemente und Fristanzeige im Briefing
 * (Owner-Auftrag 30.10.2026, Rüge „Schon wieder???“). Ohne Netz und ohne
 * Datenbank — Abfrage, Postfach und Text sind eingereicht.
 */
import { describe, test, expect } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  fristAbgleich, verlangtMail, themaStaemme, folgeTermin, adressePasst, type GesendeteMail,
} from '../fristabgleich.js';
import { nkFristZeilen, abendZeilen, leseSekretariatFristen } from '../../briefing/index.js';

const EKO_FRIST = {
  id: '2', objekt: 'N24', bezeichnung: 'energiekonzept: finale Jahresabrechnungen 2025 anmahnen (N24 und MG24)',
  notes: 'Ansprechpartnerin Sarah Schlager, abrechnung@ekonzept.eu.', created_at: '2026-10-17T06:47:06.801Z',
};
const EKO_MAIL: GesendeteMail = {
  id: 'g1', mailId: '<FR0P281@outlook>', an: ['abrechnung@ekonzept.eu', 'huber@bikolino.com'],
  betreff: 'AW: Monatliche Verbrauchsinformation per E-Mail und Zählerstände – Nonnenburgstraße 24 (Projekt 34101)',
  zeit: '2026-10-27T19:31:18.000Z',
  text: 'Sehr geehrte Frau Schlager, auf meine E-Mail vom 15.10.2026 und auf meinen Widerspruch zur TEST-Jahresabrechnung 2025 …',
};

/** Abfrage-Attrappe: liefert Fristen, merkt sich Schreibbefehle. */
function attrappe(fristen: any[]) {
  const geschrieben: { sql: string; p: unknown[] }[] = [];
  const query = async (sql: string, p: unknown[] = []) => {
    if (/^\s*SELECT/i.test(sql)) return { rows: fristen };
    geschrieben.push({ sql, p });
    return { rows: /UPDATE/i.test(sql) ? [{ id: p[0] }] : [] };
  };
  return { query, geschrieben };
}

describe('Fristen-Abgleich', () => {
  test('Frist mit Mail-Treffer → erledigt mit Versanddatum und Audit', async () => {
    const a = attrappe([EKO_FRIST]);
    const r = await fristAbgleich({ query: a.query, holeGesendet: async () => [EKO_MAIL], holeText: async () => EKO_MAIL.text,
      jetzt: new Date('2026-10-30T07:00:00Z') });
    expect(r.erledigt.length).toBe(1);
    expect(r.erledigt[0].erledigtAm).toBe('2026-10-27');
    expect(r.erledigt[0].mail.mailId).toBe('<FR0P281@outlook>');
    const upd = a.geschrieben.find(x => /UPDATE objekt_fristen/.test(x.sql))!;
    expect(upd.p.slice(0, 2)).toEqual([2, '2026-10-27']);
    const aud = a.geschrieben.find(x => /INSERT INTO audit_log/.test(x.sql))!;
    expect(aud.sql).toContain("'frist.auto-erledigt'");
    expect(JSON.parse(String(aud.p[3])).mail.zeit).toBe('2026-10-27T19:31:18.000Z');
  });

  test('ohne Treffer bleibt die Frist offen: anderer Empfänger, anderes Thema, vor Anlage', async () => {
    const anders = [
      { ...EKO_MAIL, an: ['info@stadtwerke.de'] },
      { ...EKO_MAIL, betreff: 'Kaffee', text: 'Termin nächste Woche?' },
      { ...EKO_MAIL, zeit: '2026-10-15T12:49:18.000Z' },
    ];
    const a = attrappe([EKO_FRIST]);
    const r = await fristAbgleich({ query: a.query, holeGesendet: async () => anders, holeText: async () => 'nichts dazu' });
    expect(r.erledigt).toEqual([]);
    expect(a.geschrieben).toEqual([]);
  });

  test('Thema nur im eigenen Text: Vorschau mit Zitat zählt nicht', async () => {
    const a = attrappe([EKO_FRIST]);
    const r = await fristAbgleich({ query: a.query, holeGesendet: async () => [{ ...EKO_MAIL, text: '' }],
      holeText: async () => 'Bitte die Jahresabrechnungen bis zum 10.11.2026 senden.', probe: true });
    const zitat = await fristAbgleich({ query: attrappe([EKO_FRIST]).query, holeGesendet: async () => [EKO_MAIL],
      holeText: async () => 'Danke, Gruß', probe: true });
    expect(zitat.erledigt).toEqual([]);
    expect(r.erledigt.length).toBe(1);
    expect(r.erledigt[0].vorschlag).toEqual({ was: 'Antwort von energiekonzept (Mail vom 27.10.)', termin: '2026-11-10' });
    expect(a.geschrieben).toEqual([]); // Probe schreibt nichts
  });

  test('Fristen, die auf eine Antwort warten, gelten nicht als „Mail verlangt“', () => {
    expect(verlangtMail(EKO_FRIST.bezeichnung)).toBe(true);
    expect(verlangtMail('energiekonzept: Antwort auf Mail vom 27.10. (4 Punkte)')).toBe(false);
    expect(verlangtMail('Nebenkostenabrechnung 2025 muss den Mietern zugehen')).toBe(false);
  });

  test('Bausteine: Themenstämme, Folgetermin, Allerweltsdomain', () => {
    expect(themaStaemme(EKO_FRIST.bezeichnung)).toEqual(['finale', 'jahresa']);
    expect(folgeTermin('ohne Datum', '2026-10-28T17:52:25.000Z')).toBe('2026-11-11');
    expect(adressePasst(['s.schlager@ekonzept.eu'], ['abrechnung@ekonzept.eu'])).toBe(true);
    expect(adressePasst(['a@gmail.com'], ['b@gmail.com'])).toBe(false);
  });

  test('Sekretariat-Frist: Treffer setzt erledigt, Vorschlag und Beleg in vorgaenge.json', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'abgl-'));
    const datei = path.join(dir, 'vorgaenge.json');
    fs.writeFileSync(datei, JSON.stringify({ vorgaenge: [{ kennung: 'v-1', objekt: 'privat', status: 'offen', erstellt: '2026-10-20T00:00:00.000Z',
      fristen: [
        { termin: '2026-10-25', was: 'energiekonzept: Jahresabrechnungen anmahnen', vorlaufTage: 3, an: ['abrechnung@ekonzept.eu'], angelegt: '2026-10-20T00:00:00.000Z' },
        // ohne Anlagezeit: nicht geprüft
        { termin: '2026-10-25', was: 'energiekonzept: Jahresabrechnungen anmahnen', vorlaufTage: 3, an: ['abrechnung@ekonzept.eu'] },
      ] }] }));
    const a = attrappe([]);
    const r = await fristAbgleich({ query: a.query, holeGesendet: async () => [EKO_MAIL], holeText: async () => EKO_MAIL.text, sekDatei: datei });
    expect(r.erledigt.map(e => e.frist.schluessel)).toEqual(['v-1#0']);
    const f = JSON.parse(fs.readFileSync(datei, 'utf-8')).vorgaenge[0].fristen[0];
    expect(f.erledigt).toBe('2026-10-27');
    expect(f.vorschlagFolge.termin).toBe('2026-11-10');
    expect(a.geschrieben.filter(x => /audit_log/.test(x.sql)).length).toBe(1);
    // erledigte Frist erscheint nicht mehr im Briefing, auch nicht überfällig
    expect(leseSekretariatFristen('2026-10-30', datei).length).toBe(1); // nur die ungeprüfte zweite
  });

  test('Fehlalarme aus dem Review: Weiterleitung, eigene Adresse, ein kurzes Wort, Zitat', async () => {
    const frist = { ...EKO_FRIST, notes: 'Werte an data@bikolino.com; abrechnung@ekonzept.eu' };
    const pruefe = async (mail: GesendeteMail, eigen: string, fr = frist) => (await fristAbgleich({ query: attrappe([fr]).query,
      holeGesendet: async () => [mail], holeText: async () => eigen, probe: true })).erledigt.length;
    expect(await pruefe({ ...EKO_MAIL, betreff: 'WG: Jahresabrechnung' }, 'Jahresabrechnungen anbei')).toBe(0);
    expect(await pruefe({ ...EKO_MAIL, an: ['data@bikolino.com'] }, 'Jahresabrechnungen anbei')).toBe(0);
    expect(await pruefe({ ...EKO_MAIL, betreff: 'AW: Jahresabrechnung 2025' }, 'Danke!')).toBe(0);
    const schluessel = { ...EKO_FRIST, bezeichnung: 'hausverwaltung: Schlüssel Marktgasse anfordern', notes: 'info@hv-beispiel.de' };
    expect(await pruefe({ ...EKO_MAIL, an: ['info@hv-beispiel.de'], betreff: 'Marktgasse' }, 'Rechnung anbei', schluessel)).toBe(0);
    expect(await pruefe({ ...EKO_MAIL, an: ['info@hv-beispiel.de'], betreff: 'Marktgasse' }, 'Bitte zweiten Schlüssel senden', schluessel)).toBe(1);
  });

  test('wartende Fristen werden nie geprüft', () => {
    for (const t of ['Erinnerung Wartung', 'X: Unterlagen zusenden', 'Rückmeldung Maurer', 'Bestätigung von SWT', 'Lieferung Hailo erwartet'])
      expect(verlangtMail(t)).toBe(false);
  });
});

describe('Briefing: veraltet und erledigt', () => {
  test('über 14 Tage überfällig und unbearbeitet → Sammelzeile statt rot', () => {
    const z = nkFristZeilen([
      { objekt: 'N24', bezeichnung: 'alt', termin: '2026-10-01', tage: -29, veraltet: true },
      { objekt: 'N24', bezeichnung: 'auch alt', termin: '2026-10-05', tage: -25, veraltet: true },
      { objekt: 'MG24', bezeichnung: 'frisch', termin: '2026-10-22', tage: -8 },
    ], 30);
    expect(z).toEqual([
      '• MG24 — frisch: überfällig seit 8 Tagen (22.10.) 🔴',
      '• ⚠️ veraltet? 2 (über 14 Tage überfällig, seither nicht bearbeitet)',
    ]);
  });

  test('überfällige Antwort-Frist → Nachfass-Hinweis', () => {
    expect(nkFristZeilen([{ objekt: 'N24', bezeichnung: 'energiekonzept: Antwort auf Mail vom 27.10.', termin: '2026-11-10', tage: -1 }], 30))
      .toEqual(['• N24 — energiekonzept: Antwort auf Mail vom 27.10.: überfällig seit 1 Tag (10.11.) 🔴 → Nachfass vorschlagen']);
  });

  test('Sekretariat-Frist veraltet nur, wenn der Vorgang seit dem Termin nicht bearbeitet wurde', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sek-'));
    const p = path.join(dir, 'vorgaenge.json');
    fs.writeFileSync(p, JSON.stringify({ vorgaenge: [
      { kennung: 'a', objekt: 'privat', status: 'offen', aktualisiert: '2026-10-01T00:00:00Z', fristen: [{ termin: '2026-10-10', was: 'x', vorlaufTage: 3 }] },
      { kennung: 'b', objekt: 'privat', status: 'offen', aktualisiert: '2026-10-29T00:00:00Z', fristen: [{ termin: '2026-10-10', was: 'y', vorlaufTage: 3 }] },
    ] }));
    const l = leseSekretariatFristen('2026-10-30', p);
    expect(l.map(f => [f.bezeichnung, !!f.veraltet])).toEqual([['x', true], ['y', false]]);
  });

  test('Abend: „Fristen heute erledigt“ mit Vorschlag; Ausfall als eigene Zeile', () => {
    const basis = { datumLang: 'x', ccReports: [], termineMorgen: [], fuhrpark: [], nkFristen: [] };
    const t = abendZeilen({ ...basis, fristenErledigt: [{ objekt: 'N24', text: 'energiekonzept: anmahnen', erledigtAm: '2026-10-27', an: 'ekonzept.eu',
      vorschlag: { was: 'Antwort von energiekonzept (Mail vom 27.10.)', termin: '2026-11-10' } }] }).join('\n');
    expect(t).toContain('✅ Fristen heute erledigt');
    expect(t).toContain('• N24 — energiekonzept: anmahnen: erledigt, Mail an ekonzept.eu am 27.10.');
    expect(t).toContain('  Vorschlag Folgefrist: Antwort von energiekonzept (Mail vom 27.10.) bis 10.11.');
    expect(abendZeilen({ ...basis, fristenErledigt: [] }).join('\n')).not.toContain('heute erledigt');
    expect(abendZeilen({ ...basis, fristenErledigt: null }).join('\n')).toContain('⚠️ Fristen-Abgleich nicht abrufbar');
  });
});
