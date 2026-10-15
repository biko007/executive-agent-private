/**
 * Sollstellung und Zahlungszuordnung — die reinen Funktionen.
 *
 * Geprüft wird, was ohne Datenbank entscheidbar ist: der Fälligkeitstag, der
 * Tagesanteil bei Vertragsbeginn und -ende mitten im Monat, die erzeugten
 * Monatszeilen und die Zuordnungsregel. Die Regel ist der heikle Teil — sie
 * darf im Zweifel lieber nichts zuordnen als etwas Falsches.
 */
import { describe, test, expect } from 'bun:test';
import {
  werktag, anteilImMonat, sollZeilen, zuordnen, normal, laufenderMonat, tageImMonat, istKeineMiete,
  monatAusZweck, kontoFuer,
  type VertragSoll, type Zahler, type Zahlung,
} from '../mietforderungen.js';

const BASIS: VertragSoll = {
  id: 1, start_date: '2024-01-01', end_date: null,
  kaltmiete: 1000, nk_vorauszahlung: 200, heizkosten_vorauszahlung: 0,
  garage_amount: 50, kitchen_amount: 0, rent_due_day: null, owner_hauptmieter: false,
};

describe('Fälligkeit: dritter Werktag', () => {
  test('Januar 2025 — 1.1. ist Feiertag, 4./5. ist Wochenende', () => {
    // Do 2.1. (1.), Fr 3.1. (2.), Sa 4.1. (3.)
    expect(werktag(2025, 1, 3)).toBe('2025-01-04');
  });
  test('Mai 2025 — 1.5. ist Feiertag', () => {
    // Fr 2.5. (1.), Sa 3.5. (2.), Mo 5.5. (3.)
    expect(werktag(2025, 5, 3)).toBe('2025-05-05');
  });
  test('Oktober 2026 — 3.10. ist Feiertag und faellt auf Samstag', () => {
    // Do 1.10. (1.), Fr 2.10. (2.), Mo 5.10. (3.)
    expect(werktag(2026, 10, 3)).toBe('2026-10-05');
  });
  test('erster Werktag ist nicht der erste Tag, wenn der Erste ein Sonntag ist', () => {
    expect(werktag(2025, 6, 1)).toBe('2025-06-02');
  });
});

describe('Tagesanteil', () => {
  test('voller Monat ist 1', () => {
    expect(anteilImMonat(BASIS, 2025, 3)).toBe(1);
  });
  test('Beginn am 15.05. — 17 von 31 Tagen', () => {
    const v = { ...BASIS, start_date: '2025-05-15' };
    expect(anteilImMonat(v, 2025, 5)).toBeCloseTo(17 / 31, 4);
  });
  test('Ende am 30.11. — November voll, Dezember null', () => {
    const v = { ...BASIS, end_date: '2025-11-30' };
    expect(anteilImMonat(v, 2025, 11)).toBe(1);
    expect(anteilImMonat(v, 2025, 12)).toBe(0);
  });
  test('Monat vor Vertragsbeginn ist null', () => {
    const v = { ...BASIS, start_date: '2025-05-01' };
    expect(anteilImMonat(v, 2025, 4)).toBe(0);
  });
  test('Februar im Schaltjahr hat 29 Tage', () => {
    expect(tageImMonat(2024, 2)).toBe(29);
    expect(tageImMonat(2025, 2)).toBe(28);
  });
});

describe('Sollzeilen', () => {
  test('zwölf Monate 2025 mit allen Bestandteilen', () => {
    const z = sollZeilen(BASIS, '2025-12');
    expect(z).toHaveLength(12);
    expect(z[0].expected).toBe(1250);
    expect(z[0].kaltmiete).toBe(1000);
    expect(z[0].nk).toBe(200);
    expect(z[0].garage).toBe(50);
    expect(z[0].period_month).toBe('2025-01-01');
  });
  test('vor dem 01.01.2025 wird nichts gestellt', () => {
    const z = sollZeilen(BASIS, '2025-02');
    expect(z[0].period_month).toBe('2025-01-01');
    expect(z).toHaveLength(2);
  });
  test('anteiliger erster Monat', () => {
    const v = { ...BASIS, start_date: '2025-05-15' };
    const z = sollZeilen(v, '2025-05');
    expect(z).toHaveLength(1);
    /* Der Anteil wird auf vier Stellen gerundet GESPEICHERT und danach
       angewendet — sonst stuenden in der Datenbank andere Zahlen als in der
       Rechnung. 17/31 = 0,548387… wird zu 0,5484. */
    expect(z[0].anteil).toBe(0.5484);
    expect(z[0].kaltmiete).toBe(548.40);
    expect(z[0].nk).toBe(109.68);
    expect(z[0].garage).toBe(27.42);
    expect(z[0].expected).toBe(685.50);
  });
  test('ohne Kaltmiete entsteht keine Zeile', () => {
    expect(sollZeilen({ ...BASIS, kaltmiete: null }, '2025-12')).toHaveLength(0);
  });
  test('Owner-Hauptmieter wird als bezahlt gekennzeichnet', () => {
    const z = sollZeilen({ ...BASIS, owner_hauptmieter: true }, '2025-01');
    expect(z[0].gilt_als_bezahlt).toBe(true);
  });
  test('vereinbarter Faelligkeitstag schlaegt den dritten Werktag', () => {
    const z = sollZeilen({ ...BASIS, rent_due_day: 5 }, '2025-01');
    expect(z[0].due_date).toBe('2025-01-05');
  });
});

describe('Zuordnung', () => {
  const zahler: Zahler[] = [
    { lease_id: 23, iban: 'DE76643500700021698336', name: 'Paolo De Neo', stichworte: ['n24', 'Nonnenburgstr', 'W2'] },
    { lease_id: 34, iban: null, name: 'Noah Mainz', stichworte: ['i83', 'Irisweg', 'W1'] },
    { lease_id: 26, iban: null, name: 'Klaus Bickel', stichworte: ['n24', 'Nonnenburgstr', 'W5'] },
    { lease_id: 20, iban: null, name: 'Jürgen Bickel', stichworte: ['l19', 'Leutenbergstr', 'W3'] },
  ];
  const z = (t: Partial<Zahlung>): Zahlung => ({
    id: 1, account_id: 4, booking_date: '2025-06-02', amount: 100,
    counterparty_name: null, counterparty_iban: null, reference: null, ...t,
  });

  test('IBAN schlaegt alles', () => {
    const t = zuordnen(z({ counterparty_iban: 'DE76643500700021698336', counterparty_name: 'wer auch immer' }), zahler);
    expect(t).toEqual({ lease_id: 23, grundlage: 'iban' });
  });
  test('IBAN mit Leerzeichen und Kleinschreibung trifft ebenfalls', () => {
    const t = zuordnen(z({ counterparty_iban: 'de76 6435 0070 0021 6983 36' }), zahler);
    expect(t?.lease_id).toBe(23);
  });
  test('Name plus Stichwort im Zweck', () => {
    const t = zuordnen(z({ counterparty_name: 'Noah Mainz', reference: 'Miete November für Irisweg 83' }), zahler);
    expect(t).toEqual({ lease_id: 34, grundlage: 'name_zweck' });
  });
  test('eindeutiger Name genuegt ohne Stichwort', () => {
    /* Die meisten Mieter schreiben ihren Namen in den Zweck, nicht die
       Adresse. „Noah Mainz" passt auf genau einen Vertrag — das reicht. */
    const t = zuordnen(z({ counterparty_name: 'Noah Mainz', reference: 'Überweisung' }), zahler);
    expect(t).toEqual({ lease_id: 34, grundlage: 'name_zweck' });
  });
  test('gekuerzter Bankname trifft ueber den eindeutigen Nachnamen', () => {
    /* Die Bank schneidet lange Namen ab: „RICHARD M. RETTENBACHER UND PH".
       „Rettenbacher" kommt nur einmal vor — das genuegt. */
    const mit: Zahler[] = [...zahler,
      { lease_id: 19, iban: null, name: 'Richard Maximilian Rettenbacher', stichworte: ['l19'] }];
    const t = zuordnen(z({ counterparty_name: 'RICHARD M. RETTENBACHER UND PH',
      reference: 'Rettenbacher - Miete und Nebenkosten Feb' }), mit);
    expect(t?.lease_id).toBe(19);
  });
  test('mehrdeutiger Nachname rettet nichts', () => {
    /* „Bickel" steht bei zwei Vertraegen — also bleibt die Zahlung offen,
       auch wenn der Vorname fehlt. */
    expect(zuordnen(z({ counterparty_name: 'K. BICKEL UND W. B', reference: 'Miete' }), zahler)).toBeNull();
  });
  test('unbekannter Name wird nicht zugeordnet', () => {
    expect(zuordnen(z({ counterparty_name: 'Fabian Mann', reference: '2026-0036' }), zahler)).toBeNull();
  });
  test('mehrdeutiger Name wird nicht geraten', () => {
    /* „Klaus Bickel" und „Jürgen Bickel" sind zwei Vertraege. Steht im Zweck
       nur „Miete", entscheidet nichts — dann bleibt die Zahlung offen. */
    expect(zuordnen(z({ counterparty_name: 'Bickel', reference: 'Miete' }), zahler)).toBeNull();
  });
  test('derselbe Nachname, aber eindeutiger Zweck', () => {
    const t = zuordnen(z({ counterparty_name: 'Klaus Bickel', reference: 'Miete N24' }), zahler);
    expect(t?.lease_id).toBe(26);
  });
  test('Kaution ist keine Miete — auch bei passender IBAN nicht', () => {
    /* Sonst tilgt die Kaution die aeltesten Monate und die juengsten stehen
       faelschlich offen. Genau das ist im Probelauf passiert. */
    expect(zuordnen(z({ counterparty_iban: 'DE76643500700021698336',
      reference: 'Kaution Wohnung 6' }), zahler)).toBeNull();
  });
  test('Abrechnungsnachzahlung ist keine Miete', () => {
    expect(zuordnen(z({ counterparty_name: 'Paolo De Neo',
      reference: 'Nebenkostenabrechnung und Heizkostenabrechnung 2024' }), zahler)).toBeNull();
  });
  test('ohne Name und ohne IBAN bleibt es offen', () => {
    expect(zuordnen(z({ reference: 'Miete N24' }), zahler)).toBeNull();
  });
  test('Umlaute im Namen stoeren nicht', () => {
    const t = zuordnen(z({ counterparty_name: 'Juergen Bickel', reference: 'Leutenbergstrasse' }), zahler);
    expect(t?.lease_id).toBe(20);
  });
});

describe('Hilfsfunktionen', () => {
  test('istKeineMiete erkennt Kaution, Abrechnung und Mieterstrom', () => {
    expect(istKeineMiete('Kaution Abert. Marktgasse 24')).toBe(true);
    expect(istKeineMiete('Nebenkostenabrechnung 2024')).toBe(true);
    /* Mieterstrom: eigener Liefervertrag, keine Miete. */
    expect(istKeineMiete('De Meo. Strom (January 25)')).toBe(true);
    expect(istKeineMiete('341-003')).toBe(true);
    expect(istKeineMiete('Miete Marktgasse 24. 11/25')).toBe(false);
    expect(istKeineMiete(null)).toBe(false);
  });
  test('Mieterstrom-Sperre greift nicht bei einer Mietzahlung in Mietgroesse', () => {
    /* S28 W2 zahlte 1.540,00 EUR mit „miete juni plus 50 euro strom" und
       1.390,00 EUR mit „… August, Rabatt von 100 Euro fuer Strom". Die erste
       Fassung verwarf beide und zeigte zwei Monate Rueckstand, die bezahlt
       waren. */
    expect(istKeineMiete('miete juni plus 50 euro strom', 1540)).toBe(false);
    expect(istKeineMiete('Vermietung schonhalde28 August, Rabatt von 100 Euro fuer Strom', 1390)).toBe(false);
    /* Der Abschlag selbst bleibt gesperrt — Betrag und Zweck sprechen dagegen. */
    expect(istKeineMiete('De Meo. Strom (January 25)', 70)).toBe(true);
    expect(istKeineMiete('341-003', 70)).toBe(true);
    /* Ohne Mietwort bleibt ein hoher Strombetrag eine Stromzahlung. */
    expect(istKeineMiete('Stromabschlag Jahresrechnung', 70)).toBe(true);
  });
  test('normal vereinheitlicht Umlaute und Satzzeichen', () => {
    expect(normal('Möller-Rippstein, Eva')).toBe('moeller rippstein eva');
    expect(normal(null)).toBe('');
  });
  test('laufenderMonat liefert YYYY-MM', () => {
    expect(laufenderMonat(new Date('2026-10-15T12:00:00Z'))).toBe('2026-10');
  });
});

describe('Monat aus dem Verwendungszweck', () => {
  /* § 366 Abs. 1 BGB: Nennt der Schuldner den Monat, gilt dieser — nicht die
     aelteste offene Forderung. Die Mieter schreiben ihn auf Deutsch,
     Englisch und Spanisch. */
  test('deutsche Monatsnamen', () => {
    expect(monatAusZweck('Miete Oktober 2025', '2025-10-01')).toBe('2025-10-01');
    expect(monatAusZweck('Miete für den Monat November 2025', '2025-11-03')).toBe('2025-11-01');
    expect(monatAusZweck('aprilmiete 2026 schönhalde 28', '2026-04-01')).toBe('2026-04-01');
  });
  test('englisch und spanisch', () => {
    expect(monatAusZweck('October 2026', '2026-10-01')).toBe('2026-10-01');
    expect(monatAusZweck('alquiler de enero 2026', '2026-01-02')).toBe('2026-01-01');
    expect(monatAusZweck('Setiembre 2026', '2026-09-01')).toBe('2026-09-01');
    expect(monatAusZweck('DE MEO. Rent + Nebenkost + Parking (August 25)', '2025-08-05')).toBe('2025-08-01');
  });
  test('Zahlformen', () => {
    expect(monatAusZweck('Miete Marktgasse 24. 11/25', '2025-11-03')).toBe('2025-11-01');
    expect(monatAusZweck('Miete 08/26 für Irisweg 83', '2026-07-27')).toBe('2026-08-01');
    expect(monatAusZweck('Abschlag 2026-03', '2026-03-02')).toBe('2026-03-01');
  });
  test('Jahreswechsel ohne Jahresangabe', () => {
    /* Im Januar gezahlte Dezembermiete gehoert ins Vorjahr. */
    expect(monatAusZweck('Miete Dezember', '2026-01-05')).toBe('2025-12-01');
    /* Im Dezember gezahlte Januarmiete ins Folgejahr. */
    expect(monatAusZweck('Miete Januar', '2025-12-28')).toBe('2026-01-01');
  });
  test('ohne Monatsangabe kommt nichts zurueck', () => {
    expect(monatAusZweck('Miete Elena Lazic', '2025-06-03')).toBeNull();
    expect(monatAusZweck('Mietzahlung Schweigert Joshua', '2025-07-02')).toBeNull();
    expect(monatAusZweck(null, '2025-07-02')).toBeNull();
  });
  test('kurze Kuerzel treffen nicht mitten im Wort', () => {
    /* „mar" in „Marktgasse" darf nicht als Maerz gelesen werden. */
    expect(monatAusZweck('Miete Marktgasse 24', '2025-05-02')).toBeNull();
  });
  test('zwei verschiedene Monate sind mehrdeutig', () => {
    expect(monatAusZweck('Miete Januar und Februar', '2025-01-05')).toBeNull();
  });
});

describe('Kontozuordnung', () => {
  test('N24 laeuft ueber das La-Perla-Konto, alles andere ueber das Mietkonto', () => {
    expect(kontoFuer('n24')).toBe(4);
    expect(kontoFuer('MG24')).toBe(7);
    expect(kontoFuer('s28')).toBe(7);
    expect(kontoFuer('unbekannt')).toBe(7);
  });
});
