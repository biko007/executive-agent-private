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
  ordneSammelueberweisungZu, istRechnungsregel,
  type AusgabenRegel, type UmsatzZeile, type Rechnung,
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


// ── Rechnungsabgleich bei Sammelüberweisungen ──────────────────────────────
//
// Der größte Nebenkostenposten von MG24 sind die Pellets, und genau diese
// Rechnungen werden über Sammelüberweisungen bezahlt: Die Bank liefert dort
// weder Gegenpartei noch Verwendungszweck, nur den Buchungsschlüssel
// SAMMELUEBERWEISUNG und bei mehreren Posten „ANZAHL n". Eine Regel auf die
// Gegenpartei kann dort grundsätzlich nicht greifen — ohne diesen Abgleich
// bliebe der Posten dauerhaft ohne Vorschlag.

function sammel(betrag: number, extra: Partial<UmsatzZeile> = {}): UmsatzZeile {
  return {
    id: 1,
    booking_date: '2025-10-09',
    value_date: '2025-10-09',
    amount: -betrag,
    counterparty_name: null,
    reference: null,
    transaction_code: 'SAMMELUEBERWEISUNG',
    ...extra,
  };
}

const KOCH: { regelId: string; rechnung: Rechnung }[] = [
  { regelId: 'mg24-pellets', rechnung: { nr: '101657', betrag: 2173.79, lieferdatum: '2025-03-11' } },
  { regelId: 'mg24-pellets', rechnung: { nr: '106971', betrag: 1502.39, lieferdatum: '2025-09-25' } },
];
const REIZNER: { regelId: string; rechnung: Rechnung }[] = [
  { regelId: 'reizner-rechnungen', rechnung: { betrag: 128.46 } },
];

describe('ordneSammelueberweisungZu', () => {
  it('erklärt eine Zahlung aus einer einzelnen Rechnung', () => {
    const { treffer, mehrdeutig } = ordneSammelueberweisungZu(sammel(2173.79), KOCH);
    expect(mehrdeutig).toBe(false);
    expect(treffer.length).toBe(1);
    expect(treffer[0].rechnung.nr).toBe('101657');
    expect(treffer[0].posten).toBe(1);
  });

  it('erklärt eine Zahlung aus zwei Rechnungen verschiedener Lieferanten', () => {
    // Der echte Fall: 1.630,85 = 1.502,39 Pellets + 128,46 Elektro.
    const { treffer } = ordneSammelueberweisungZu(sammel(1630.85), [...KOCH, ...REIZNER]);
    expect(treffer.length).toBe(2);
    expect(treffer.map(t => t.regelId).sort()).toEqual(['mg24-pellets', 'reizner-rechnungen']);
    expect(treffer.every(t => t.posten === 2)).toBe(true);
    expect(treffer.find(t => t.regelId === 'mg24-pellets')!.rechnung.nr).toBe('106971');
  });

  it('greift nicht, wenn keine Zusammenstellung passt', () => {
    const { treffer, mehrdeutig } = ordneSammelueberweisungZu(sammel(1695.84), [...KOCH, ...REIZNER]);
    expect(treffer.length).toBe(0);
    expect(mehrdeutig).toBe(false);
  });

  it('rät NICHT, wenn zwei Rechnungen denselben Betrag haben', () => {
    // Zwei gleich hohe Rechnungen: Welche bezahlt wurde, ist nicht bestimmbar.
    // Ein geratener Beleg wäre schlimmer als keiner.
    const pool = [
      { regelId: 'a', rechnung: { nr: '1', betrag: 500 } },
      { regelId: 'b', rechnung: { nr: '2', betrag: 500 } },
    ];
    const { treffer, mehrdeutig } = ordneSammelueberweisungZu(sammel(500), pool);
    expect(treffer.length).toBe(0);
    expect(mehrdeutig).toBe(true);
  });

  it('rät NICHT, wenn mehrere Paare denselben Betrag ergeben', () => {
    const pool = [
      { regelId: 'a', rechnung: { nr: '1', betrag: 100 } },
      { regelId: 'b', rechnung: { nr: '2', betrag: 200 } },
      { regelId: 'c', rechnung: { nr: '3', betrag: 120 } },
      { regelId: 'd', rechnung: { nr: '4', betrag: 180 } },
    ];
    const { treffer, mehrdeutig } = ordneSammelueberweisungZu(sammel(300), pool);
    expect(treffer.length).toBe(0);
    expect(mehrdeutig).toBe(true);
  });

  it('greift nur bei Sammelüberweisungen', () => {
    // Eine normale Lastschrift über denselben Betrag darf NICHT über den
    // Rechnungsabgleich laufen — dafür sind die Musterregeln da.
    const { treffer } = ordneSammelueberweisungZu(
      sammel(2173.79, { transaction_code: 'FOLGELASTSCHRIFT' }), KOCH);
    expect(treffer.length).toBe(0);
  });

  it('greift nicht bei einem Zahlungseingang', () => {
    const { treffer } = ordneSammelueberweisungZu(
      { ...sammel(2173.79), amount: 2173.79 }, KOCH);
    expect(treffer.length).toBe(0);
  });

  it('kommt mit leerem Rechnungspool zurecht', () => {
    const { treffer, mehrdeutig } = ordneSammelueberweisungZu(sammel(2173.79), []);
    expect(treffer.length).toBe(0);
    expect(mehrdeutig).toBe(false);
  });

  it('vergleicht auf den Cent', () => {
    const { treffer } = ordneSammelueberweisungZu(sammel(2173.78), KOCH);
    expect(treffer.length).toBe(0);
  });
});

describe('Rechnungsregeln im Startbestand', () => {
  it('erkennt die Pelletregel als Rechnungsregel', () => {
    const pellets = REGELN_START.find(r => r.id === 'mg24-pellets')!;
    expect(istRechnungsregel(pellets)).toBe(true);
    expect((pellets.rechnungen || []).length).toBeGreaterThanOrEqual(5);
  });

  it('lässt Rechnungsregeln nicht über den Musterabgleich laufen', () => {
    // Sonst träfe eine Rechnungsregel mit leerem match jeden Zahlungsausgang.
    for (const r of REGELN_START.filter(istRechnungsregel)) {
      expect(trifft(r, sammel(2173.79))).toBe(false);
    }
  });

  it('erklärt die fünf bekannten Pelletzahlungen', () => {
    const pool = REGELN_START.filter(istRechnungsregel)
      .flatMap(r => (r.rechnungen || []).map(rg => ({ regelId: r.id, rechnung: rg })));
    // Die echten Zahlbeträge der Sammelüberweisungen aus dem Bestand.
    const zahlungen = [2173.79, 1630.85, 1758.95, 1844.98, 1707.61];
    for (const z of zahlungen) {
      const { treffer } = ordneSammelueberweisungZu(sammel(z), pool);
      expect(treffer.length).toBeGreaterThanOrEqual(1);
    }
  });

  it('trägt bei jedem Pellet-Treffer das Lieferdatum, nicht den Zahltag', () => {
    const pool = REGELN_START.filter(istRechnungsregel)
      .flatMap(r => (r.rechnungen || []).map(rg => ({ regelId: r.id, rechnung: rg })));
    const { treffer } = ordneSammelueberweisungZu(
      sammel(1758.95, { booking_date: '2025-12-18' }), pool);
    const pellet = treffer.find(t => t.regelId === 'mg24-pellets')!;
    expect(pellet.rechnung.lieferdatum).toBe('2025-12-15');
    expect(leistungszeitraum('lieferdatum', { ...sammel(0), booking_date: pellet.rechnung.lieferdatum! }))
      .toEqual({ start: '2025-12-15', ende: '2025-12-15' });
  });
});

describe('Nachtrag 10.10.2026 — korrigierte Einstufungen', () => {
  it('ordnet SWT 387849 der Wasserversorgung zu und hält sie umlagefähig', () => {
    const r = REGELN_START.find(x => x.id === 'mg24-swt-387849')!;
    expect(r.cost_category).toBe('wasser');
    expect(r.umlagefaehig).toBe(true);
    expect(r.service_period).toBe('rechnungsmonat');
  });

  it('hat eine Gegenstückregel für den Abwasservertrag 387847', () => {
    const r = REGELN_START.find(x => x.id === 'mg24-swt-387847-abwasser')!;
    expect(r.cost_category).toBe('entwaesserung');
    expect(r.umlagefaehig).toBe(true);
  });

  it('führt Energiekonzept als Mieterstrom-Abrechnungsdienst und nicht umlagefähig', () => {
    expect(REGELN_START.find(x => x.id === 'mg24-energiekonzept-waerme')).toBeUndefined();
    const r = REGELN_START.find(x => x.id === 'mg24-energiekonzept-mieterstrom-abrechnungsdienst')!;
    expect(r.cost_category).toBe('sonstige_betrkv');
    expect(r.umlagefaehig).toBe(false);
  });

  it('trennt die Wasserverträge 307008 und 387849 sauber', () => {
    // Beide sind Wasser, aber verschiedene Verträge — ein Umsatz darf nie
    // beide treffen, sonst entstehen zwei Vorschläge für eine Zahlung.
    const u = umsatz({ amount: -9, reference: '133224 DTAUS Rechnung 387849/Marktgasse 24' });
    expect(REGELN_START.filter(r => trifft(r, u)).length).toBe(1);
  });
});


describe('Korrektur 11.10.2026 — Reizner und die vierte Pelletlieferung', () => {
  const pool = () => REGELN_START.filter(istRechnungsregel)
    .flatMap(r => (r.rechnungen || []).map(rg => ({ regelId: r.id, rechnung: rg })));

  it('führt die Reizner-Rechnung 178-2025 unter MG24 und nicht umlagefähig', () => {
    // Belegt in Paket 1 C2 und Paket 2 K7: "Netzwerkanschluss Heizung" für MG24,
    // einmalige Herstellung. Zuvor stand die Regel auf N24.
    const r = REGELN_START.find(x => x.id === 'reizner-rechnungen')!;
    expect(r.property).toBe('mg24');
    expect(r.cost_category).toBe('heizung');
    expect(r.umlagefaehig).toBe(false);
    expect(r.rechnungen!.map(x => x.nr)).toEqual(['178-2025']);
  });

  it('trägt die N24-Reizner-Rechnungen NICHT in die MG24-Liste ein', () => {
    const r = REGELN_START.find(x => x.id === 'reizner-rechnungen')!;
    const betraege = r.rechnungen!.map(x => x.betrag);
    expect(betraege).not.toContain(161.78);
    expect(betraege).not.toContain(174.87);
  });

  it('löst die Sammelüberweisung vom 09.10.2025 in beide Belege auf', () => {
    const { treffer } = ordneSammelueberweisungZu(sammel(1630.85), pool());
    expect(treffer.length).toBe(2);
    const nummern = treffer.map(x => x.rechnung.nr).sort();
    expect(nummern).toEqual(['106971', '178-2025']);
  });

  it('erklärt die Zahlung vom 03.01.2025 aus der Lieferung vom 20.12.2024', () => {
    const { treffer } = ordneSammelueberweisungZu(
      sammel(1695.84, { booking_date: '2025-01-03' }), pool());
    expect(treffer.length).toBe(1);
    expect(treffer[0].rechnung.nr).toBe('910222');
    expect(treffer[0].rechnung.lieferdatum).toBe('2024-12-20');
  });

  it('hält die vierte Lieferung aus dem Abrechnungsjahr 2025 heraus', () => {
    // Leistungsprinzip: Lieferung 20.12.2024 gehört in 2024, auch wenn die
    // Pellets erst 2025 verbrannt wurden.
    const z = leistungszeitraum('lieferdatum', { ...sammel(0), booking_date: '2024-12-20' });
    expect(z.start < '2025-01-01').toBe(true);
    expect(z.ende < '2025-01-01').toBe(true);
  });

  it('rechnet die Abrechnung 2025 mit drei Lieferungen', () => {
    const koch = REGELN_START.find(x => x.id === 'mg24-pellets')!;
    const in2025 = koch.rechnungen!.filter(
      r => r.lieferdatum! >= '2025-01-01' && r.lieferdatum! <= '2025-12-31');
    expect(in2025.length).toBe(3);
    expect(in2025.reduce((n, r) => n + r.betrag, 0)).toBeCloseTo(5435.13, 2);
  });
});
