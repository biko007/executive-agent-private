/**
 * nk/__tests__/zwischenablesung-wechsel.test.ts — Zwischenablesung am Nutzerwechsel.
 *
 * HINTERGRUND (12.10.2026). Die Vorprüfung verlangte bisher irgendeine Ablesung
 * vom Typ `move_out` an den Zählern der Wohnung — ohne Datum und am falschen
 * Tag orientiert:
 *
 *   - Eine Ablesung vom Februar erfüllte die Regel für einen Auszug im November.
 *   - Maßgeblich war `actual_move_out`, also der Übergabetermin. Für die
 *     Abrechnung zählt aber das VERTRAGSENDE: Bis dahin trägt der Vormieter die
 *     Kosten. Bei N24 W6 liegen die beiden 15 Tage auseinander (Übergabe
 *     15.11.2025, Vertragsende 30.11.2025).
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
  it('verlangt die Ablesung am VERTRAGSENDE, nicht am Übergabetag', () => {
    /* Der Fall N24 W6: Übergabe 15.11.2025, Vertragsende 30.11.2025. Eine
       Ablesung zum Übergabetag erfüllt die Regel NICHT — sie schneidet die
       Abrechnung 15 Tage zu früh. */
    const f = zwischenablesungFehlt(
      [vertrag({ end_date: '2025-11-30', actual_move_out: '2025-11-15' })],
      ZAEHLER, [ablesung('2025-11-15')]);
    expect(f).toHaveLength(1);
    expect(f[0].code).toBe('MISSING_INTERIM_READING_FOR_CHANGEOVER');
    /* Blocker, damit Bereitschaft und Engine dasselbe sagen — die Engine
       stuft den Befund ohnehin unbedingt hoch. */
    expect(f[0].severity).toBe('blocker');
    expect(f[0].details?.wechsel).toBe('2025-11-30');
    expect(f[0].details?.uebergabe).toBe('2025-11-15');
    expect(f[0].message).toContain('Wohnungsübergabe war am 2025-11-15');
  });

  it('ist erfüllt, wenn die Ablesung am Vertragsende liegt', () => {
    const f = zwischenablesungFehlt(
      [vertrag({ end_date: '2025-11-30', actual_move_out: '2025-11-15' })],
      ZAEHLER, [ablesung('2025-11-30')]);
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

  it('nimmt den Übergabetag, wenn kein Vertragsende erfasst ist', () => {
    const f = zwischenablesungFehlt(
      [vertrag({ end_date: null, actual_move_out: '2025-11-15' })],
      ZAEHLER, [ablesung('2025-11-15')]);
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
});
