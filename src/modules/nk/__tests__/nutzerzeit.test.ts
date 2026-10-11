/**
 * nk/__tests__/nutzerzeit.test.ts — Nutzeranteil bei unterjährigem Mietverhältnis.
 *
 * HINTERGRUND (11.10.2026). Die Engine rechnete den Anteil eines unterjährigen
 * Mietverhältnisses über einen einheitlichen Zeitanteil. Für die Wärme ist das
 * nach § 9b Abs. 3 HeizkostenV falsch: Dort gelten Gradtagszahlen, weil
 * Januar und Juli nicht dasselbe wiegen. Bei MG24 trennt das die Wohnung im
 * 2. OG um 20 Prozentpunkte — 55 % nach Gradtagszahlen gegenüber 75 % nach
 * Zeit.
 *
 * Geprüft werden: die Tabelle selbst, beide Aufteilungen, der Vorrang einer
 * Zwischenablesung und die Grenzfälle an den Rändern des Zeitraums.
 *
 * Ohne Datenbank — alle Funktionen sind rein.
 */
import { describe, it, expect } from 'bun:test';
import {
  GRADTAGSZAHLEN, gradtagszahlProTag, gradtagsSumme, tageZwischen, tageImMonat,
  nutzungsAbschnitt, findeEinzugsstand, nutzerAnteilWaerme, nutzerAnteilZeit,
  grundlageKlartext,
} from '../nutzerzeit.js';
import type { LeaseRow, MeterReadingRow } from '../types.js';

const VON = '2025-01-01';
const BIS = '2025-12-31';

function vertrag(start: string, ende: string | null = null): LeaseRow {
  return { id: 1, unit_id: 1, start_date: start, end_date: ende } as LeaseRow;
}

function ablesung(meterId: number, tag: string, wert: number): MeterReadingRow {
  return {
    id: 1, meter_id: meterId, value: wert, unit: 'kWh',
    reading_type: 'interim', read_at: `${tag}T12:00:00+01:00`, is_estimated: false,
  } as MeterReadingRow;
}

describe('Gradtagszahlentabelle', () => {
  it('summiert sich auf 1000 Promille', () => {
    const summe = GRADTAGSZAHLEN.reduce((s, b) => s + b.promille, 0);
    expect(summe).toBe(1000);
  });

  it('deckt alle zwölf Monate ab', () => {
    const monate = GRADTAGSZAHLEN.flatMap(b => b.monate).sort((a, b) => a - b);
    expect(monate).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
  });

  it('ergibt über ein ganzes Jahr wieder 1000', () => {
    expect(gradtagsSumme(VON, BIS)).toBeCloseTo(1000, 6);
  });

  it('ergibt auch im Schaltjahr 1000', () => {
    // 2024 hat einen 29. Februar — der darf nicht unter den Tisch fallen.
    expect(gradtagsSumme('2024-01-01', '2024-12-31')).toBeCloseTo(1000, 6);
    expect(tageImMonat(2024, 2)).toBe(29);
  });

  it('verteilt den Sommerblock über alle 92 Tage gleich', () => {
    const juni = gradtagszahlProTag(2025, 6);
    const juli = gradtagszahlProTag(2025, 7);
    const august = gradtagszahlProTag(2025, 8);
    expect(juni).toBeCloseTo(juli, 10);
    expect(juli).toBeCloseTo(august, 10);
    expect(gradtagsSumme('2025-06-01', '2025-08-31')).toBeCloseTo(40, 6);
  });

  it('wiegt den Januar schwerer als den Juli', () => {
    expect(gradtagsSumme('2025-01-01', '2025-01-31')).toBeCloseTo(170, 6);
    expect(gradtagsSumme('2025-07-01', '2025-07-31')).toBeLessThan(15);
  });

  it('gibt für einen umgekehrten Zeitraum null zurück', () => {
    expect(gradtagsSumme('2025-06-01', '2025-05-01')).toBe(0);
  });
});

describe('Nutzungsabschnitt', () => {
  it('beschneidet den Mietbeginn auf den Periodenbeginn', () => {
    expect(nutzungsAbschnitt(vertrag('2024-06-01'), VON, BIS)).toEqual({ von: VON, bis: BIS });
  });

  it('nimmt einen Mietbeginn im Zeitraum', () => {
    expect(nutzungsAbschnitt(vertrag('2025-04-01'), VON, BIS)).toEqual({ von: '2025-04-01', bis: BIS });
  });

  it('nimmt ein Mietende im Zeitraum', () => {
    expect(nutzungsAbschnitt(vertrag('2024-01-01', '2025-03-31'), VON, BIS))
      .toEqual({ von: VON, bis: '2025-03-31' });
  });

  it('gibt null für ein Mietverhältnis ausserhalb des Zeitraums', () => {
    expect(nutzungsAbschnitt(vertrag('2026-01-01'), VON, BIS)).toBeNull();
  });
});

describe('nutzerAnteilWaerme — § 9b Abs. 3, Gradtagszahlen', () => {
  it('gibt den vollen Anteil bei durchgehendem Mietverhältnis', () => {
    const a = nutzerAnteilWaerme({ lease: vertrag('2024-01-01'), periodStart: VON, periodEnd: BIS })!;
    expect(a.anteil).toBe(1);
    expect(a.grundlage).toBe('voller_zeitraum');
  });

  it('MG24 W1, Mietbeginn 01.02.: 83 Prozent statt 91,5 nach Zeit', () => {
    const a = nutzerAnteilWaerme({ lease: vertrag('2025-02-01'), periodStart: VON, periodEnd: BIS })!;
    expect(a.anteil).toBeCloseTo(0.83, 4);
    expect(a.grundlage).toBe('gradtagszahlen');
  });

  it('MG24 W2, Mietbeginn 01.04.: 55 Prozent statt 75,3 nach Zeit', () => {
    /* Der Fall, der den Auftrag ausgelöst hat: Januar bis März tragen
       45 Prozent des Jahresheizbedarfs. */
    const a = nutzerAnteilWaerme({ lease: vertrag('2025-04-01'), periodStart: VON, periodEnd: BIS })!;
    expect(a.anteil).toBeCloseTo(0.55, 4);
    const zeit = nutzerAnteilZeit({ lease: vertrag('2025-04-01'), periodStart: VON, periodEnd: BIS })!;
    expect(zeit.anteil).toBeCloseTo(275 / 365, 4);
    expect(a.anteil).toBeLessThan(zeit.anteil);
  });

  it('MG24 W3, Mietbeginn 01.05.: 47 Prozent', () => {
    const a = nutzerAnteilWaerme({ lease: vertrag('2025-05-01'), periodStart: VON, periodEnd: BIS })!;
    expect(a.anteil).toBeCloseTo(0.47, 4);
  });

  it('ein Mietbeginn im Juli trägt fast nichts vom Jahresheizbedarf', () => {
    const a = nutzerAnteilWaerme({ lease: vertrag('2025-07-01'), periodStart: VON, periodEnd: BIS })!;
    expect(a.anteil).toBeLessThan(0.42);
    // Nach Zeit wären es gut 50 Prozent — der Unterschied ist der Punkt.
    const zeit = nutzerAnteilZeit({ lease: vertrag('2025-07-01'), periodStart: VON, periodEnd: BIS })!;
    expect(zeit.anteil).toBeGreaterThan(0.5);
  });

  it('gibt null für ein Mietverhältnis ausserhalb des Zeitraums', () => {
    expect(nutzerAnteilWaerme({ lease: vertrag('2026-05-01'), periodStart: VON, periodEnd: BIS }))
      .toBeNull();
  });
});

describe('Zwischenablesung hat Vorrang', () => {
  const readings = [ablesung(7, '2025-04-01', 3000)];

  it('rechnet aus den Ständen statt aus der Tabelle', () => {
    /* Zähler läuft von 1.000 auf 11.000, beim Einzug stand er auf 3.000:
       Der Nutzer hat 8.000 von 10.000 verbraucht — 80 Prozent. Nach
       Gradtagszahlen wären es 55. */
    const a = nutzerAnteilWaerme({
      lease: vertrag('2025-04-01'), periodStart: VON, periodEnd: BIS,
      einzugsstand: findeEinzugsstand(7, '2025-04-01', readings),
      standAnfang: 1000, standEnde: 11000,
    })!;
    expect(a.grundlage).toBe('zwischenablesung');
    expect(a.anteil).toBeCloseTo(0.8, 6);
  });

  it('nimmt eine Ablesung drei Tage daneben noch an', () => {
    const nah = [ablesung(7, '2025-04-04', 3000)];
    expect(findeEinzugsstand(7, '2025-04-01', nah)).not.toBeNull();
  });

  it('nimmt eine Ablesung vier Tage daneben nicht mehr an', () => {
    const fern = [ablesung(7, '2025-04-05', 3000)];
    expect(findeEinzugsstand(7, '2025-04-01', fern)).toBeNull();
  });

  it('wählt bei mehreren die dem Einzugstag nächste', () => {
    const mehrere = [ablesung(7, '2025-03-30', 2900), ablesung(7, '2025-04-02', 3100)];
    expect(findeEinzugsstand(7, '2025-04-01', mehrere)?.wert).toBe(3100);
  });

  it('fällt auf die Gradtagszahlen zurück, wenn der Zählerlauf null ist', () => {
    const a = nutzerAnteilWaerme({
      lease: vertrag('2025-04-01'), periodStart: VON, periodEnd: BIS,
      einzugsstand: findeEinzugsstand(7, '2025-04-01', readings),
      standAnfang: 5000, standEnde: 5000,
    })!;
    expect(a.grundlage).toBe('gradtagszahlen');
  });

  it('fällt zurück, wenn der Einzugsstand über dem Endstand liegt', () => {
    // Unplausibel — dann lieber aufteilen als einen negativen Anteil rechnen.
    const a = nutzerAnteilWaerme({
      lease: vertrag('2025-04-01'), periodStart: VON, periodEnd: BIS,
      einzugsstand: { tag: '2025-04-01', wert: 20000 },
      standAnfang: 1000, standEnde: 11000,
    })!;
    expect(a.grundlage).toBe('gradtagszahlen');
  });

  it('bezieht die Ablesung eines anderen Zählers nicht ein', () => {
    expect(findeEinzugsstand(8, '2025-04-01', readings)).toBeNull();
  });
});

describe('nutzerAnteilZeit — Warmwasser und Wasser', () => {
  it('rechnet taggenau, nicht monatsweise', () => {
    const a = nutzerAnteilZeit({ lease: vertrag('2025-05-01'), periodStart: VON, periodEnd: BIS })!;
    expect(a.anteil).toBeCloseTo(245 / 365, 10);
    expect(a.grundlage).toBe('zeitanteil');
  });

  it('zählt den Einzugstag mit', () => {
    const a = nutzerAnteilZeit({ lease: vertrag('2025-12-31'), periodStart: VON, periodEnd: BIS })!;
    expect(a.anteil).toBeCloseTo(1 / 365, 10);
  });

  it('tageZwischen zählt beide Ränder', () => {
    expect(tageZwischen('2025-01-01', '2025-01-01')).toBe(1);
    expect(tageZwischen(VON, BIS)).toBe(365);
  });
});

describe('Klartext der Grundlage', () => {
  it('nennt die § 9b-Aufteilung beim Namen', () => {
    expect(grundlageKlartext('gradtagszahlen')).toContain('§ 9b');
    expect(grundlageKlartext('gradtagszahlen')).toContain('Zwischenablesung fehlt');
    expect(grundlageKlartext('zeitanteil')).toContain('Zeitabschnitten');
    expect(grundlageKlartext('zwischenablesung')).toBe('Zwischenablesung zum Einzug');
  });
});
