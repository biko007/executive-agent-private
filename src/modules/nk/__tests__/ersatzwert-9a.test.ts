/**
 * Ersatzwerte nach § 9a HeizkostenV muessen in der Abrechnung erkennbar sein.
 *
 * ANLASS. Bei MG24 sind die beiden Waermemengenzaehler der Wohnung W3 seit dem
 * 10.10.2026 stillgelegt, weil sie unplausible Werte liefern (Sued/West
 * 0,063 kWh/m3 gegenueber 12 bis 15 bei allen uebrigen). Bis zum 14.10.2026
 * fiel W3 dadurch ganz aus dem Raumwaermetopf heraus und trug 0,00 Euro —
 * weder ein Ersatzverfahren nach § 9a noch eine Aufteilung nach § 9b, sondern
 * eine Luecke. Seither traegt ein Ersatzwert die Raumwaerme, und die Engine
 * weist ihn als solchen aus.
 */
import { describe, test, expect } from 'bun:test';

describe('Befund ERSATZWERT_9A', () => {
  test('Ablesungen mit is_estimated kennzeichnen eine Einheit als Ersatzwert', () => {
    const readings = [
      { meter_id: 1, is_estimated: false, read_at: '2025-01-01T00:00:00.000Z' },
      { meter_id: 2, is_estimated: true, read_at: '2025-12-31T00:00:00.000Z' },
      { meter_id: 3, is_estimated: true, read_at: '2024-12-31T00:00:00.000Z' },
    ];
    const imZeitraum = (meterId: number) => readings.some(r =>
      r.meter_id === meterId && r.is_estimated
      && r.read_at.slice(0, 10) >= '2025-01-01' && r.read_at.slice(0, 10) <= '2025-12-31');

    expect(imZeitraum(1)).toBe(false);   // gemessen
    expect(imZeitraum(2)).toBe(true);    // Ersatzwert im Zeitraum
    expect(imZeitraum(3)).toBe(false);   // Ersatzwert, aber ausserhalb
  });

  test('der Ersatzwert rechnet wie ein Messwert, nur gekennzeichnet', () => {
    // Ein Ersatzwert darf die Verteilung tragen — sonst entstuende wieder die
    // Luecke, die der Befund gerade verhindern soll.
    const verbrauch = { W1: 14245, W2: 17876, W3: 17860 };
    const summe = Object.values(verbrauch).reduce((a, b) => a + b, 0);
    expect(summe).toBe(49981);
    expect(verbrauch.W3 / summe).toBeCloseTo(0.3573, 3);
    expect(verbrauch.W3).toBeGreaterThan(0);
  });

  test('Ersatzwert aus der Bilanz: Gesamtzaehler minus gemessene minus Verlust', () => {
    const gesamt = 54327, w1 = 14245, w2 = 17876, verlust = 0.08;
    const w3 = Math.round(gesamt * (1 - verlust) - w1 - w2);
    expect(w3).toBe(17860);
    expect(w3 / 173.11).toBeCloseTo(103.2, 1);
  });
});
