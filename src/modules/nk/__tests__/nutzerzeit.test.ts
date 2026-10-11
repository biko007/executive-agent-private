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
  grundlageKlartext, stuetzpunkteVon, verbrauchImAbschnitt, anteilAusStuetzpunkten,
  tagPlus,
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

  it('nimmt eine Ablesung sieben Tage daneben noch an', () => {
    /* GEÄNDERT 11.10.2026: vorher drei Tage. Eine Wohnungsübergabe liegt
       üblicherweise einige Tage vor dem Monatsersten, zu dem der Vertrag
       beginnt — bei MG24 W1 sieben (Übergabe 25.01., Mietbeginn 01.02.).
       Das Protokoll dieser Übergabe IST die Zwischenablesung nach
       § 9b Abs. 1; sie zu verwerfen wäre der schlechtere Weg. */
    const uebergabe = [ablesung(7, '2025-03-25', 3000)];
    expect(findeEinzugsstand(7, '2025-04-01', uebergabe)).not.toBeNull();
  });

  it('nimmt eine Ablesung acht Tage daneben nicht mehr an', () => {
    const fern = [ablesung(7, '2025-03-24', 3000)];
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

// ── Stützpunktverfahren ────────────────────────────────────────────────────

describe('Stützpunktverfahren', () => {
  /* Die echten Ablesereihen aus den Fiehn-Monatsberichten. Sie sind der Grund
     für die Nachschärfung: Ab Mai wird gemessen, aufzuteilen bleibt nur die
     Lücke davor. Die Ganzjahresaufteilung verschenkte diese Messung. */

  function reihe(meterId: number, werte: [string, number][]): MeterReadingRow[] {
    return werte.map(([tag, wert], i) => ({
      id: i + 1, meter_id: meterId, value: wert, unit: 'kWh',
      reading_type: 'interim', read_at: `${tag}T12:00:00Z`, is_estimated: false,
    }) as MeterReadingRow);
  }

  it('hängt den hinterlegten Anfangswert als ersten Stützpunkt an', () => {
    const r = reihe(1, [['2025-05-14', 4.17]]);
    const ohne = stuetzpunkteVon(1, r, VON, BIS);
    const mit = stuetzpunkteVon(1, r, VON, BIS, 0);
    expect(ohne).toHaveLength(1);
    expect(mit).toHaveLength(2);
    expect(mit[0]).toEqual({ tag: VON, wert: 0 });
  });

  it('misst zwischen zwei Ablesungen und teilt nur den Schnitt', () => {
    // 100 Einheiten über den Januar; die halbe Zeit ergibt die halbe Menge.
    const punkte = [{ tag: '2025-01-01', wert: 0 }, { tag: '2025-01-31', wert: 100 }];
    expect(verbrauchImAbschnitt(punkte, '2025-01-02', '2025-01-31', 'tage')).toBeCloseTo(100, 6);
    expect(verbrauchImAbschnitt(punkte, '2025-01-17', '2025-01-31', 'tage')).toBeCloseTo(50, 6);
  });

  it('wertet einen Zählerrücksetzer als null statt negativ', () => {
    const punkte = [{ tag: '2025-01-01', wert: 500 }, { tag: '2025-06-30', wert: 0 },
      { tag: '2025-12-31', wert: 200 }];
    const v = verbrauchImAbschnitt(punkte, '2025-01-02', BIS, 'tage');
    expect(v).toBeCloseTo(200, 6);
  });

  it('MG24 W3 Kaltwasser: 96,9 Prozent statt 67,1 nach Zeitanteil', () => {
    /* Der Zähler stand am 14.05. auf 4,17 m³ und bewegte sich bis Ende Juni
       nicht — vor dem Einzug am 01.05. lief praktisch nichts. Der reine
       Zeitanteil hätte dem Mieter ein Drittel seines gemessenen Verbrauchs
       abgenommen. */
    const r = reihe(13, [
      ['2025-05-14', 4.17], ['2025-06-23', 4.17], ['2025-07-31', 18.17],
      ['2025-08-31', 40.95], ['2025-09-30', 62.42], ['2025-10-31', 82.69],
      ['2025-11-30', 101.28], ['2025-12-30', 121.32],
    ]);
    const punkte = stuetzpunkteVon(13, r, VON, BIS, 0);
    const a = anteilAusStuetzpunkten([punkte], '2025-05-01', BIS, VON, BIS, 'tage')!;
    expect(a.anteil).toBeCloseTo(0.969, 3);
    expect(a.stuetzpunkt).toBe('2025-05-14');
    // Fast alles ist gemessen — die geteilte Lücke ist verschwindend klein.
    expect(a.lueckenAnteil).toBeLessThan(0.01);

    const nurZeit = nutzerAnteilZeit({
      lease: vertrag('2025-05-01'), periodStart: VON, periodEnd: BIS })!;
    expect(nurZeit.anteil).toBeCloseTo(0.671, 3);
  });

  it('MG24 W2 Wärme: 49,8 Prozent statt 55 nach Ganzjahres-Gradtagen', () => {
    /* Beide Wärmemengenzähler stehen am 01.01. auf null und haben ihre erste
       echte Ablesung am 31.05. Ab da ist gemessen; geteilt wird nur Januar
       bis Mai. */
    const no = stuetzpunkteVon(1, reihe(1, [
      ['2025-01-01', 0], ['2025-05-31', 7470], ['2025-08-31', 7589],
      ['2025-09-30', 7877], ['2025-10-31', 8489], ['2025-11-30', 9318],
      ['2025-12-31', 10414],
    ]), VON, BIS);
    const sw = stuetzpunkteVon(2, reihe(2, [
      ['2025-01-01', 0], ['2025-05-31', 3924], ['2025-06-25', 4006],
      ['2025-07-31', 4103], ['2025-08-31', 4310], ['2025-09-30', 4775],
      ['2025-10-31', 5567], ['2025-11-30', 6473], ['2025-12-31', 7462],
    ]), VON, BIS);

    const a = anteilAusStuetzpunkten([no, sw], '2025-04-01', BIS, VON, BIS, 'gradtage')!;
    expect(a.anteil).toBeCloseTo(0.498, 3);
    expect(a.stuetzpunkt).toBe('2025-05-31');

    // Ohne Stützpunkte wären es 55 Prozent — der Unterschied ist der Auftrag.
    const ganzjahr = nutzerAnteilWaerme({
      lease: vertrag('2025-04-01'), periodStart: VON, periodEnd: BIS })!;
    expect(ganzjahr.anteil).toBeCloseTo(0.55, 3);
    expect(a.anteil).toBeLessThan(ganzjahr.anteil);
  });

  it('wirkt symmetrisch beim Auszug', () => {
    /* Auszug zum 30.06.: Gemessen bis zur Ablesung am 31.05., danach nur die
       Lücke bis zur nächsten Ablesung anteilig. */
    const punkte = stuetzpunkteVon(1, reihe(1, [
      ['2025-01-01', 0], ['2025-05-31', 500], ['2025-12-31', 1000],
    ]), VON, BIS);
    const a = anteilAusStuetzpunkten([punkte], VON, '2025-06-30', VON, BIS, 'tage')!;
    // 500 gemessen bis 31.05., dazu 30 von 214 Tagen der Lücke Juni–Dezember.
    expect(a.anteil).toBeGreaterThan(0.5);
    expect(a.anteil).toBeLessThan(0.58);
  });

  it('gibt null, wenn es nur einen Stützpunkt gibt', () => {
    const punkte = [{ tag: '2025-05-14', wert: 4.17 }];
    expect(anteilAusStuetzpunkten([punkte], '2025-05-01', BIS, VON, BIS, 'tage')).toBeNull();
  });

  it('gibt null bei Zählerstillstand im ganzen Zeitraum', () => {
    const punkte = [{ tag: VON, wert: 5 }, { tag: BIS, wert: 5 }];
    expect(anteilAusStuetzpunkten([punkte], '2025-05-01', BIS, VON, BIS, 'tage')).toBeNull();
  });

  it('nennt die Stützpunkte als Grundlage, wenn Ablesungen vorliegen', () => {
    const punkte = stuetzpunkteVon(1, reihe(1, [
      ['2025-01-01', 0], ['2025-05-31', 500], ['2025-12-31', 1000],
    ]), VON, BIS);
    const a = nutzerAnteilWaerme({
      lease: vertrag('2025-04-01'), periodStart: VON, periodEnd: BIS, punkte: [punkte] })!;
    expect(a.grundlage).toBe('stuetzpunkte');
    expect(a.stuetzpunkt).toBe('2025-05-31');
  });

  it('entscheidet je Zaehler: gemessener neben geschaetztem', () => {
    /* Der Fall W1 von MG24: Fuer Sued/West liegt der Stand zum Einzug vor,
       fuer Nord/Ost nicht. Bis zum 11.10.2026 galt „alles oder nichts" — die
       vorhandene Messung wurde mitverworfen. Jetzt nimmt jeder Zaehler die
       beste Grundlage, die er hat. */
    const gemessen = {
      punkte: [{ tag: VON, wert: 0 }, { tag: '2025-02-01', wert: 1000 },
        { tag: BIS, wert: 10000 }],
      einzugsstand: { tag: '2025-02-01', wert: 1000 },
    };
    const geschaetzt = {
      punkte: [{ tag: VON, wert: 0 }, { tag: BIS, wert: 10000 }],
      einzugsstand: null,
    };

    const a = anteilAusStuetzpunkten(
      [gemessen, geschaetzt], '2025-02-01', BIS, VON, BIS, 'gradtage')!;
    /* Gemessen: 9.000 von 10.000. Geschaetzt: 83,46 % von 10.000 — der
       Gradtagsnenner beginnt am 2. Januar, weil der Verbrauch des ersten Tages
       bereits im Stand vom 1. Januar steckt. */
    expect(a.anteil).toBeCloseTo((9000 + 8345.77) / 20000, 4);
    expect(a.alleGemessen).toBe(false);
  });

  it('meldet alleGemessen, wenn jeder Zaehler eine Zwischenablesung hat', () => {
    const reihe = (einzug: number) => ({
      punkte: [{ tag: VON, wert: 0 }, { tag: '2025-02-01', wert: einzug },
        { tag: BIS, wert: 10000 }],
      einzugsstand: { tag: '2025-02-01', wert: einzug },
    });
    const a = anteilAusStuetzpunkten(
      [reihe(1000), reihe(2000)], '2025-02-01', BIS, VON, BIS, 'gradtage')!;
    expect(a.alleGemessen).toBe(true);
    expect(a.anteil).toBeCloseTo((9000 + 8000) / 20000, 6);
  });

  it('faellt fuer einen Zaehler mit unplausibler Zwischenablesung auf die Aufteilung zurueck', () => {
    // Einzugsstand ueber dem Endstand — dann zaehlt die Aufteilung.
    const a = anteilAusStuetzpunkten([{
      punkte: [{ tag: VON, wert: 0 }, { tag: BIS, wert: 1000 }],
      einzugsstand: { tag: '2025-02-01', wert: 5000 },
    }], '2025-02-01', BIS, VON, BIS, 'gradtage')!;
    expect(a.alleGemessen).toBe(false);
    expect(a.anteil).toBeCloseTo(0.8346, 3);
  });

  it('nimmt eine blanke Punktliste weiterhin an', () => {
    // Rueckwaertskompatibel: ohne Zwischenablesung bleibt alles wie zuvor.
    const a = anteilAusStuetzpunkten(
      [[{ tag: VON, wert: 0 }, { tag: BIS, wert: 1000 }]],
      '2025-02-01', BIS, VON, BIS, 'gradtage')!;
    expect(a.anteil).toBeCloseTo(0.8346, 3);
  });

  it('tagPlus rechnet über Monats- und Jahresgrenzen', () => {
    expect(tagPlus('2025-01-31', 1)).toBe('2025-02-01');
    expect(tagPlus('2025-12-31', 1)).toBe('2026-01-01');
    expect(tagPlus('2024-02-28', 1)).toBe('2024-02-29');
  });
});
