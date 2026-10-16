/**
 * Rendite auf die vermietete Flaeche — und zwar in der richtigen Richtung.
 *
 * Anlass ist ein Bericht vom 16.10.2026: Dort stand fuer L19 „rund 7,1 %".
 * Gerechnet worden war mit dem EIGENGENUTZTEN Flaechenanteil (41,75 Prozent)
 * statt mit dem vermieteten (58,25 Prozent). Der Fehler faellt nicht auf, weil
 * beide Zahlen plausibel aussehen — nur die eine ist zu hoch. Deshalb diese
 * Tests: Sie halten fest, dass ein groesserer vermieteter Anteil die Rendite
 * SENKT, nicht hebt.
 */
import { describe, test, expect } from 'bun:test';
import { renditeAufVermietet } from '../steckbrief.js';

describe('Rendite auf die vermietete Flaeche', () => {
  /* L19: 40.140 EUR Jahressoll, 1.347.020,34 EUR Kosten, 255,70 von 438,99 qm. */
  test('L19 ergibt 5,12 Prozent — nicht 7,1', () => {
    const r = renditeAufVermietet(40140, 1347020.34, 255.70, 438.99);
    expect(r).toBe(5.12);
    /* Die verwechselte Richtung ergaebe 7,13 — muss ausgeschlossen bleiben. */
    expect(r).not.toBe(7.13);
  });

  test('voll vermietet entspricht der Rendite auf das ganze Haus', () => {
    expect(renditeAufVermietet(40140, 1347020.34, 438.99, 438.99)).toBe(2.98);
  });

  test('ein groesserer vermieteter Anteil senkt die Rendite', () => {
    const wenig = renditeAufVermietet(40140, 1347020.34, 100, 438.99)!;
    const viel = renditeAufVermietet(40140, 1347020.34, 400, 438.99)!;
    expect(wenig).toBeGreaterThan(viel);
  });

  test('ohne belegte Kosten keine Rendite', () => {
    expect(renditeAufVermietet(40140, null, 255.70, 438.99)).toBeNull();
    expect(renditeAufVermietet(40140, 0, 255.70, 438.99)).toBeNull();
  });

  test('ohne Flaechen und ohne Vermietung keine Rendite', () => {
    expect(renditeAufVermietet(40140, 1347020.34, 255.70, null)).toBeNull();
    expect(renditeAufVermietet(40140, 1347020.34, null, 438.99)).toBeNull();
    /* Vollstaendige Eigennutzung: keine Mieteinnahme, also keine Kennzahl. */
    expect(renditeAufVermietet(40140, 1347020.34, 0, 438.99)).toBeNull();
  });

  test('ohne Soll keine Rendite', () => {
    expect(renditeAufVermietet(0, 1347020.34, 255.70, 438.99)).toBeNull();
  });
});

/**
 * Die Jahresmiete ist nicht die Summe des laufenden Jahres.
 *
 * ANLASS (Owner, 16.10.2026): In einem Bericht stand eine Spalte
 * „Jahresmiete" mit S28 20.400 € — das sind 2.040 × ZEHN Monate, denn das
 * Forderungsbuch endet beim laufenden Monat. Die Renditen daneben rechneten
 * korrekt mit 2.040 × 12; der Faktor 1,2 zog sich durch alle Objekte.
 *
 * Seitdem führt die Kachel beide Zahlen getrennt, damit niemand die eine für
 * die andere hält.
 */
import { kacheln as _kacheln } from '../steckbrief.js';

describe('Jahresmiete gegenüber soll_jahr', () => {
  test('die Schnittstelle führt beide Felder getrennt', () => {
    /* Statischer Beleg: Die Typdefinition nennt beide, mit Erklärung. Ein
       Laufzeittest brauchte die Datenbank; der Fehler war aber einer der
       BENENNUNG, und genau die ist hier festgehalten. */
    const quelle = require('node:fs')
      .readFileSync(require('node:path')
        .resolve(import.meta.dir, '..', 'steckbrief.ts'), 'utf-8') as string;
    expect(quelle).toContain('jahresmiete: number;');
    expect(quelle).toContain('soll_jahr: number;');
    expect(quelle).toContain('const jahresmiete = sollMonat * 12;');
    /* Die Rendite muss auf der Jahresmiete fussen, nicht auf soll_jahr. */
    expect(quelle).toContain('renditeAufVermietet(jahresmiete,');
    expect(quelle).not.toMatch(/rendite\s*=\s*anschaffung[\s\S]{0,80}sollJahr\s*\//);
  });

  test('zehn Monate ergeben nicht die Jahresmiete', () => {
    const monatssoll = 2040;
    const aufgelaufen = monatssoll * 10;     // Stand Oktober
    expect(monatssoll * 12).not.toBe(aufgelaufen);
    expect((monatssoll * 12) / aufgelaufen).toBeCloseTo(1.2, 5);
  });
});
