/**
 * Tests fuer mail/inventar — Einordnung von Kopfdaten und Lesen der
 * Stadtwerke-Rechnungszeilen. Alle Beispiele stammen aus echten Betreffs
 * und Mailtexten des Postfachs (Lauf vom 17.10.2026).
 */
import { describe, expect, test } from 'bun:test';
import {
  kategorisiere, ausschluss, nummerGekuerzt, swtRechnungenAusText,
  betragLesen, zaehlernummer, anhangsnamen,
} from '../inventar.js';

const kopf = (betreff: string, adresse = 'absender@example.de', name = '') =>
  ({ betreff, adresse, name });

describe('kategorisiere', () => {
  test('ordnet eine Rechnung ein', () => {
    expect(kategorisiere(kopf('Rechnung VRB25-01519'))).toContain('rechnungen');
  });

  test('erkennt mehrere Register in einer Nachricht', () => {
    const r = kategorisiere(kopf('1. Mahnung zu Rechnung 4711'));
    expect(r).toContain('mahnungen');
    expect(r).toContain('rechnungen');
  });

  test('erkennt die Stadtwerke an der Absenderdomaene, nicht am Betreff', () => {
    expect(kategorisiere(kopf('Neue Rechnung', 'info@swtenergie.de'))).toContain('stadtwerke');
  });

  test('Zaehlerstandsmeldung ohne Schlagwort landet im Stadtwerke-Register', () => {
    expect(kategorisiere(kopf('Zählerstandsmeldung für 10707956', 'msb@swtenergie.de')))
      .toContain('stadtwerke');
  });

  test('Hausbank gehoert ins Bankenregister', () => {
    expect(kategorisiere(kopf('Sie haben Post', 'onlineportal@standardlife.de')))
      .toContain('banken');
  });

  test('ein Zahlungsdienst gehoert NICHT ins Bankenregister', () => {
    expect(kategorisiere(kopf('Ihre Bestellung', 'service@paypal.de'))).not.toContain('banken');
  });

  test('Fahrzeugpost landet bei den Anlagen', () => {
    expect(kategorisiere(kopf('Panamera TUT-ZZ 2E Zulassungsbescheinigung')))
      .toContain('assets');
  });

  test('Behoerdenpost wird erkannt', () => {
    expect(kategorisiere(kopf('Grundsteuerwertbescheid, Aktenzeichen 4711')))
      .toContain('behoerden');
  });

  test('Rundschreiben landet in keinem Register', () => {
    expect(kategorisiere(kopf('EAN-News: Freitag', 'newsletter@elektroauto-news.net')))
      .toEqual([]);
  });

  test('Gesundheitspost landet in keinem Register — auch mit Rechnung im Betreff', () => {
    expect(kategorisiere(kopf('Rechnung der Zahnarztpraxis'))).toEqual([]);
  });

  test('private Post ohne Vertrags- oder Kostenbezug bleibt leer', () => {
    expect(kategorisiere(kopf('Fotos vom Wochenende'))).toEqual([]);
  });
});

describe('ausschluss', () => {
  test('Gesundheit schlaegt Newsletter', () => {
    expect(ausschluss(kopf('Newsletter der Apotheke'))).toBe('gesundheit');
  });

  test('erkennt Rundschreiben an der Absenderadresse', () => {
    expect(ausschluss(kopf('Freitag', 'wired@newsletters.wired.com'))).toBe('newsletter');
  });

  test('eine Geschaeftsmail ist keines von beidem', () => {
    expect(ausschluss(kopf('Auftragsbestätigung', 'verkauf@rollo-solar.de'))).toBeNull();
  });
});

describe('swtRechnungenAusText', () => {
  const text = [
    'Kundennummer - Rechnungseinheit | Rechnungsnummer | Rechnungsdatum | Rechnungsbetrag',
    '527415 - 318635 | 0001-ARV-2026-16684 | 01.10.2026  |  209,61 €',
    '527415 - 318635 | 0001-ARV-2026-16680 | 01.10.2026  |  397,48 €',
    '133224 - 49267 | 0001-ARV-2025-14942 | 06.08.2025  |  -8.695,30 €',
  ].join('\n');

  test('liest alle Zeilen einer Mail', () => {
    expect(swtRechnungenAusText(text)).toHaveLength(3);
  });

  test('trennt Kundennummer und Rechnungseinheit', () => {
    const [erste] = swtRechnungenAusText(text);
    expect(erste.kunde).toBe('527415');
    expect(erste.rechnungseinheit).toBe('318635');
    expect(erste.rechnungsnummer).toBe('ARV-2026-16684');
    expect(erste.datum).toBe('01.10.2026');
    expect(erste.betrag).toBe(209.61);
  });

  test('liest Gutschriften mit Tausenderpunkt und Vorzeichen', () => {
    const gutschrift = swtRechnungenAusText(text).find(r => r.rechnungsnummer === 'ARV-2025-14942');
    expect(gutschrift?.betrag).toBe(-8695.30);
  });

  test('ohne Rechnungszeile kommt nichts zurueck', () => {
    expect(swtRechnungenAusText('Ihre Rechnung liegt im Kundenportal bereit.')).toEqual([]);
  });
});

describe('betragLesen', () => {
  test('deutsche Schreibweise', () => { expect(betragLesen('9.422,32')).toBe(9422.32); });
  test('Vorzeichen und Leerzeichen', () => { expect(betragLesen('- 73,33')).toBe(-73.33); });
  test('kein Betrag', () => { expect(betragLesen('Kundenportal')).toBeNull(); });
});

describe('zaehlernummer', () => {
  test('aus der Betreffzeile der Stadtwerke', () => {
    expect(zaehlernummer('Zählerstandsmeldung für 10707956')).toBe('10707956');
  });
  test('ohne Nummer kommt null', () => {
    expect(zaehlernummer('Neue Rechnung')).toBeNull();
  });
});

describe('nummerGekuerzt', () => {
  test('kuerzt eine Versicherungsnummer auf die letzten vier Stellen', () => {
    expect(nummerGekuerzt('Korrespondenz 36.26.0243591')).toBe('Korrespondenz …3591');
  });

  test('laesst kurze Zahlen stehen', () => {
    expect(nummerGekuerzt('Rechnung 2026')).toBe('Rechnung 2026');
  });

  test('es bleibt keine lange Ziffernfolge im Klartext stehen', () => {
    const raus = nummerGekuerzt('VSNR 70/747173605 und IBAN DE12345678901234567890');
    expect(raus).not.toMatch(/\d{5,}/);
  });
});

describe('anhangsnamen', () => {
  test('findet einen Anhang in der Tiefe', () => {
    const struktur = {
      childNodes: [
        { type: 'text/plain' },
        { childNodes: [{ disposition: 'attachment', dispositionParameters: { filename: 'rechnung.pdf' } }] },
      ],
    };
    expect(anhangsnamen(struktur)).toEqual(['rechnung.pdf']);
  });

  test('ohne Anhang bleibt die Liste leer', () => {
    expect(anhangsnamen({ type: 'text/plain' })).toEqual([]);
  });

  test('vertraegt eine fehlende Struktur', () => {
    expect(anhangsnamen(undefined)).toEqual([]);
  });
});

describe('Wächter: das Modul schreibt nichts im Postfach', () => {
  test('keine veraendernde IMAP-Operation in der Quelle', () => {
    const quelle = require('node:fs').readFileSync(
      new URL('../inventar.ts', import.meta.url).pathname, 'utf-8');
    for (const verboten of ['messageFlagsAdd', 'messageFlagsSet', 'messageMove',
      'messageDelete', 'messageCopy', 'append(']) {
      expect(quelle).not.toContain(verboten);
    }
  });
});

describe('Versicherer und fremde Nennungen', () => {
  test('Portalpost eines Versicherers landet im Versicherungsregister', () => {
    const r = kategorisiere(kopf('Sie haben Post – in Ihrem elektronischen Postfach',
      'onlineportal@standardlife.de'));
    expect(r).toContain('versicherungen');
    expect(r).toContain('banken');
  });

  test('Gothaer-Korrespondenz ohne das Wort Versicherung im Betreff', () => {
    expect(kategorisiere(kopf('Korrespondenz, 36.26.0243591', 'postausgang@gothaer.de')))
      .toContain('versicherungen');
  });

  test('ein Netzwerk, das eine Bank nennt, kommt nicht ins Bankenregister', () => {
    expect(kategorisiere(kopf('Aufsichtsrat bei Volksbank eG', 'messages-noreply@linkedin.com')))
      .not.toContain('banken');
  });

  test('ein Verein, der eine Bank nennt, auch nicht', () => {
    expect(kategorisiere(kopf('Imkerverein: Volksbank Spendenaktion', 'verein@web.de')))
      .not.toContain('banken');
  });

  test('die Hausbank selbst bleibt drin', () => {
    expect(kategorisiere(kopf('Ihre Sparkassen-Card', 'noreply@ksk-tut.de'))).toContain('banken');
  });
});

describe('Behoerdenregister trennt Amtspost von Nachrichtenpost', () => {
  test('ein Bescheid bleibt drin', () => {
    expect(kategorisiere(kopf('Grundsteuerwertbescheid Finanzamt Tuttlingen')))
      .toContain('behoerden');
  });

  test('ein Netzwerkbeitrag ueber eine Gemeinde nicht', () => {
    expect(kategorisiere(kopf('Wenn die türkische Gemeinde so empfindet',
      'close_friend_updates@facebookmail.com'))).not.toContain('behoerden');
  });

  test('ein Nachrichtenbrief ueber Zoll nicht', () => {
    expect(kategorisiere(kopf('Davos-Special: Zoll-Entspannung', 'ceo@briefing.table.media')))
      .not.toContain('behoerden');
  });

  test('das Hauptzollamt bleibt drin', () => {
    expect(kategorisiere(kopf('Kraftfahrzeugsteuerbescheid Hauptzollamt Singen')))
      .toContain('behoerden');
  });
});
