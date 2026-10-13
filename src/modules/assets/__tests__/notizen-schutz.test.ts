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
import { notizenVorbereiten } from '../routes.js';

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
