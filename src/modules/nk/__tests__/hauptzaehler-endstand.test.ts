/**
 * nk/__tests__/hauptzaehler-endstand.test.ts — Hauptzähler ohne Jahresendstand.
 *
 * HINTERGRUND (12.10.2026). Der Hauptzähler am Hausanschluss ist der NENNER
 * der Verbrauchsverteilung. Fehlt sein Stand zum Periodenende, gibt
 * `calculateConsumption()` null zurück, und die Engine verteilt den vollen
 * Rechnungsbetrag nach den Wohnungszählern — die ungemessene Differenz tragen
 * dann die Mieter. Genau dieser Fehler wurde bei MG24 am 11.10.2026 behoben;
 * über einen fehlenden Stand käme er still zurück.
 *
 * Bei N24 fehlt für 2025 der Stand des Gemeindewasserzählers (Nenner für
 * Wasser) und der des Gesamt-Wärmezählers (nur Abgleich).
 *
 * Ohne Datenbank — `hauptzaehlerOhneEndstand()` ist eine reine Funktion.
 */
import { describe, it, expect } from 'bun:test';
import { hauptzaehlerOhneEndstand } from '../precheck.js';

const HAUPT_WASSER = { id: 1, meter_number: 'N24-LS01-GEMEINDEWASSER', medium: 'cold_water', is_main_meter: true, unit_id: null };
const HAUPT_WAERME = { id: 2, meter_number: 'N24-LS02-WMZ-GESAMT', medium: 'heat', is_main_meter: true, unit_id: null };
const WOHNUNGSZAEHLER = { id: 3, meter_number: '02156411', medium: 'cold_water', is_main_meter: false, unit_id: 27 };

const WASSER_IST_NENNER = new Set(['cold_water', 'warm_water']);
const KEIN_NENNER = new Set<string>();

function stand(meterId: number, tag: string) {
  return { meter_id: meterId, read_at: `${tag}T00:00:00Z` };
}

describe('hauptzaehlerOhneEndstand', () => {
  it('meldet den fehlenden Stand als Blocker, wenn das Medium der Nenner ist', () => {
    const f = hauptzaehlerOhneEndstand(
      [HAUPT_WASSER], [stand(1, '2024-12-31')], 2025, WASSER_IST_NENNER);
    expect(f).toHaveLength(1);
    expect(f[0].code).toBe('HAUPTZAEHLER_OHNE_ENDSTAND');
    expect(f[0].severity).toBe('blocker');
    expect(f[0].message).toContain('Nenner');
  });

  it('meldet ihn als Warnung, wenn keine Kostenart nach diesem Medium verteilt', () => {
    /* Der Gesamt-Wärmezähler bei getrennter Messung nach § 9 Abs. 1
       HeizkostenV: Die Verteilung läuft über die Wohnungszähler, der
       Hauptzähler dient dem Abgleich. Ein Blocker würde eine rechenbare
       Abrechnung ohne Nutzen aufhalten. */
    const f = hauptzaehlerOhneEndstand(
      [HAUPT_WAERME], [stand(2, '2024-12-31')], 2025, KEIN_NENNER);
    expect(f).toHaveLength(1);
    expect(f[0].severity).toBe('warning');
    expect(f[0].message).toContain('Abgleich');
  });

  it('ist zufrieden mit einem Stand im Abrechnungszeitraum', () => {
    const f = hauptzaehlerOhneEndstand(
      [HAUPT_WASSER], [stand(1, '2025-12-31')], 2025, WASSER_IST_NENNER);
    expect(f).toHaveLength(0);
  });

  it('lässt einen Stand aus dem Vorjahr nicht als Endstand gelten', () => {
    /* Der eigentliche Fehler: Mit nur dem Vorjahresstand rechnet die Engine
       Anfangs- gegen Endstand und kommt auf null Verbrauch — das sieht in der
       Verteilung wie eine Messung aus. */
    const f = hauptzaehlerOhneEndstand(
      [HAUPT_WASSER], [stand(1, '2024-01-01'), stand(1, '2024-12-31')], 2025, WASSER_IST_NENNER);
    expect(f).toHaveLength(1);
  });

  it('lässt einen Stand aus dem Folgejahr nicht gelten', () => {
    const f = hauptzaehlerOhneEndstand(
      [HAUPT_WASSER], [stand(1, '2026-01-02')], 2025, WASSER_IST_NENNER);
    expect(f).toHaveLength(1);
  });

  it('nimmt einen Stand am 31.12. um 22:50 Uhr an', () => {
    /* So stehen die Stände aus den Monatsberichten bei MG24 in der Datenbank. */
    const f = hauptzaehlerOhneEndstand(
      [HAUPT_WASSER], [{ meter_id: 1, read_at: '2025-12-31T22:50:00Z' }], 2025, WASSER_IST_NENNER);
    expect(f).toHaveLength(0);
  });

  it('prüft Wohnungszähler nicht — dafür gibt es CONSUMPTION_READING_MISSING', () => {
    const f = hauptzaehlerOhneEndstand([WOHNUNGSZAEHLER], [], 2025, WASSER_IST_NENNER);
    expect(f).toHaveLength(0);
  });

  it('prüft jeden Hauptzähler einzeln', () => {
    const f = hauptzaehlerOhneEndstand(
      [HAUPT_WASSER, HAUPT_WAERME], [stand(1, '2025-12-31')], 2025, WASSER_IST_NENNER);
    expect(f).toHaveLength(1);
    expect(f[0].details?.meter_number).toBe('N24-LS02-WMZ-GESAMT');
  });

  it('meldet nichts ohne Hauptzähler', () => {
    expect(hauptzaehlerOhneEndstand([], [], 2025, WASSER_IST_NENNER)).toHaveLength(0);
  });
});

describe('hauptzaehlerOhneEndstand — Abrechnungsmenge des Versorgers', () => {
  it('meldet die Versorgermenge nicht, wenn sie für das Jahr fehlt (kein Gerät)', () => {
    const versorger = {
      id: 9, meter_number: 'N24-LS01-SWT-ABRECHNUNGSMENGE', medium: 'cold_water',
      is_main_meter: true, unit_id: null, submetering_purpose: 'versorger_abrechnung',
    };
    const f = hauptzaehlerOhneEndstand(
      [HAUPT_WASSER, versorger], [stand(1, '2026-12-31'), stand(9, '2025-12-31')], 2026, WASSER_IST_NENNER);
    expect(f).toHaveLength(0);
  });
});
