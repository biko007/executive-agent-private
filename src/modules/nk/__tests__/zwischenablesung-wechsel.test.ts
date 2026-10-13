/**
 * nk/__tests__/zwischenablesung-wechsel.test.ts — Zwischenablesung am Nutzerwechsel.
 *
 * HINTERGRUND (12.10.2026). Die Vorprüfung verlangte bisher irgendeine Ablesung
 * vom Typ `move_out` an den Zählern der Wohnung — ohne Datum und am falschen
 * Tag orientiert:
 *
 *   - Eine Ablesung vom Februar erfüllte die Regel für einen Auszug im November.
 *
 * ÄNDERUNG 13.10.2026 (Owner-Entscheidung „Verbrauch nach Protokoll, Umlage
 * nach Vertrag"). Am 12.10. stand hier das Vertragsende als maßgeblicher Tag.
 * Geschnitten wird aber der VERBRAUCH, und der endet mit der Übergabe: Wer
 * ausgezogen ist, verbraucht nichts mehr. Maßgeblich ist deshalb
 * `actual_move_out`, ersatzweise `end_date` — dieselbe Reihenfolge wie in
 * `nutzungsAbschnitt()`. Bei N24 W6 liegen die beiden gut einen Monat
 * auseinander (Übergabe 27.10.2025, Vertragsende 30.11.2025).
 *
 * Ohne Datenbank — `zwischenablesungFehlt()` ist eine reine Funktion.
 */
import { describe, it, expect } from 'bun:test';
import { zwischenablesungFehlt, WECHSEL_TOLERANZ_TAGE } from '../precheck.js';

function vertrag(opts: {
  id?: number; unit_id?: number; end_date?: string | null; actual_move_out?: string | null;
}) {
  return {
    id: opts.id ?? 1,
    lease_number: 'test',
    unit_id: opts.unit_id ?? 10,
    unit_code: 'W6',
    end_date: opts.end_date ?? null,
    actual_move_out: opts.actual_move_out ?? null,
  };
}

const ZAEHLER = [{ id: 100, unit_id: 10, meter_number: 'N24-W6-KW' }];

function ablesung(tag: string, meterId = 100) {
  return { meter_id: meterId, read_at: `${tag}T12:00:00Z` };
}

describe('zwischenablesungFehlt', () => {
  it('verlangt die Ablesung am ÜBERGABETAG, nicht am Vertragsende', () => {
    /* Der Fall N24 W6: Übergabe 27.10.2025, Vertragsende 30.11.2025. Eine
       Ablesung zum Vertragsende erfüllt die Regel NICHT — der Verbrauch ist
       einen Monat früher geschnitten. */
    const f = zwischenablesungFehlt(
      [vertrag({ end_date: '2025-11-30', actual_move_out: '2025-10-27' })],
      ZAEHLER, [ablesung('2025-11-30')]);
    expect(f).toHaveLength(1);
    expect(f[0].code).toBe('MISSING_INTERIM_READING_FOR_CHANGEOVER');
    /* Blocker, damit Bereitschaft und Engine dasselbe sagen — die Engine
       stuft den Befund ohnehin unbedingt hoch. */
    expect(f[0].severity).toBe('blocker');
    expect(f[0].details?.wechsel).toBe('2025-10-27');
    expect(f[0].details?.vertragsende).toBe('2025-11-30');
    expect(f[0].message).toContain('Vertrag läuft bis zum 2025-11-30');
  });

  it('ist erfüllt, wenn die Ablesung am Übergabetag liegt', () => {
    const f = zwischenablesungFehlt(
      [vertrag({ end_date: '2025-11-30', actual_move_out: '2025-10-27' })],
      ZAEHLER, [ablesung('2025-10-27')]);
    expect(f).toHaveLength(0);
  });

  it('nimmt eine Ablesung drei Tage daneben an', () => {
    const f = zwischenablesungFehlt(
      [vertrag({ end_date: '2025-11-30' })], ZAEHLER, [ablesung('2025-12-03')]);
    expect(f).toHaveLength(0);
  });

  it('nimmt eine Ablesung vier Tage daneben nicht an', () => {
    const f = zwischenablesungFehlt(
      [vertrag({ end_date: '2025-11-30' })], ZAEHLER, [ablesung('2025-12-04')]);
    expect(f).toHaveLength(1);
  });

  it('lässt eine Ablesung aus einem anderen Monat nicht gelten', () => {
    /* Genau der alte Fehler: Irgendeine Ablesung im Jahr erfüllte die Regel. */
    const f = zwischenablesungFehlt(
      [vertrag({ end_date: '2025-11-30' })], ZAEHLER, [ablesung('2025-02-14')]);
    expect(f).toHaveLength(1);
  });

  it('nimmt das Vertragsende, wenn kein Übergabetag erfasst ist', () => {
    const f = zwischenablesungFehlt(
      [vertrag({ end_date: '2025-11-30', actual_move_out: null })],
      ZAEHLER, [ablesung('2025-11-30')]);
    expect(f).toHaveLength(0);
  });

  it('meldet nichts ohne Vertragsende und ohne Übergabetag', () => {
    const f = zwischenablesungFehlt(
      [vertrag({ end_date: null, actual_move_out: null })], ZAEHLER, []);
    expect(f).toHaveLength(0);
  });

  it('prüft jeden Zähler der Wohnung einzeln', () => {
    const zaehler = [
      { id: 100, unit_id: 10, meter_number: 'N24-W6-KW' },
      { id: 101, unit_id: 10, meter_number: 'N24-W6-WW' },
    ];
    const f = zwischenablesungFehlt(
      [vertrag({ end_date: '2025-11-30' })], zaehler, [ablesung('2025-11-30', 100)]);
    expect(f).toHaveLength(1);
    expect(f[0].details?.meter_number).toBe('N24-W6-WW');
  });

  it('bezieht Zähler anderer Wohnungen nicht ein', () => {
    const fremd = [{ id: 200, unit_id: 99, meter_number: 'N24-W1-KW' }];
    const f = zwischenablesungFehlt([vertrag({ end_date: '2025-11-30' })], fremd, []);
    expect(f).toHaveLength(0);
  });

  it('zählt jede Ablesung, nicht nur eine vom Typ move_out', () => {
    /* Was zählt, ist der Stand an diesem Tag — nicht das Etikett beim
       Erfassen. Die alte Regel verlangte `reading_type = move_out`. */
    const f = zwischenablesungFehlt(
      [vertrag({ end_date: '2025-11-30' })], ZAEHLER,
      [{ meter_id: 100, read_at: '2025-11-30T08:00:00Z' }]);
    expect(f).toHaveLength(0);
  });

  it('hält die Toleranz bei drei Tagen', () => {
    expect(WECHSEL_TOLERANZ_TAGE).toBe(3);
  });

  /* Mieterstrom laeuft ueber einen eigenen Liefervertrag und wird nie zwischen
     Vor- und Nachmieter aufgeteilt. Vor dem 13.10.2026 verlangte die Pruefung
     auch fuer Stromzaehler eine Wechselablesung; das blosse Erfassen der
     N24-Mieterstromzaehler sperrte dadurch die Abrechnung 2025. */
  it('verlangt für Stromzähler keine Wechselablesung', () => {
    const strom = [{ id: 300, unit_id: 10, meter_number: 'N24-W6-STROM', medium: 'electricity' }];
    const f = zwischenablesungFehlt([vertrag({ end_date: '2025-11-30' })], strom, []);
    expect(f).toHaveLength(0);
  });

  it('verlangt sie für Wasser und Wärme weiterhin', () => {
    const gemischt = [
      { id: 300, unit_id: 10, meter_number: 'N24-W6-STROM', medium: 'electricity' },
      { id: 301, unit_id: 10, meter_number: 'N24-W6-KW', medium: 'cold_water' },
      { id: 302, unit_id: 10, meter_number: 'N24-W6-WAERME', medium: 'heat' },
      { id: 303, unit_id: 10, meter_number: 'N24-W6-GAS', medium: 'gas' },
    ];
    const f = zwischenablesungFehlt([vertrag({ end_date: '2025-11-30' })], gemischt, []);
    expect(f.map(x => x.details?.meter_number).sort())
      .toEqual(['N24-W6-GAS', 'N24-W6-KW', 'N24-W6-WAERME']);
  });

  it('prüft Zähler ohne Medienangabe weiterhin', () => {
    /* Ein Zaehler ohne `medium` darf nicht stillschweigend durchrutschen. */
    const f = zwischenablesungFehlt([vertrag({ end_date: '2025-11-30' })], ZAEHLER, []);
    expect(f.length).toBeGreaterThan(0);
  });
});
