/**
 * nk/__tests__/waermezaehler-anfangsstand.test.ts — Sperre ohne Anfangsstand.
 *
 * HINTERGRUND (11.10.2026). Fehlt einem Wärmemengenzähler der Stand zum
 * Periodenbeginn, rechnet `calculateConsumption()` mit null und weist den
 * GESAMTEN Zählerstand als Verbrauch des Zeitraums aus. Bei MG24 betrifft das
 * vier Wohnungszähler und zwei Objektzähler: Estrichtrocknung, Bauheizung und
 * Leerstand nach der Sanierung lägen damit beim Mieter.
 *
 * Ein Hinweis reicht dafür nicht — die Zahl sieht aus wie gemessen. Deshalb
 * eine Sperre. Diese Tests sichern die Grenzfälle ab: Wann greift sie, und
 * wann darf sie gerade NICHT greifen, weil der Startpunkt belegt ist.
 *
 * Ohne Datenbank: `waermezaehlerOhneAnfangsstand()` ist eine reine Funktion.
 */
import { describe, it, expect } from 'bun:test';
import { waermezaehlerOhneAnfangsstand } from '../precheck.js';

const JAHR = 2025;

function zaehler(
  id: number, medium = 'heat',
  opts: { installed_at?: string | null; initial_reading?: number | null } = {},
) {
  return {
    id, medium, meter_number: `MG24-Z${id}`,
    installed_at: opts.installed_at ?? null,
    initial_reading: opts.initial_reading ?? null,
  };
}

function ablesung(meterId: number, tag: string) {
  return { meter_id: meterId, read_at: `${tag}T12:00:00Z` };
}

describe('waermezaehlerOhneAnfangsstand', () => {
  it('sperrt einen Wärmezähler ohne jeden Stand vor Periodenbeginn', () => {
    const w = waermezaehlerOhneAnfangsstand([zaehler(1)], [ablesung(1, '2025-05-31')], JAHR);
    expect(w).toHaveLength(1);
    expect(w[0].code).toBe('HEAT_METER_NO_DOCUMENTED_START');
    expect(w[0].severity).toBe('blocker');
    expect(w[0].message).toContain('MG24-Z1');
  });

  it('sperrt nicht, wenn eine Ablesung aus dem Dezember davor vorliegt', () => {
    const w = waermezaehlerOhneAnfangsstand([zaehler(1)], [ablesung(1, '2024-12-31')], JAHR);
    expect(w).toHaveLength(0);
  });

  it('sperrt nicht bei einer Ablesung genau am Periodenbeginn', () => {
    /* Grenzfall: Der 1. Januar 00:00 ist der Beginn. Eine Ablesung an diesem
       Tag ist der Anfangsstand und kein fehlender. */
    const w = waermezaehlerOhneAnfangsstand(
      [zaehler(1)], [{ meter_id: 1, read_at: '2025-01-01T00:00:00Z' }], JAHR);
    expect(w).toHaveLength(0);
  });

  it('sperrt einen im Zeitraum eingebauten Zähler NICHT, wenn ein Anfangswert hinterlegt ist', () => {
    const w = waermezaehlerOhneAnfangsstand(
      [zaehler(1, 'heat', { installed_at: '2025-03-01', initial_reading: 0 })],
      [ablesung(1, '2025-12-31')], JAHR);
    expect(w).toHaveLength(0);
  });

  it('sperrt einen im Zeitraum eingebauten Zähler OHNE Anfangswert', () => {
    const w = waermezaehlerOhneAnfangsstand(
      [zaehler(1, 'heat', { installed_at: '2025-03-01' })],
      [ablesung(1, '2025-12-31')], JAHR);
    expect(w).toHaveLength(1);
  });

  it('hilft ein Anfangswert nicht, wenn der Zähler VOR dem Zeitraum eingebaut wurde', () => {
    /* Der entscheidende Fall bei MG24: Die Zähler tragen den Einbau im
       Oktober 2024. Ihr Anfangswert von damals sagt nichts über den Stand am
       1. Januar 2025 — dazwischen liegen Bauheizung und Leerstand. */
    const w = waermezaehlerOhneAnfangsstand(
      [zaehler(1, 'heat', { installed_at: '2024-10-15', initial_reading: 0 })],
      [ablesung(1, '2025-05-31')], JAHR);
    expect(w).toHaveLength(1);
  });

  it('lässt Wasser- und Stromzähler unberührt', () => {
    const w = waermezaehlerOhneAnfangsstand(
      [zaehler(1, 'cold_water'), zaehler(2, 'warm_water'), zaehler(3, 'electricity')],
      [], JAHR);
    expect(w).toHaveLength(0);
  });

  it('nennt jeden betroffenen Zähler einzeln', () => {
    const w = waermezaehlerOhneAnfangsstand(
      [zaehler(1), zaehler(2), zaehler(3)], [], JAHR);
    expect(w).toHaveLength(3);
    expect(w.map(x => x.details?.meter_number)).toEqual(['MG24-Z1', 'MG24-Z2', 'MG24-Z3']);
  });

  it('meldet nichts bei leerer Zählerliste', () => {
    expect(waermezaehlerOhneAnfangsstand([], [], JAHR)).toHaveLength(0);
  });

  it('bezieht die Ablesung eines ANDEREN Zählers nicht ein', () => {
    /* Gegenprobe: Der Stand von Zähler 2 darf Zähler 1 nicht entlasten. */
    const w = waermezaehlerOhneAnfangsstand(
      [zaehler(1), zaehler(2)], [ablesung(2, '2024-12-31')], JAHR);
    expect(w.map(x => x.details?.meter_number)).toEqual(['MG24-Z1']);
  });
});
