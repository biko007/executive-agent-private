import { describe, expect, test } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  kurzAusTitel, kurzGeglaettet, eindeutigeKurz, vergibKurz, loeseFreigabe, freigabeRueckmeldung, KURZ_MAX,
} from '../kurz.js';
import { wendeAn } from '../korrektur.js';
import { verarbeite, ladeSpeicher } from '../lauf.js';
import { telegramZeilen, vorgangZelle } from '../bericht.js';
import { pruefeBewertung } from '../schema.js';
import { STANDARD_REGELN } from '../../mail-register/relevanz.js';
import { STANDARD_DOK_REGELN } from '../../doc-register/relevanz.js';

const V = [
  { kennung: 'v-fa6baea5', kurz: 'S28-Zaehlerstand-SWT', titel: 'S28 SWT Zählerstandmeldung Jahresabrechnung 2026', objekt: 'S28', status: 'offen' },
  { kennung: 'v-b41002f1', kurz: 'Anker-51854-Klimek', titel: 'privat Widerruf Bestellung 51854 Digitale Fotografien', objekt: 'privat', status: 'wartet' },
  { kennung: 'v-098bf7f0', kurz: 'Privat-Abo-DAZN', titel: 'privat DAZN Abo November 2026', objekt: 'privat', status: 'offen' },
  { kennung: 'v-72b6f927', kurz: 'Privat-Abo-Zattoo', titel: 'privat Zattoo Abo November 2026', objekt: 'privat', status: 'offen' },
  { kennung: 'v-852cb880', kurz: 'EnBW-Waermestrom-Vertragsende', titel: 'EnBW Wärmestromvertrag 701015722919', objekt: null, status: 'offen' },
  { kennung: 'v-11111111', titel: 'Alter Vorgang ohne Kurz', objekt: null, status: 'erledigt' },
];

describe('Kurzbezeichnung bilden', () => {
  test('aus Objekt und Titel: Umlaute ausgeschrieben, ohne Leerzeichen, Objekt nicht doppelt', () => {
    expect(kurzAusTitel('N24 Abfallgebührenbescheid 2025 Landratsamt', 'N24')).toBe('N24-Abfallgebuehrenbescheid-2025');
    expect(kurzAusTitel('privat DAZN Abo November 2026', 'privat')).toBe('Privat-DAZN-Abo-November-2026');
    expect(kurzAusTitel('Storz&Bickel Vodafone Kabel-Rechnung (Oktober)', null)).toBe('StorzBickel-Vodafone-Kabel-Rechnung');
  });
  test('höchstens 40 Zeichen, nur an Bindestrichgrenzen gekürzt', () => {
    const k = kurzAusTitel('MG24 Leittechnik Zähler Kaltwasser E0 Umrechnungsfaktor Seriennummern', 'MG24');
    expect(k.length).toBeLessThanOrEqual(KURZ_MAX);
    expect(k).toBe('MG24-Leittechnik-Zaehler-Kaltwasser-E0');
    expect(k).toMatch(/^[A-Za-z0-9]+(-[A-Za-z0-9]+)*$/);
  });
  test('KI-Vorschlag wird geglättet; Unbrauchbares fällt auf den Titel zurück', () => {
    expect(kurzGeglaettet('S28 Zählerstand – SWT')).toBe('S28-Zaehlerstand-SWT');
    expect(kurzGeglaettet('  ')).toBeNull();
    expect(kurzGeglaettet('x')).toBeNull();
    expect(vergibKurz({ titel: 'privat Spotify Abo Oktober 2026', objekt: 'privat' }, null, [])).toBe('Privat-Spotify-Abo-Oktober-2026');
    expect(vergibKurz({ titel: 'egal', objekt: null }, 'Privat-Abo-Spotify', [])).toBe('Privat-Abo-Spotify');
  });
  test('eindeutig: Kollision bekommt -2, -3 – auch bei anderer Schreibweise', () => {
    expect(eindeutigeKurz('Privat-Abo-DAZN', ['privat-abo-dazn'])).toBe('Privat-Abo-DAZN-2');
    expect(eindeutigeKurz('Privat-Abo-DAZN', ['Privat-Abo-DAZN', 'Privat-Abo-DAZN-2'])).toBe('Privat-Abo-DAZN-3');
    expect(eindeutigeKurz('S28-Zählerstand-SWT'.replace('ä', 'ae'), ['S28-Zaehlerstand-SWT'])).toBe('S28-Zaehlerstand-SWT-2');
    const lang = 'A'.repeat(40);
    const k = eindeutigeKurz(lang, [lang]);
    expect(k.length).toBeLessThanOrEqual(KURZ_MAX);
    expect(k.endsWith('-2')).toBe(true);
  });
  test('Schema: kurz der KI ist optional, null bei Fehlen', () => {
    const roh: any = { relevant: true, begruendung: 'x', objekt: 'S28', vorgang: { bestehend: null, titel: 'S28 X' }, art: 'anfrage',
      fakten: {}, erwartet: null, bis: null, vorschlag: 'c', naechsterSchritt: 'y' };
    const a = pruefeBewertung(roh);
    expect(a.ok && a.wert.vorgang.kurz).toBeNull();
    const b = pruefeBewertung({ ...roh, vorgang: { ...roh.vorgang, kurz: 'S28-X-SWT' } });
    expect(b.ok && b.wert.vorgang.kurz).toBe('S28-X-SWT');
  });
});

describe('Freigabe-Parser', () => {
  test('Kurzbezeichnung, tolerant gegen Groß-/Kleinschreibung und Umlaute', () => {
    const r = loeseFreigabe('Freigabe Vorgang s28-zählerstand-swt', V);
    expect(r.treffer.map((t) => t.kennung)).toEqual(['v-fa6baea5']);
    expect(r.unbekannt).toEqual([]);
    expect(loeseFreigabe('freigabe vorgang ENBW-WÄRMESTROM-VERTRAGSENDE', V).treffer[0].kennung).toBe('v-852cb880');
  });
  test('Kennung geht weiterhin; mehrere pro Zeile, gemischt, Doppelte nur einmal', () => {
    const r = loeseFreigabe('Freigabe Vorgang Privat-Abo-DAZN v-fa6baea5 privat-abo-dazn, `Anker-51854-Klimek`', V);
    expect(r.treffer.map((t) => t.kennung)).toEqual(['v-098bf7f0', 'v-fa6baea5', 'v-b41002f1']);
    expect(r.unbekannt).toEqual([]);
  });
  test('mehrere Zeilen aus dem Report (Listenpunkte mit Backticks)', () => {
    const r = loeseFreigabe('- `Freigabe Vorgang Privat-Abo-Zattoo`\n- `Freigabe Vorgang S28-Zaehlerstand-SWT`', V);
    expect(r.treffer.map((t) => t.kurz)).toEqual(['Privat-Abo-Zattoo', 'S28-Zaehlerstand-SWT']);
  });
  test('unbekannt: klare Rückmeldung mit den drei ähnlichsten Vorgängen', () => {
    const r = loeseFreigabe('Freigabe Vorgang Privat-Abo-DAZM', V);
    expect(r.treffer).toEqual([]);
    expect(r.unbekannt).toHaveLength(1);
    expect(r.unbekannt[0].aehnlich).toHaveLength(3);
    expect(r.unbekannt[0].aehnlich[0].kurz).toBe('Privat-Abo-DAZN');
    const text = freigabeRueckmeldung(r).join('\n');
    expect(text).toContain('„Privat-Abo-DAZM" ist kein bekannter Vorgang');
    expect(text).toContain('Privat-Abo-DAZN');
  });
  test('unbekannte Kennung wird nicht still auf einen anderen Vorgang gelegt', () => {
    const r = loeseFreigabe('Freigabe Vorgang v-00000000', V);
    expect(r.treffer).toEqual([]);
    expect(r.unbekannt[0].eingabe).toBe('v-00000000');
  });
  test('Wortsuche über Titel findet den Vorgang unter den Ähnlichen', () => {
    const r = loeseFreigabe('Freigabe Vorgang Klimek', V);
    expect(r.treffer).toEqual([]);
    expect(r.unbekannt[0].aehnlich.map((a) => a.kennung)).toContain('v-b41002f1');
  });
  test('leere Freigabe liefert nichts', () => {
    expect(loeseFreigabe('Freigabe Vorgang', V)).toEqual({ treffer: [], unbekannt: [] });
  });
});

describe('Einbindung', () => {
  const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'kurz-'));
  const bewertung = (titel: string, kurz: string | null) => ({
    relevant: true, begruendung: 'b', objekt: 'S28', vorgang: { bestehend: null, titel, kurz }, art: 'anfrage' as const,
    fakten: { betraege: [], nummern: [], fristen: [], zaehlerstaende: [] }, erwartet: null, bis: null, vorschlag: 'c' as const, naechsterSchritt: 'n',
  });
  const fakeKi = (antworten: any[]): any => {
    let i = 0;
    return async () => ({ text: JSON.stringify(antworten[Math.min(i++, antworten.length - 1)]), tokensEin: 1, tokensAus: 1 });
  };
  const deps = (z: string, antworten: any[]) => ({
    zustand: z, regeln: STANDARD_REGELN, dokRegeln: STANDARD_DOK_REGELN, deckelProStunde: null, jetzt: new Date('2026-11-03T09:00:00Z'),
    kontext: { objekte: [{ kuerzel: 'S28', adresse: 'Schönhalde 28' }], kontakte: [], fristen: [], vorgaben: [] }, ki: fakeKi(antworten),
  });
  const mail = (kennung: string, titel: string) => ({ typ: 'mail' as const, kennung, quelle: 'm365', datum: '2026-11-03T08:00:00Z', titel,
    von: 'zaehler@swt.de', vonName: 'SWT', text: 'Bitte Zählerstand melden.', messageId: `<${kennung}@x>`, threadIds: [], ordner: 'Posteingang', kopf: {} });

  test('neuer Vorgang erhält die KI-Kurzbezeichnung; zweiter mit gleichem Vorschlag wird -2', async () => {
    const z = tmp();
    await verarbeite([mail('m-1', 'Zählerstand'), mail('m-2', 'Zählerstand Garage')],
      deps(z, [bewertung('S28 Zählerstand Haus', 'S28-Zaehlerstand-SWT'), bewertung('S28 Zählerstand Garage', 'S28-Zaehlerstand-SWT')]) as any);
    const s = ladeSpeicher(z);
    expect(s.vorgaenge.map((v) => v.kurz)).toEqual(['S28-Zaehlerstand-SWT', 'S28-Zaehlerstand-SWT-2']);
  });
  test('Telegram-Zeile und Tabellenzelle: Kurzbezeichnung zuerst, Kennung in Klammern am Ende', () => {
    const v: any = { kennung: 'v-fa6baea5', kurz: 'S28-Zaehlerstand-SWT', titel: 'S28 SWT Zählerstand', objekt: 'S28', status: 'offen',
      vorschlag: 'd', naechsterSchritt: 'x', begruendung: 'SWT will Stand', elemente: [], erstellt: '', aktualisiert: '2026-11-03', frist: null };
    expect(vorgangZelle(v)).toBe('**S28-Zaehlerstand-SWT** S28 SWT Zählerstand (`v-fa6baea5`)');
    const t = telegramZeilen({ ergebnis: { vorgaenge: [v], einzeln: [] } as any, elemente: {} });
    expect(t.zeilen[0].startsWith('📁 S28-Zaehlerstand-SWT: ')).toBe(true);
    expect(t.zeilen[0].endsWith('(v-fa6baea5)')).toBe(true);
  });
  test('Korrektur per Kurzbezeichnung; Umbenennen bleibt eindeutig', () => {
    const liste = V.map((x) => ({ ...x }));
    expect(wendeAn(liste, { zeit: '', quelle: 't', art: 'fehler', bezug: [], befund: '', aenderung: { vorgang: 'privat-abo-zattoo', status: 'erledigt' } }, 'z')).toBe(true);
    expect(liste.find((x) => x.kennung === 'v-72b6f927')!.status).toBe('erledigt');
    wendeAn(liste, { zeit: '', quelle: 't', art: 'fehler', bezug: [], befund: '', aenderung: { vorgang: 'v-72b6f927', kurz: 'Privat Abo DAZN' } }, 'z');
    expect(liste.find((x) => x.kennung === 'v-72b6f927')!.kurz).toBe('Privat-Abo-DAZN-2');
  });
});
