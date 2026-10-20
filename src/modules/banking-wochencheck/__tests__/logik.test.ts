/**
 * Reine Rechenregeln des Banking-Wochenchecks — ohne Datenbank (C1).
 */
import { describe, expect, test } from 'bun:test';
import {
  anfangswert, ausgebliebeneSerien, faelligeAbschlaege, gegenparteiAnzeige, GESUNDHEIT_ANZEIGE,
  kontoKurz, offeneAbschlaege, saldenUrteil, zweckAnzeige, zweckErlaubt, type Umsatz,
} from '../logik.js';

describe('Datenschutz im Report (C5)', () => {
  test('Konto nur mit den letzten vier Stellen', () => {
    expect(kontoKurz('DE19643500700008618621')).toBe('…8621');
    expect(kontoKurz('DE19 6435 0070 0008 6186 21')).toBe('…8621');
  });

  test('Privatpersonen werden nicht genannt, Firmen schon', () => {
    expect(gegenparteiAnzeige('Max Mustermann')).toBe('Privatperson');
    expect(gegenparteiAnzeige('Stadtwerke Tuttlingen GmbH')).toBe('Stadtwerke Tuttlingen GmbH');
    expect(gegenparteiAnzeige('NEW Niederrhein Energie und Wasser GmbH')).toContain('NEW');
    expect(gegenparteiAnzeige('')).toBe('(ohne Gegenpartei)');
  });

  test('Gesundheitsanbieter erscheinen nie mit Namen, auch mit Rechtsform', () => {
    for (const g of ['AOK Baden-Wuerttemberg', 'MVZ Muster GmbH', 'PVS Abrechnungsstelle GmbH',
      'Stadt-Apotheke OHG', 'Zahnarztpraxis Dr. Muster', 'IKK classic']) {
      expect(gegenparteiAnzeige(g)).toBe(GESUNDHEIT_ANZEIGE);
    }
    expect(zweckErlaubt(GESUNDHEIT_ANZEIGE)).toBe(false);
  });

  test('Fahrzeugpflege ist keine Gesundheit, „Bankowski" keine Bank', () => {
    expect(gegenparteiAnzeige('Autopflege Bertelmann GmbH')).toBe('Autopflege Bertelmann GmbH');
    expect(gegenparteiAnzeige('Anna Bankowski')).toBe('Privatperson');
  });

  test('Zweck nur bei erkennbaren Firmen', () => {
    expect(zweckErlaubt('Privatperson')).toBe(false);
    expect(zweckErlaubt('(Kennung entfernt)')).toBe(false);
    expect(zweckErlaubt('Stadtwerke Tuttlingen GmbH')).toBe(true);
  });

  test('Gegenpartei, die nur aus einer Kennung besteht, wird entfernt', () => {
    expect(gegenparteiAnzeige('DE19643500700008618621')).toBe('(Kennung entfernt)');
  });

  test('Steuernummern verschwinden aus dem Zweck', () => {
    expect(zweckAnzeige('STEUERNR 021/101/55659 UMS.ST 4VJ.25')).not.toMatch(/55659/);
  });

  test('IBAN und lange Ziffernfolgen verschwinden aus dem Zweck', () => {
    const z = zweckAnzeige('Miete IBAN: DE19643500700008618621 Ref 12345678901234');
    expect(z).not.toMatch(/DE19\d/);
    expect(z).not.toMatch(/\d{10,}/);
    expect(z).toContain('(IBAN entfernt)');
  });
});

describe('Mieterstrom-Abschläge', () => {
  test('fällige Abschläge März bis Oktober = 8', () => {
    expect(faelligeAbschlaege('2026-03-01', '2026-10-20')).toBe(8);
    expect(faelligeAbschlaege('2026-03-01', '2026-02-28')).toBe(0);
  });

  test('Abschlag des laufenden Monats zählt erst ab dem 5.', () => {
    expect(faelligeAbschlaege('2026-03-01', '2026-03-02')).toBe(0);
    expect(faelligeAbschlaege('2026-03-01', '2026-11-02')).toBe(8);
    expect(faelligeAbschlaege('2026-03-01', '2026-11-05')).toBe(9);
  });

  test('Mahngebühren täuschen keinen Teilbetrag vor', () => {
    // W2 am 20.10.2026: 71 + 221 + 221 = 513 €, darin 16 € Mahngebühren
    expect(offeneAbschlaege(8, 513, 71)).toEqual({ gedeckt: 7, offen: 1, offenEuro: 71 });
    // W3: 71 + 142 + 150 = 363 €, darin 8 € Mahngebühr
    expect(offeneAbschlaege(8, 363, 71)).toEqual({ gedeckt: 5, offen: 3, offenEuro: 213 });
    expect(offeneAbschlaege(8, 568, 71).offen).toBe(0);
  });

  test('Überzahlung führt nicht zu negativen Rückständen', () => {
    expect(offeneAbschlaege(2, 500, 71)).toEqual({ gedeckt: 2, offen: 0, offenEuro: 0 });
  });
});

describe('Ausgebliebene Daueraufträge', () => {
  const u = (datum: string, betrag = -146, gegenpartei = 'NEW Niederrhein'): Umsatz =>
    ({ konto: 7, datum, betrag, gegenpartei, zweck: '' });

  test('Lastschrift in drei Vormonaten, im laufenden Monat überfällig → gemeldet', () => {
    const f = ausgebliebeneSerien([u('2026-07-15'), u('2026-08-17'), u('2026-09-15')], '2026-10-26');
    expect(f).toHaveLength(1);
    expect(f[0].tag).toBe(15);
  });

  test('noch innerhalb der Toleranz → nicht gemeldet', () => {
    expect(ausgebliebeneSerien([u('2026-07-15'), u('2026-08-17'), u('2026-09-15')], '2026-10-19')).toHaveLength(0);
  });

  test('im laufenden Monat schon gebucht → nicht gemeldet', () => {
    expect(ausgebliebeneSerien([u('2026-07-15'), u('2026-08-17'), u('2026-09-15'), u('2026-10-15')], '2026-10-26')).toHaveLength(0);
  });

  test('nur in zwei Vormonaten → keine Serie', () => {
    expect(ausgebliebeneSerien([u('2026-08-17'), u('2026-09-15')], '2026-10-26')).toHaveLength(0);
  });

  test('andere Schreibweise derselben Gegenpartei ist dieselbe Serie', () => {
    const axa = (datum: string, g: string): Umsatz => ({ konto: 7, datum, betrag: -467.86, gegenpartei: g, zweck: '' });
    expect(ausgebliebeneSerien([
      axa('2026-07-01', 'AXA Lebensversicherung Aktiengesellschaft'),
      axa('2026-08-03', 'AXA Lebensversicherung Aktiengesellschaft'),
      axa('2026-09-01', 'AXA Lebensversicherung Aktiengesellschaft'),
      axa('2026-10-01', 'AXA Lebensversicherung AG'),
    ], '2026-10-20')).toHaveLength(0);
  });

  test('Zahlung zum Monatsende fällt im Folgemonat auf', () => {
    const f = ausgebliebeneSerien([u('2026-07-28'), u('2026-08-28'), u('2026-09-28')], '2026-11-03');
    expect(f).toHaveLength(1);
    expect(ausgebliebeneSerien([u('2026-07-28'), u('2026-08-28'), u('2026-09-28')], '2026-10-30')).toHaveLength(0);
  });

  test('über den Jahreswechsel', () => {
    expect(ausgebliebeneSerien([u('2026-10-15'), u('2026-11-16'), u('2026-12-15')], '2027-01-26')).toHaveLength(1);
    expect(ausgebliebeneSerien([u('2026-10-15'), u('2026-11-16'), u('2026-12-15'), u('2027-01-15')], '2027-01-26')).toHaveLength(0);
  });

  test('anderer Betrag ist eine andere Serie', () => {
    expect(ausgebliebeneSerien([u('2026-07-15'), u('2026-08-17', -150), u('2026-09-15')], '2026-10-26')).toHaveLength(0);
  });
});

describe('Saldenprobe', () => {
  test('Stromkonto MG24 am 20.10.2026: 71 € fehlen gegenüber Anfangsstand 0', () => {
    const a = anfangswert(1483.01, 1412.01);
    expect(a).toBe(71);
    expect(saldenUrteil(a, undefined, 0)).toContain('71,00');
  });

  test('bekannter Anfangsstand geht vor dem gespeicherten Bezug', () => {
    // Bezug 71 (mit Lücke gemessen), nach dem Nachtrag stimmt das Konto: keine Fehlmeldung
    expect(saldenUrteil(0, 71, 0)).toBe('stimmt');
    expect(saldenUrteil(71, 71, 0)).toContain('71,00');
  });

  test('gleicher Anfangswert wie letzte Woche → stimmt', () => {
    expect(saldenUrteil(19708.32, 19708.32)).toBe('stimmt');
    expect(saldenUrteil(19708.32, undefined)).toBe('erste Messung');
    expect(saldenUrteil(19708.32, 19637.32)).toContain('verschoben');
  });
});
