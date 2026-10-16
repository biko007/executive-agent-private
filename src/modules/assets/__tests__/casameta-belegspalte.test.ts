/**
 * Die Belegspalte des Casameta-Eingabeblatts.
 *
 * ANLASS (Owner, 16.10.2026): Bei den beiden Bestandsbuchungen des
 * Brennstofflagers stand in der Belegspalte `FEHLT`. Falsch ist das nicht —
 * es gibt dort keine Rechnung —, es liest sich aber wie eine Luecke, die im
 * Portal zu schliessen waere.
 *
 * Die Unterscheidung muss ENG sein: Eine echte Rechnung, bei der nur die
 * Nummer fehlt, MUSS weiter `FEHLT` zeigen. Sonst verdeckt die freundlichere
 * Beschriftung einen fehlenden Beleg — und das ist genau das, was die Spalte
 * aufdecken soll.
 */
import { describe, test, expect } from 'bun:test';
import { istBestandsbuchung } from '../casameta.js';

/* Der Bestandssatz von MG24 2025, wie er in
   system_settings.brennstoffbestand steht (Owner-Entscheidung 14.10.2026). */
const MG24_2025 = {
  anfangsbestand: { wert: 2238.52 },
  endbestand: { wert: 1400.16 },
};

describe('Bestandsbuchungen werden erkannt', () => {
  test('der Anfangsbestand', () => {
    expect(istBestandsbuchung({ amount_gross: 2238.52 }, MG24_2025)).toBe(true);
  });

  test('der Endbestand — auch mit negativem Vorzeichen', () => {
    /* Der Endbestand wird als Minusbetrag gebucht: Er mindert den Verbrauch
       des Jahres. */
    expect(istBestandsbuchung({ amount_gross: -1400.16 }, MG24_2025)).toBe(true);
  });

  test('als Zeichenkette aus der Datenbank', () => {
    /* pg liefert numeric als string. */
    expect(istBestandsbuchung({ amount_gross: '2238.52' }, MG24_2025)).toBe(true);
    expect(istBestandsbuchung({ amount_gross: '-1400.16' }, MG24_2025)).toBe(true);
  });

  test('ein Cent Abweichung zaehlt noch dazu, zwei nicht', () => {
    expect(istBestandsbuchung({ amount_gross: 2238.52 }, MG24_2025)).toBe(true);
    expect(istBestandsbuchung({ amount_gross: 2238.53 }, MG24_2025)).toBe(false);
  });
});

describe('Was ausdruecklich KEINE Bestandsbuchung ist', () => {
  test('eine Rechnung mit Nummer, selbst bei gleichem Betrag', () => {
    expect(istBestandsbuchung({ invoice_number: '109505', amount_gross: 2238.52 }, MG24_2025))
      .toBe(false);
  });

  test('eine Rechnung OHNE Nummer bleibt eine Luecke', () => {
    /* Der eigentliche Zweck der Spalte. 1.758,95 ist die Lieferung vom
       15.12.2025 — fehlte dort die Nummer, muesste das auffallen. */
    expect(istBestandsbuchung({ amount_gross: 1758.95 }, MG24_2025)).toBe(false);
  });

  test('ohne Bestandssatz gilt nichts als Bestandsbuchung', () => {
    expect(istBestandsbuchung({ amount_gross: 2238.52 }, null)).toBe(false);
  });

  test('ein leerer oder unbrauchbarer Betrag', () => {
    for (const betrag of [0, null, undefined, '', 'abc', NaN]) {
      expect(istBestandsbuchung({ amount_gross: betrag }, MG24_2025), String(betrag)).toBe(false);
    }
  });

  test('ein Bestandssatz ohne Werte traegt nicht', () => {
    expect(istBestandsbuchung({ amount_gross: 2238.52 }, {})).toBe(false);
    expect(istBestandsbuchung({ amount_gross: 2238.52 },
      { anfangsbestand: { wert: null }, endbestand: { wert: undefined } })).toBe(false);
    /* Ein Bestandswert von 0 darf nicht jede Nullbuchung einfangen. */
    expect(istBestandsbuchung({ amount_gross: 0 }, { anfangsbestand: { wert: 0 } })).toBe(false);
  });
});

describe('statische Guards gegen casameta.ts', () => {
  const quelle = require('node:fs').readFileSync(
    require('node:path').resolve(import.meta.dir, '..', 'casameta.ts'), 'utf-8');

  test('die Belegspalte geht durch belegspalte()', () => {
    expect(quelle).toContain('${belegspalte(k)} |');
    /* Der frühere direkte Weg würde die Unterscheidung umgehen. */
    expect(quelle).not.toContain('${wert(k.invoice_number)} |');
  });

  test('die Beschriftung steht genau einmal im Erzeuger', () => {
    expect((quelle.match(/'Bestandsbuchung'/g) ?? []).length).toBe(1);
  });

  test('die Legende erklaert die Beschriftung', () => {
    expect(quelle).toContain('In der Belegspalte steht `Bestandsbuchung`');
  });
});
