/**
 * Grundrissblatt — Flaeche, Beschriftung, Massstab.
 *
 * Der Punkt, auf den es ankommt: Ein Blatt mit der Aufschrift „1:100" muss
 * auch 1:100 sein. Passt die Zeichnung nicht aufs Papier, meldet das die
 * Funktion — stillschweigend verkleinern waere eine Falschangabe.
 */
import { describe, test, expect } from 'bun:test';
import {
  grundrissSvg, polygonFlaeche, schwerpunkt, ausdehnung, BLATT, type Blatt,
} from '../grundriss.js';

const RECHTECK: [number, number][] = [[0, 0], [4, 0], [4, 3], [0, 3]];

const BLATT_MUSTER: Blatt = {
  objekt: 'TEST', adresse: 'Teststraße 1', geschoss: 'Erdgeschoss',
  quelle: 'Einheitentest', stand: '2026-10-16', massstab: 100,
  raeume: [
    { name: 'Wohnen', einheit: 'W1', punkte: RECHTECK },
    { name: 'Flur', einheit: null, punkte: [[4, 0], [6, 0], [6, 3], [4, 3]] },
  ],
};

describe('Grundriss', () => {
  test('Polygonflaeche rechnet richtig', () => {
    expect(polygonFlaeche(RECHTECK)).toBe(12);
    /* Umgekehrter Umlaufsinn ergibt denselben Betrag. */
    expect(polygonFlaeche([...RECHTECK].reverse())).toBe(12);
    /* L-Form: 4x3 minus 2x1 */
    expect(polygonFlaeche([[0, 0], [4, 0], [4, 2], [2, 2], [2, 3], [0, 3]])).toBe(10);
  });
  test('Schwerpunkt liegt in der Mitte des Rechtecks', () => {
    const [x, y] = schwerpunkt(RECHTECK);
    expect(x).toBeCloseTo(2, 6);
    expect(y).toBeCloseTo(1.5, 6);
  });
  test('Ausdehnung umschliesst alle Raeume und Stellplaetze', () => {
    const a = ausdehnung({ ...BLATT_MUSTER,
      stellplaetze: [{ nummer: 'St 1', punkte: [[8, 0], [10, 0], [10, 5], [8, 5]] }] });
    expect(a).toEqual({ x0: 0, y0: 0, x1: 10, y1: 5 });
  });
  test('Blatt traegt Kopf, Legende, Nordpfeil und Massstabsbalken', () => {
    const { svg, warnungen } = grundrissSvg(BLATT_MUSTER);
    expect(warnungen).toEqual([]);
    expect(svg).toContain('TEST · Erdgeschoss');
    expect(svg).toContain('Maßstab 1:100');
    expect(svg).toContain('Teststraße 1');
    expect(svg).toContain('Einheitentest');
    expect(svg).toContain('>N</text>');          // Nordpfeil
    expect(svg).toContain('>5 m</text>');        // Massstabsbalken
    expect(svg).toContain('W1 — 12,00 m²');      // Legende mit Flaeche
    expect(svg).toContain('Gemeinschaftsfläche');
    expect(svg).toContain(`width="${BLATT.breite}mm"`);
  });
  test('ohne Massstab kein Massstabsbalken, dafuer der Hinweis', () => {
    const { svg } = grundrissSvg({ ...BLATT_MUSTER, massstab: null });
    expect(svg).toContain('nicht maßstäblich');
    expect(svg).not.toContain('>5 m</text>');
  });
  test('zu grosse Zeichnung wird gemeldet, nicht stillschweigend verkleinert', () => {
    /* 60 x 40 m passen in 1:100 nicht auf A4 quer. */
    const gross: Blatt = { ...BLATT_MUSTER,
      raeume: [{ name: 'Halle', einheit: 'H1', punkte: [[0, 0], [60, 0], [60, 40], [0, 40]] }] };
    const { warnungen } = grundrissSvg(gross);
    expect(warnungen.length).toBe(1);
    expect(warnungen[0]).toContain('1:100');
  });
  test('Flaechenangabe aus der Quelle wird gegen den Umriss geprueft', () => {
    const falsch: Blatt = { ...BLATT_MUSTER,
      raeume: [{ name: 'Wohnen', einheit: 'W1', flaeche: 20, punkte: RECHTECK }] };
    const { warnungen } = grundrissSvg(falsch);
    expect(warnungen.some(w => w.includes('20,00 m²') && w.includes('12,00 m²'))).toBe(true);
    /* Kleine Abweichungen (Putz, Rundung) bleiben still. */
    const knapp: Blatt = { ...BLATT_MUSTER,
      raeume: [{ name: 'Wohnen', einheit: 'W1', flaeche: 12.3, punkte: RECHTECK }] };
    expect(grundrissSvg(knapp).warnungen).toEqual([]);
  });
});
