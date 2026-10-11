/**
 * nk/__tests__/zwischenabrechnung.test.ts — Abrechnung zu einem Stichtag.
 *
 * Eine Zwischenabrechnung rechnet mit demselben Code wie die Jahresabrechnung;
 * verändert ist allein der Zeitraum. Geprüft wird deshalb zweierlei:
 *
 *   1. Die Torwächter (`pruefeZeitraum`). Ein unsinniger Zeitraum ergibt sonst
 *      eine Abrechnung, die plausibel aussieht und falsch ist — und eine
 *      Zwischenabrechnung darf niemals finalisiert werden.
 *   2. Die Anteilsrechnung (`periodizeBookings`). Dass eine Jahresrechnung zum
 *      30.06. zur Hälfte zählt, ist die ganze Rechenlogik der Zwischenabrechnung;
 *      geht sie schief, stimmt jeder Betrag auf dem Blatt nicht.
 *
 * Ohne Datenbank: Beide Funktionen sind rein.
 */
import { describe, it, expect } from 'bun:test';
import { pruefeZeitraum, periodizeBookings } from '../engine.js';
import type { ExpenseBookingRow } from '../types.js';

function buchung(von: string, bis: string, betrag: number): ExpenseBookingRow {
  return {
    id: 1, property_id: 2, cost_category_id: 3, amount_gross: betrag,
    service_period_start: von, service_period_end: bis,
    category_code: 'versicherung',
  } as ExpenseBookingRow;
}

describe('pruefeZeitraum', () => {
  it('lässt einen Zeitraum innerhalb des Jahres zu', () => {
    expect(() => pruefeZeitraum(2025, { von: '2025-01-01', bis: '2025-06-30' }, false)).not.toThrow();
  });

  it('lässt einen einzelnen Tag zu', () => {
    expect(() => pruefeZeitraum(2025, { von: '2025-03-15', bis: '2025-03-15' }, false)).not.toThrow();
  });

  it('verweigert die Finalisierung einer Zwischenabrechnung', () => {
    /* Der wichtigste Fall: Eine Auskunft zum Stichtag darf nie zu einem
       Dokument werden, aus dem eine Forderung folgt. */
    expect(() => pruefeZeitraum(2025, { von: '2025-01-01', bis: '2025-06-30' }, true))
      .toThrow(/nicht finalisiert/);
  });

  it('verweigert einen Beginn nach dem Ende', () => {
    expect(() => pruefeZeitraum(2025, { von: '2025-06-30', bis: '2025-01-01' }, false))
      .toThrow(/nach seinem Ende/);
  });

  it('verweigert einen Zeitraum über den Jahreswechsel', () => {
    expect(() => pruefeZeitraum(2025, { von: '2025-07-01', bis: '2026-06-30' }, false))
      .toThrow(/im Jahr 2025/);
  });

  it('verweigert einen Zeitraum aus einem anderen Jahr', () => {
    expect(() => pruefeZeitraum(2025, { von: '2024-01-01', bis: '2024-06-30' }, false))
      .toThrow(/im Jahr 2025/);
  });

  it('verweigert ein unvollständiges Datum', () => {
    expect(() => pruefeZeitraum(2025, { von: '2025-6-30', bis: '2025-12-31' }, false))
      .toThrow(/JJJJ-MM-TT/);
  });

  it('verweigert einen leeren Wert', () => {
    expect(() => pruefeZeitraum(2025, { von: '', bis: '2025-12-31' }, false))
      .toThrow(/JJJJ-MM-TT/);
  });

  it('verweigert ein nicht existierendes Datum', () => {
    expect(() => pruefeZeitraum(2025, { von: '2025-02-30', bis: '2025-12-31' }, false))
      .toThrow();
  });

  it('nennt die Fehler mit Status 400, nicht als Serverfehler', () => {
    try {
      pruefeZeitraum(2025, { von: '2025-06-30', bis: '2025-01-01' }, false);
      throw new Error('hätte werfen müssen');
    } catch (e: any) {
      expect(e.status).toBe(400);
    }
  });
});

describe('periodizeBookings im verkürzten Zeitraum', () => {
  it('nimmt eine Jahresrechnung zum 30.06. anteilig', () => {
    const [b] = periodizeBookings(
      [buchung('2025-01-01', '2025-12-31', 3650)], '2025-01-01', '2025-06-30');
    // 181 von 365 Tagen
    expect(b.overlap_fraction).toBeCloseTo(181 / 365, 10);
    expect(b.periodized_amount).toBeCloseTo(3650 * 181 / 365, 6);
  });

  it('nimmt eine Rechnung, die ganz im Zeitraum liegt, voll', () => {
    const [b] = periodizeBookings(
      [buchung('2025-02-01', '2025-02-28', 500)], '2025-01-01', '2025-06-30');
    expect(b.overlap_fraction).toBe(1);
    expect(b.periodized_amount).toBe(500);
  });

  it('lässt eine Rechnung nach dem Stichtag vollständig weg', () => {
    const [b] = periodizeBookings(
      [buchung('2025-09-01', '2025-09-30', 900)], '2025-01-01', '2025-06-30');
    expect(b.overlap_fraction).toBe(0);
    expect(b.periodized_amount).toBe(0);
  });

  it('nimmt eine Rechnung, die vor dem Zeitraum beginnt, nur mit dem Überschneidungsteil', () => {
    // Heizperiode Okt 2024 bis Mär 2025, Zeitraum ab 01.01.2025:
    // 90 von 182 Tagen liegen im Zeitraum.
    const [b] = periodizeBookings(
      [buchung('2024-10-01', '2025-03-31', 1820)], '2025-01-01', '2025-06-30');
    expect(b.overlap_fraction).toBeCloseTo(90 / 182, 10);
  });

  it('rechnet den vollen Jahreszeitraum unverändert — die Jahresabrechnung bleibt, wie sie war', () => {
    const [b] = periodizeBookings(
      [buchung('2025-01-01', '2025-12-31', 1200)], '2025-01-01', '2025-12-31');
    expect(b.overlap_fraction).toBe(1);
    expect(b.periodized_amount).toBe(1200);
  });

  it('summiert die Anteile zweier Halbjahresrechnungen zum Ganzen', () => {
    /* Gegenprobe gegen Rundungs- oder Grenzfehler an der Nahtstelle: Zwei
       Rechnungen, die zusammen das Jahr abdecken, müssen im vollen Jahr auch
       zusammen den vollen Betrag ergeben. */
    const bs = periodizeBookings([
      buchung('2025-01-01', '2025-06-30', 600),
      buchung('2025-07-01', '2025-12-31', 600),
    ], '2025-01-01', '2025-12-31');
    expect(bs[0].periodized_amount + bs[1].periodized_amount).toBe(1200);
  });

  it('zählt den Stichtag selbst mit', () => {
    // 01.01. bis 01.01. ist EIN Tag, nicht null.
    const [b] = periodizeBookings(
      [buchung('2025-01-01', '2025-01-01', 10)], '2025-01-01', '2025-01-01');
    expect(b.overlap_fraction).toBe(1);
    expect(b.periodized_amount).toBe(10);
  });
});
