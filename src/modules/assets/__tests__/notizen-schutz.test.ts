/**
 * Schutz gegen versehentliches Ueberschreiben von Notizen.
 *
 * ANLASS. Am 13.10.2026 hat ein Skript an vier Zaehlern mehrere tausend Zeichen
 * Vorarbeit geloescht. Es las den Bestand ueber die Liste — die `notes` damals
 * nicht auslieferte —, rechnete deshalb mit leerem Text und schrieb nur den
 * neuen Absatz zurueck. Der Fehler lag nicht im Skript, sondern in einer
 * Schnittstelle, bei der Lesen und Schreiben nicht zusammenpassten.
 *
 * Seither muss ein Aufrufer sagen, was er will: anhaengen oder ersetzen.
 */
import { describe, test, expect } from 'bun:test';
import { notizenVorbereiten, feldUebernehmen } from '../routes.js';

describe('notizenVorbereiten', () => {
  test('ruehrt der Aufruf die Notiz nicht an, passiert nichts', () => {
    const body: any = { meter_number: '123' };
    expect(notizenVorbereiten(body, { notes: 'Bestand' })).toBeNull();
    expect(body.notes).toBeUndefined();
  });

  test('Anhaengen erhaelt den Altbestand', () => {
    const body: any = { append_notes: 'Neuer Absatz' };
    expect(notizenVorbereiten(body, { notes: 'Alter Text' })).toBeNull();
    expect(body.notes).toBe('Alter Text\n\nNeuer Absatz');
    expect(body.append_notes).toBeUndefined();
  });

  test('Anhaengen an eine leere Notiz ergibt nur den Zusatz', () => {
    const body: any = { append_notes: 'Erster Eintrag' };
    expect(notizenVorbereiten(body, { notes: null })).toBeNull();
    expect(body.notes).toBe('Erster Eintrag');
  });

  test('Anhaengen trimmt, ohne den Bestand zu verstuemmeln', () => {
    const body: any = { append_notes: '  Zusatz  ' };
    notizenVorbereiten(body, { notes: '  Bestand\n' });
    expect(body.notes).toBe('Bestand\n\nZusatz');
  });

  test('notes allein wird abgelehnt — genau der Vorfall vom 13.10.2026', () => {
    const body: any = { notes: 'Nur der neue Absatz' };
    const fehler = notizenVorbereiten(body, { notes: 'Jahrelange Vorarbeit' });
    expect(fehler).toContain('replace_notes');
    expect(fehler).toContain('append_notes');
  });

  test('notes mit replace_notes ersetzt ausdruecklich', () => {
    const body: any = { notes: 'Alles neu', replace_notes: true };
    expect(notizenVorbereiten(body, { notes: 'Alt' })).toBeNull();
    expect(body.notes).toBe('Alles neu');
    expect(body.replace_notes).toBeUndefined();
  });

  test('notes auf null loescht nur mit replace_notes', () => {
    const ohne: any = { notes: null };
    expect(notizenVorbereiten(ohne, { notes: 'Alt' })).toContain('replace_notes');
    const mit: any = { notes: null, replace_notes: true };
    expect(notizenVorbereiten(mit, { notes: 'Alt' })).toBeNull();
    expect(mit.notes).toBeNull();
  });

  test('beides zusammen wird abgelehnt', () => {
    const body: any = { notes: 'A', append_notes: 'B' };
    expect(notizenVorbereiten(body, {})).toContain('schliessen einander aus');
  });

  test('leeres append_notes wird abgelehnt', () => {
    expect(notizenVorbereiten({ append_notes: '   ' } as any, {})).toContain('nicht leerer Text');
    expect(notizenVorbereiten({ append_notes: 42 } as any, {})).toContain('nicht leerer Text');
  });
});

describe('feldUebernehmen', () => {
  // Der Upsert fuer property_heating_config traegt die Owner-Entscheidung
  // 0/100 fuer N24 2025 und eine 790 Zeichen lange Begruendung. Ein PUT, der
  // nur das Heizsystem nachtragen will, darf beides nicht mitnehmen.
  const vorher = {
    heating_system: 'heat_pump',
    base_share_percent: '0.00',
    consumption_share_percent: '100.00',
    hot_water_via_heating: true,
    notes: 'Owner-Entscheidung 0/100',
  };

  test('fehlendes Feld behaelt den Bestand', () => {
    const body: any = { year: 2025, heating_system: 'heat_pump' };
    expect(feldUebernehmen(body, vorher, 'base_share_percent')).toBe('0.00');
    expect(feldUebernehmen(body, vorher, 'consumption_share_percent')).toBe('100.00');
    expect(feldUebernehmen(body, vorher, 'notes')).toBe('Owner-Entscheidung 0/100');
  });

  test('angegebenes Feld gewinnt', () => {
    const body: any = { base_share_percent: 30 };
    expect(feldUebernehmen(body, vorher, 'base_share_percent')).toBe(30);
  });

  test('ausdrueckliches null loescht', () => {
    const body: any = { base_share_percent: null };
    expect(feldUebernehmen(body, vorher, 'base_share_percent')).toBeNull();
  });

  test('ohne Bestand greift der Standard', () => {
    expect(feldUebernehmen({}, null, 'hot_water_via_heating', true)).toBe(true);
    expect(feldUebernehmen({}, null, 'base_share_percent')).toBeNull();
  });

  test('false und 0 aus dem Bestand bleiben erhalten', () => {
    const b = { hot_water_via_heating: false, base_share_percent: 0 };
    expect(feldUebernehmen({}, b, 'hot_water_via_heating', true)).toBe(false);
    expect(feldUebernehmen({}, b, 'base_share_percent')).toBe(0);
  });

  test('false und 0 im Aufruf gewinnen gegen den Bestand', () => {
    expect(feldUebernehmen({ hot_water_via_heating: false }, vorher, 'hot_water_via_heating', true)).toBe(false);
  });
});
