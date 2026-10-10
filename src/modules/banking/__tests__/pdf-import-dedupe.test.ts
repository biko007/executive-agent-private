/**
 * banking/__tests__/pdf-import-dedupe.test.ts — Abgleich beim Nachtragen von
 * Umsätzen aus einem Kontoauszug.
 *
 * Warum diese Tests zwingend sind: Der Abgleich entscheidet, ob ein Umsatz
 * einmal oder zweimal im Bestand landet — und damit, ob eine Nebenkosten-
 * abrechnung eine Rechnung doppelt verteilt. Beide Fehlerrichtungen kosten
 * Geld, in unterschiedliche Richtungen:
 *
 *   - zu lax: derselbe Umsatz liegt zweimal im Bestand, Kosten verdoppeln sich;
 *   - zu streng: ein echter Umsatz gilt als Dublette und fehlt dauerhaft.
 *
 * Der zweite Fall ist der heimtückische, weil er nichts anzeigt. Deshalb prüfen
 * mehrere Fälle unten gezielt, dass gleich hohe Zahlungen NICHT fälschlich
 * zusammenfallen.
 *
 * Ohne Datenbank: `ordneZu` und `herkunftsId` sind reine Funktionen.
 */
import { describe, it, expect } from 'bun:test';
import { ordneZu, herkunftsId, FENSTER_TAGE } from '../import.js';
import type { ImportZeile } from '../import.js';

function zeile(
  booking_date: string, amount: number,
  extra: Partial<ImportZeile> = {},
): ImportZeile {
  return {
    booking_date,
    value_date: extra.value_date ?? booking_date,
    amount,
    counterparty_name: extra.counterparty_name ?? 'Stadtwerke Tuttlingen GmbH',
    reference: extra.reference ?? 'Rechnung 1',
    transaction_code: 'FOLGELASTSCHRIFT',
  };
}

// Der Bestand kommt in der Produktion aus banking_transactions; hier als
// Literal in derselben Form, in der `importiereUmsaetze` ihn übergibt.
function bestand(
  saetze: { d: string; v?: string | null; betrag: number }[],
) {
  return saetze.map((s, i) => ({
    id: i + 1,
    booking_date: s.d,
    value_date: s.v === undefined ? s.d : s.v,
    betrag: s.betrag.toFixed(2),
    belegt: false,
  }));
}

describe('ordneZu — exakter Durchgang', () => {
  it('erkennt gleichen Betrag am gleichen Buchungstag als Dublette', () => {
    const { exakt, fenster } = ordneZu(
      [zeile('2025-03-10', -250.5)],
      bestand([{ d: '2025-03-10', betrag: -250.5 }]),
    );
    expect(exakt.has(0)).toBe(true);
    expect(fenster.size).toBe(0);
  });

  it('lässt einen Umsatz durch, den der Bestand nicht kennt', () => {
    const { exakt, fenster } = ordneZu(
      [zeile('2026-07-15', -83.2)],
      bestand([{ d: '2026-07-15', betrag: -99.0 }]),
    );
    expect(exakt.size).toBe(0);
    expect(fenster.size).toBe(0);
  });

  it('unterscheidet nach Vorzeichen — Gutschrift ist keine Lastschrift', () => {
    const { exakt, fenster } = ordneZu(
      [zeile('2025-07-15', 65.0)],
      bestand([{ d: '2025-07-15', betrag: -65.0 }]),
    );
    expect(exakt.size + fenster.size).toBe(0);
  });

  it('vergleicht Beträge auf den Cent, nicht auf Fließkomma-Gleichheit', () => {
    // 0.1 + 0.2 ist in IEEE-754 nicht 0.3 — der Abgleich darf daran nicht scheitern.
    const { exakt } = ordneZu(
      [zeile('2025-05-02', 0.1 + 0.2)],
      bestand([{ d: '2025-05-02', betrag: 0.3 }]),
    );
    expect(exakt.has(0)).toBe(true);
  });
});

describe('ordneZu — Fenster für verschobene Wertstellung', () => {
  it('erkennt eine Dublette, die FinTS drei Tage früher gebucht hat', () => {
    const { exakt, fenster } = ordneZu(
      [zeile('2026-02-10', -1200.0)],
      bestand([{ d: '2026-02-07', betrag: -1200.0 }]),
    );
    expect(exakt.size).toBe(0);
    expect(fenster.has(0)).toBe(true);
  });

  it('greift auch über das Wertstellungsdatum des Bestandssatzes', () => {
    const { fenster } = ordneZu(
      [zeile('2026-02-10', -1200.0)],
      bestand([{ d: '2026-01-20', v: '2026-02-11', betrag: -1200.0 }]),
    );
    expect(fenster.has(0)).toBe(true);
  });

  it(`lässt ab ${FENSTER_TAGE + 1} Tagen Abstand durch`, () => {
    const { exakt, fenster } = ordneZu(
      [zeile('2026-02-11', -1200.0)],
      bestand([{ d: '2026-02-07', betrag: -1200.0 }]),
    );
    expect(exakt.size + fenster.size).toBe(0);
  });

  it('bevorzugt den exakten Treffer vor dem Fenstertreffer', () => {
    // Zwei Bestandssätze, einer am selben Tag, einer zwei Tage daneben.
    // Die Importzeile darf den exakten belegen, nicht den nahen.
    const b = bestand([
      { d: '2026-04-08', betrag: -500.0 },
      { d: '2026-04-10', betrag: -500.0 },
    ]);
    const { exakt } = ordneZu([zeile('2026-04-10', -500.0)], b);
    expect(exakt.has(0)).toBe(true);
    expect(b[1].belegt).toBe(true);
    expect(b[0].belegt).toBe(false);
  });
});

describe('ordneZu — eineindeutige Zuordnung', () => {
  it('erklärt zwei gleich hohe Zahlungen nicht mit einem einzigen Bestandssatz', () => {
    // Der Kern der Sache: 2.130 Euro Miete liegen im Bestand EINMAL vor, der
    // Auszug führt sie ZWEIMAL (zwei Wohnungen, gleicher Betrag, zwei Tage
    // Abstand). Ohne eineindeutige Zuordnung gälten beide als Dublette und eine
    // echte Mietzahlung fehlte danach dauerhaft im Bestand.
    const zeilen = [
      zeile('2026-08-03', 2130.0, { counterparty_name: 'Mieter A', reference: 'Miete 1' }),
      zeile('2026-08-05', 2130.0, { counterparty_name: 'Mieter B', reference: 'Miete 2' }),
    ];
    const { exakt, fenster } = ordneZu(zeilen, bestand([{ d: '2026-08-03', betrag: 2130.0 }]));
    expect(exakt.has(0)).toBe(true);
    expect(fenster.has(1)).toBe(false);
    expect(exakt.size + fenster.size).toBe(1);
  });

  it('erkennt beide, wenn der Bestand beide kennt', () => {
    const zeilen = [
      zeile('2026-08-03', 2130.0, { reference: 'Miete 1' }),
      zeile('2026-08-05', 2130.0, { reference: 'Miete 2' }),
    ];
    const { exakt, fenster } = ordneZu(zeilen, bestand([
      { d: '2026-08-03', betrag: 2130.0 },
      { d: '2026-08-05', betrag: 2130.0 },
    ]));
    expect(exakt.size).toBe(2);
    expect(fenster.size).toBe(0);
  });

  it('kommt mit leerem Bestand zurecht — alles ist neu', () => {
    const { exakt, fenster } = ordneZu(
      [zeile('2026-09-01', -10.0), zeile('2026-09-02', -20.0)], [],
    );
    expect(exakt.size + fenster.size).toBe(0);
  });
});

describe('herkunftsId', () => {
  it('ist für gleiche Inhalte stabil — ein zweiter Lauf erzeugt dieselbe Kennung', () => {
    const z = zeile('2026-07-01', -42.5);
    expect(herkunftsId(z)).toBe(herkunftsId({ ...z }));
  });

  it('trennt zwei Umsätze desselben Tages nach Verwendungszweck', () => {
    const a = zeile('2026-07-01', -42.5, { reference: 'Rg. 1' });
    const b = zeile('2026-07-01', -42.5, { reference: 'Rg. 2' });
    expect(herkunftsId(a)).not.toBe(herkunftsId(b));
  });

  it('hängt bei inhaltsgleichen Zeilen einen Zähler an', () => {
    const z = zeile('2026-07-01', -42.5);
    expect(herkunftsId(z, 1)).not.toBe(herkunftsId(z, 2));
    expect(herkunftsId(z, 2).endsWith('_2')).toBe(true);
  });

  it('trägt Datum und Betrag erkennbar in der Kennung', () => {
    const id = herkunftsId(zeile('2026-07-01', -42.5));
    expect(id.startsWith('pdf_2026-07-01_-42.50_')).toBe(true);
  });
});
