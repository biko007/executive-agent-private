/**
 * assets/__tests__/expense-rules.test.ts — Regelauswertung für Buchungsvorschläge.
 *
 * Diese Tests sichern die drei Stellen ab, an denen ein Fehler Geld kostet:
 *
 *   1. **Treffer.** Eine zu weite Regel ordnet Kosten dem falschen Objekt zu.
 *      Bei einem Sammelkonto mit acht Objekten ist das der Normalfall, wenn das
 *      Muster nur die Gegenpartei prüft und nicht die Vertragsnummer.
 *   2. **Anteil.** Die Gebäudeversicherung läuft auf „Marktgasse 22 + 24"; MG24
 *      trägt 98,2001 %. Ein Anteil von 1 würde den Mietern des einen Hauses die
 *      Garagen des anderen berechnen.
 *   3. **Leistungszeitraum.** Eine Wasserjahresrechnung für 2025, abgebucht im
 *      März 2026, gehört in die Abrechnung 2025. Nach dem Zahlungszeitpunkt
 *      landete sie in 2026 — und fehlte 2025.
 *
 * Ohne Datenbank: alle geprüften Funktionen sind rein.
 */
import { describe, it, expect } from 'bun:test';
import {
  trifft, leistungszeitraum, anteiligerBetrag, muster, REGELN_START,
  type AusgabenRegel, type UmsatzZeile,
} from '../expense-rules.js';

function umsatz(extra: Partial<UmsatzZeile> = {}): UmsatzZeile {
  return {
    id: 1,
    booking_date: '2026-03-06',
    value_date: '2026-03-06',
    amount: -100,
    counterparty_name: 'Stadtwerke Tuttlingen GmbH',
    reference: '133224 DTAUS Rechnung 307008/Marktgasse 24, 78532 Tuttlingen',
    ...extra,
  };
}

function regel(extra: Partial<AusgabenRegel> = {}): AusgabenRegel {
  return {
    id: 'test',
    property: 'mg24',
    match: { counterparty: 'stadtwerke' },
    cost_category: 'wasser',
    umlagefaehig: true,
    service_period: 'rechnungsmonat',
    anteil: 1,
    sicherheit: 'hoch',
    ...extra,
  };
}

describe('trifft — Grundfälle', () => {
  it('trifft bei passender Gegenpartei', () => {
    expect(trifft(regel(), umsatz())).toBe(true);
  });

  it('ignoriert Groß- und Kleinschreibung', () => {
    expect(trifft(regel({ match: { counterparty: 'STADTWERKE' } }), umsatz())).toBe(true);
  });

  it('nimmt ein vorangestelltes (?i) als Postgres-Schreibweise hin', () => {
    // Die Plan-Beispiele sind in dieser Form notiert. JavaScript kennt sie
    // nicht und würde "(?i)" als Text suchen — dann träfe die Regel nie.
    expect(muster('(?i)stadtwerke').test('Stadtwerke Tuttlingen GmbH')).toBe(true);
    expect(trifft(regel({ match: { counterparty: '(?i)stadtwerke' } }), umsatz())).toBe(true);
  });

  it('trifft NICHT bei Zahlungseingang', () => {
    // Mieteingänge sind keine Kosten. Ohne diese Sperre würde jede Mietzahlung
    // einer Gegenpartei mit passendem Namen eine Kostenbuchung vorschlagen.
    expect(trifft(regel(), umsatz({ amount: 2130 }))).toBe(false);
  });

  it('trifft NICHT, wenn die Vertragsnummer fehlt', () => {
    expect(trifft(
      regel({ match: { counterparty: 'stadtwerke', reference: '307008' } }),
      umsatz({ reference: '133224 DTAUS Rechnung 999999/Leutenbergstr. 19' }),
    )).toBe(false);
  });

  it('trifft NICHT bei abgeschalteter Regel', () => {
    expect(trifft(regel({ aktiv: false }), umsatz())).toBe(false);
  });

  it('trifft NICHT ohne inhaltliches Muster', () => {
    // Eine Regel mit nur Betragsgrenzen würde jeden Zahlungsausgang treffen.
    expect(trifft(regel({ match: { amount_min: 1 } }), umsatz())).toBe(false);
  });
});

describe('trifft — Betrags- und Datumsgrenzen', () => {
  it('grenzt Abschlag und Jahresabrechnung über den Betrag ab', () => {
    const abschlag = regel({ match: { counterparty: 'stadtwerke', amount_max: 499.99 } });
    const jahr = regel({ match: { counterparty: 'stadtwerke', amount_min: 500 } });
    const klein = umsatz({ amount: -21 });
    const gross = umsatz({ amount: -2143.01 });

    expect(trifft(abschlag, klein)).toBe(true);
    expect(trifft(jahr, klein)).toBe(false);
    expect(trifft(abschlag, gross)).toBe(false);
    expect(trifft(jahr, gross)).toBe(true);
  });

  it('erkennt einen Betrag exakt, auch bei Sammelüberweisung ohne Zweck', () => {
    const r = regel({ match: { amount_exact: 1707.61 } });
    expect(trifft(r, umsatz({ amount: -1707.61, reference: '', counterparty_name: '' }))).toBe(true);
    expect(trifft(r, umsatz({ amount: -1707.62, reference: '', counterparty_name: '' }))).toBe(false);
  });

  it('lässt Zahlungen vor dem Betriebsbeginn nicht durch', () => {
    // MG24 wurde am 04.11.2024 schlussabgenommen. Dieselbe Wasserrechnung ist
    // davor Herstellungsaufwand und danach umlagefähige Betriebskosten.
    const r = regel({ match: { counterparty: 'stadtwerke', date_min: '2024-11-05' } });
    expect(trifft(r, umsatz({ booking_date: '2024-08-15' }))).toBe(false);
    expect(trifft(r, umsatz({ booking_date: '2024-11-15' }))).toBe(true);
  });

  it('beachtet eine obere Datumsgrenze', () => {
    const r = regel({ match: { counterparty: 'stadtwerke', date_max: '2025-09-02' } });
    expect(trifft(r, umsatz({ booking_date: '2025-08-01' }))).toBe(true);
    expect(trifft(r, umsatz({ booking_date: '2025-10-01' }))).toBe(false);
  });
});

describe('leistungszeitraum', () => {
  it('rechnungsmonat ergibt den vollen Kalendermonat', () => {
    expect(leistungszeitraum('rechnungsmonat', umsatz({ booking_date: '2026-03-06' })))
      .toEqual({ start: '2026-03-01', ende: '2026-03-31' });
  });

  it('rechnungsmonat trifft auch den Februar im Schaltjahr', () => {
    expect(leistungszeitraum('rechnungsmonat', umsatz({ booking_date: '2024-02-15' })))
      .toEqual({ start: '2024-02-01', ende: '2024-02-29' });
  });

  it('lieferdatum ist der Buchungstag', () => {
    expect(leistungszeitraum('lieferdatum', umsatz({ booking_date: '2026-09-18' })))
      .toEqual({ start: '2026-09-18', ende: '2026-09-18' });
  });

  it('jahresabrechnung liest das Jahr aus dem Verwendungszweck', () => {
    expect(leistungszeitraum('jahresabrechnung', umsatz({
      booking_date: '2026-04-23', reference: 'Abfallgebuehren 2025',
    }))).toEqual({ start: '2025-01-01', ende: '2025-12-31' });
  });

  it('jahresabrechnung nimmt bei Zahlung im ersten Halbjahr das Vorjahr', () => {
    // Die echte SWT-Wasserjahresrechnung: abgebucht 06.03.2026 für 2025.
    expect(leistungszeitraum('jahresabrechnung', umsatz({
      booking_date: '2026-03-06', reference: '133224 DTAUS Rechnung 307008/Marktgasse 24',
    }))).toEqual({ start: '2025-01-01', ende: '2025-12-31' });
  });

  it('jahresabrechnung bleibt im laufenden Jahr, wenn im zweiten Halbjahr gezahlt wird', () => {
    expect(leistungszeitraum('jahresabrechnung', umsatz({
      booking_date: '2026-09-15', reference: 'ohne Jahresangabe',
    }))).toEqual({ start: '2026-01-01', ende: '2026-12-31' });
  });

  it('jahresabrechnung übernimmt keine Jahreszahl aus der Zukunft', () => {
    expect(leistungszeitraum('jahresabrechnung', umsatz({
      booking_date: '2026-02-10', reference: 'Vorauszahlung 2027',
    }))).toEqual({ start: '2025-01-01', ende: '2025-12-31' });
  });

  it('referenzzeitraum liest zwei Datumsangaben aus dem Verwendungszweck', () => {
    // Die echte Versicherungszeile. "bis 01.01.2026" meint das Ende des
    // Versicherungsjahres — der Leistungszeitraum endet am 31.12.2025.
    expect(leistungszeitraum('referenzzeitraum', umsatz({
      booking_date: '2025-02-17',
      reference: 'V-N r.. 130010036764411036 Wohngebaeude Marktgasse 22 + 24 01.01.2025 - 01.01.2026',
    }))).toEqual({ start: '2025-01-01', ende: '2025-12-31' });
  });

  it('referenzzeitraum fällt auf das Kalenderjahr zurück, wenn kein Zeitraum dasteht', () => {
    expect(leistungszeitraum('referenzzeitraum', umsatz({
      booking_date: '2025-02-17', reference: 'ohne Zeitraum',
    }))).toEqual({ start: '2025-01-01', ende: '2025-12-31' });
  });
});

describe('anteiligerBetrag', () => {
  it('macht aus dem Zahlungsausgang einen positiven Kostenbetrag', () => {
    expect(anteiligerBetrag(-2143.01, 1)).toBe(2143.01);
  });

  it('rechnet den Versicherungsanteil auf den Cent', () => {
    // Die beiden Werte stehen so in der Übernahme aus Paket 2 (K1).
    expect(anteiligerBetrag(-4762.88, 0.982)).toBe(4677.15);
    expect(anteiligerBetrag(-4964.1, 0.982)).toBe(4874.75);
  });
});

describe('Startbestand der Regeln', () => {
  it('hat eindeutige Kennungen', () => {
    const ids = REGELN_START.map(r => r.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('nennt zu jeder Regel ein Objekt, eine Kostenart und einen Hinweis', () => {
    for (const r of REGELN_START) {
      expect(r.property.length).toBeGreaterThan(0);
      expect(r.cost_category.length).toBeGreaterThan(0);
      expect((r.hinweis || '').length).toBeGreaterThan(10);
    }
  });

  it('erzeugt für denselben Umsatz höchstens einen Vorschlag je Objekt', () => {
    // Zwei Regeln, die denselben Umsatz treffen, erzeugen zwei Vorschläge für
    // dieselbe Rechnung. Das darf im Startbestand nicht vorkommen.
    const faelle: UmsatzZeile[] = [
      umsatz({ amount: -21, booking_date: '2025-06-16' }),
      umsatz({ amount: -2143.01, booking_date: '2026-03-06' }),
      umsatz({
        amount: -34, booking_date: '2024-08-15',
        reference: '492014 DTAUS Rechnung 328879/Marktgasse 24,78532 Tuttlingen',
      }),
      umsatz({
        amount: -3042.69, booking_date: '2025-03-21',
        reference: '492014 DTAUS Rechnung 328879/Marktgasse 24,78532 Tuttlingen',
      }),
      umsatz({
        amount: -4762.88, booking_date: '2025-02-17',
        counterparty_name: 'Vohrer GmbH & Co. KG.',
        reference: 'V-N r.. 130010036764411036 Wohngebaeude Marktgasse 22 + 24 01.01.2025 - 01.01.2026',
      }),
    ];
    for (const u of faelle) {
      const treffer = REGELN_START.filter(r => trifft(r, u));
      expect(treffer.length).toBeLessThanOrEqual(1);
    }
  });

  it('schlägt die Versicherung des Nachbargebäudes nicht für MG24 vor', () => {
    // Dieselbe Gegenpartei, andere Vertragsnummer: Leutenbergstr. 19.
    const fremd = umsatz({
      amount: -2872.33, booking_date: '2025-02-17',
      counterparty_name: 'Vohrer GmbH & Co. KG.',
      reference: 'V-N r.. 130010036764411035 Wohngebaeude Leutenbergstr. 19,78532 Tu',
    });
    expect(REGELN_START.filter(r => trifft(r, fremd)).length).toBe(0);
  });

  it('schlägt fremde Abfall-Buchungszeichen nicht für MG24 vor', () => {
    const fremd = umsatz({
      amount: -660, booking_date: '2025-04-17',
      counterparty_name: 'Landkreis Tuttlingen',
      reference: '00/0000-00730-48030/001/009/440 Abfallgebuehren 2025',
    });
    expect(REGELN_START.filter(r => trifft(r, fremd)).length).toBe(0);
  });
});
