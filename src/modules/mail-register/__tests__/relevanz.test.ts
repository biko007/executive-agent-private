import { describe, expect, test } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  bewerte, kopfAusschluss, ladeRegeln, regelnAnlegenFallsFehlend, vorschlagText, kurzId,
  maskiere, STANDARD_REGELN, type BewertungsEingang,
} from '../relevanz.js';

const R = STANDARD_REGELN;

function m(teil: Partial<BewertungsEingang> = {}): BewertungsEingang {
  return { absender: 'info@firma.de', absenderName: 'Firma', betreff: 'Hallo', ordner: 'INBOX', kopf: {}, ...teil };
}

describe('Relevant — Positivfälle (echte Mails 18.–27.10.2026)', () => {
  test('Bauser, Zählerstände N24 → b mit Objekt', () => {
    const b = bewerte(m({ absender: 'matthias.bauser@bikolino.com', absenderName: 'Matthias Bauser',
      betreff: 'Fw: N24 Zählerstände Strom & Austausch Wärmepumpe' }), R);
    expect(b.relevant).toBe(true);
    expect(b.vorschlag).toBe('b');
    expect(b.objekt).toBe('N24');
    expect(b.kontakt).toBe('Bauser');
    expect(vorschlagText(b)).toBe('b) Zählerstände/Fakten in bikosoc einarbeiten (N24)');
  });

  test('Rechnung mit Objekt im Betreff → a, Buchung Objekt', () => {
    const b = bewerte(m({ absender: 'matthias.bauser@bikolino.com', betreff: 'MG24 | Koch Brennstoffe RE_206157 Rechnung' }), R);
    expect(b.vorschlag).toBe('a');
    expect(vorschlagText(b)).toBe('a) Beleg ablegen + Buchung MG24');
  });

  test('Rechnung ohne Objekt → a mit „Objekt ?"', () => {
    const b = bewerte(m({ absender: 'order@hailo-shop.de', betreff: 'Rechnung zur Bestellung 354258' }), R);
    expect(b.relevant).toBe(true);
    expect(vorschlagText(b)).toBe('a) Beleg ablegen + Buchung Objekt ?');
  });

  test('Kündigung von EnBW → d', () => {
    const b = bewerte(m({ absender: 'kontakt@enbw.com', betreff: 'Die Kündigung Ihres Wärmestromvertrags ist bei uns angekommen.' }), R);
    expect(b.vorschlag).toBe('d');
    expect(b.kontakt).toBe('EnBW');
  });

  test('Mahnung → e', () => {
    expect(bewerte(m({ betreff: 'Zahlungserinnerung 26.10.2026' }), R).vorschlag).toBe('e');
  });

  test('Kontakt ohne Stichwort → relevant, Vorschlag offen', () => {
    const b = bewerte(m({ absender: 'daniela.wolf-glassl@maurer-schramberg.de', betreff: 'N24 Whg 6: Austausch Ventilator' }), R);
    expect(b.relevant).toBe(true);
    expect(b.vorschlag).toBe('offen');
    expect(vorschlagText(b)).toBe('Vorschlag offen');
  });

  test('Antwort auf eine gesendete Mail des Owners → c', () => {
    const b = bewerte(m({ absender: 'robert@1280krone.com', betreff: 'AW: Catering-Anfrage',
      kopf: { 'in-reply-to': '<ABC@bikolino.com>' } }), R, new Set(['<abc@bikolino.com>']));
    expect(b.relevant).toBe(true);
    expect(b.antwort).toBe(true);
    expect(b.vorschlag).toBe('c');
  });

  test('„AW:" allein ohne gesendete Mail ist keine Antwort', () => {
    const b = bewerte(m({ betreff: 'AW: Catering-Anfrage', kopf: { 'in-reply-to': '<x@y>' } }), R, new Set());
    expect(b.relevant).toBe(false);
  });

  test('Objektadresse im Text zählt', () => {
    const b = bewerte(m({ absender: 'x@handwerk.de', betreff: 'Termin', text: 'Baustelle Leutenbergstraße 19' }), R);
    expect(b.objekt).toBe('L19');
  });

  test('Kontakt schlägt Newsletter-Kopf: Bankpost mit List-Unsubscribe bleibt relevant', () => {
    const b = bewerte(m({ absender: 'noreply@ksk-tut.de', betreff: 'Neue Nachricht im Postfach',
      kopf: { 'list-unsubscribe': '<mailto:x>' } }), R);
    expect(b.relevant).toBe(true);
    expect(b.kontakt).toBe('Bank');
  });

  test('Paket verspätet ist die Ausnahme vom Paketstatus', () => {
    const b = bewerte(m({ absender: 'no-reply@gls-pakete.de', betreff: 'Dein Paket von Hailo Werk verspätet sich.' }), R);
    expect(b.relevant).toBe(true);
    expect(b.vorschlag).toBe('f');
    expect(bewerte(m({ absender: 'noreply@service.dpd.de', betreff: 'Paket nicht zustellbar' }), R).relevant).toBe(true);
    expect(bewerte(m({ absender: 'noreply@service.dpd.de', betreff: 'Bald ist Ihr Paket da' }), R).grund).toBe('Paketstatus');
  });
});

describe('Nicht relevant — Negativfälle', () => {
  const faelle: Array<[string, Partial<BewertungsEingang>, string]> = [
    ['Newsletter per List-Unsubscribe', { betreff: 'Ihre Rechnung: Sparen Sie 20 %', kopf: { 'list-unsubscribe': '<x>' } }, 'Newsletter'],
    ['Paketstatus DHL', { absender: 'zustellung@dhl.de', betreff: 'Ihre Sendung liegt am Ablageort (Lieferung)' }, 'Paketstatus'],
    ['Paketstatus Amazon', { absender: 'shipment-tracking@amazon.de', betreff: 'In Zustellung: Bestellung' }, 'Paketstatus'],
    ['UPS-Strom', { absender: 'no-reply@swingerheim.com', betreff: 'UPS: On battery power' }, 'Systemmeldung'],
    ['Clockin', { absender: 'noreply@clockin.de', betreff: 'Neue Projektnotiz' }, 'Systemmeldung'],
    ['Solar-Log', { absender: 'noreply@solarlog-web.de', betreff: 'Backup 43/2026' }, 'Systemmeldung'],
    ['Sign-in', { absender: 'noreply@tm.openai.com', betreff: 'New sign-in to your OpenAI account' }, 'Systemmeldung'],
    ['LinkedIn', { absender: 'messages-noreply@linkedin.com', betreff: 'Angebot für Sie' }, 'Social'],
    ['Ordner Soziale Updates', { absender: 'x@y.de', betreff: 'Rechnung', ordner: 'Soziale Updates' }, 'Social'],
    ['Bewerbung', { absender: 'x@o-vivi.com', betreff: 'Projektmanager-Elektroingenieur - Parin Gandhi' }, 'Bewerbung'],
    ['Gesundheit', { absender: 'info@email-zavamed.com', betreff: 'Rechnung zu Ihrem Rezept' }, 'Gesundheit'],
    ['Gesundheit schlägt Kontakt', { absender: 'matthias.bauser@bikolino.com', betreff: 'Arzttermin' }, 'Gesundheit'],
    ['Werbeordner Yahoo', { absender: 'x@shop.de', betreff: 'Bestellung jetzt', ordner: 'Angebote' }, 'Werbung'],
    ['Werbung im Betreff', { absender: 'no-reply@starlink.com', betreff: 'Empfehlen Sie Starlink' }, 'Werbung'],
    ['eigene Mail', { absender: 'juergen.bickel@bikolino.com', betreff: 'Abendbriefing Rechnung' }, 'eigene Mail'],
  ];
  for (const [name, teil, grund] of faelle) {
    test(name, () => {
      const b = bewerte(m(teil), R);
      expect(b.relevant).toBe(false);
      expect(b.grund).toBe(grund);
    });
  }

  test('ohne Merkmal', () => {
    expect(bewerte(m({ betreff: 'Hallo zusammen' }), R).grund).toBe('kein Merkmal');
  });

  test('„Bestellung" nur im Text (Shop-Fußzeile) macht nicht relevant', () => {
    const b = bewerte(m({ betreff: 'Eine Stunde früher dunkel?', text: 'Zur Bestellung hier klicken' }), R);
    expect(b.relevant).toBe(false);
  });

  test('Kürzel D4 im Text ist kein Objekt — nur im Betreff', () => {
    const b = bewerte(m({ betreff: 'Rechnung 1', text: 'Artikel D4 Schraube' }), R);
    expect(b.objekt).toBeUndefined();
    expect(bewerte(m({ betreff: 'D4 Rechnung' }), R).objekt).toBe('D4');
  });

  test('kopfAusschluss braucht keinen Text', () => {
    expect(kopfAusschluss(m({ absender: 'zustellung@dhl.de' }), R)).toBe('Paketstatus');
    expect(kopfAusschluss(m({ absender: 'matthias.bauser@bikolino.com' }), R)).toBeNull();
  });
});

describe('Regelwerk als Datei', () => {
  test('wird einmal angelegt und nie überschrieben', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'relevanz-'));
    const p = path.join(dir, 'relevanz.json');
    expect(regelnAnlegenFallsFehlend(p)).toBe(true);
    fs.writeFileSync(p, JSON.stringify({ kontakte: [{ name: 'X', absender: '@x\\.de$' }] }));
    expect(regelnAnlegenFallsFehlend(p)).toBe(false);
    const { regeln } = ladeRegeln(p);
    expect(regeln.kontakte).toEqual([{ name: 'X', absender: '@x\\.de$' }]);
    expect(regeln.stichworte).toEqual(STANDARD_REGELN.stichworte);
  });

  test('Owner-Änderung wirkt: neuer Kontakt macht relevant', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'relevanz-'));
    const p = path.join(dir, 'relevanz.json');
    fs.writeFileSync(p, JSON.stringify({ kontakte: [{ name: 'Neu', absender: '@neu\\.de$' }] }));
    const { regeln } = ladeRegeln(p);
    expect(bewerte(m({ absender: 'a@neu.de', betreff: 'Hallo' }), regeln).kontakt).toBe('Neu');
  });

  test('kaputte Regex fällt zurück, der Lauf hält nicht an', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'relevanz-'));
    const p = path.join(dir, 'relevanz.json');
    fs.writeFileSync(p, JSON.stringify({
      kontakte: [{ name: 'Kaputt', absender: '([' }, { name: 'Gut', absender: '@gut\\.de$' }],
      ausschluss: { paketAbsender: '((' },
    }));
    const { regeln, warnungen } = ladeRegeln(p);
    expect(regeln.kontakte.map((k) => k.name)).toEqual(['Gut']);
    expect(regeln.ausschluss.paketAbsender).toBe(STANDARD_REGELN.ausschluss.paketAbsender);
    expect(warnungen.length).toBe(2);
  });

  test('unlesbare Datei → Vorgabe', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'relevanz-'));
    const p = path.join(dir, 'relevanz.json');
    fs.writeFileSync(p, '{ kaputt');
    const { regeln, warnungen } = ladeRegeln(p);
    expect(regeln).toBe(STANDARD_REGELN);
    expect(warnungen[0]).toContain('unlesbar');
  });
});

describe('Kennung und Maskierung', () => {
  test('Kennung ist stabil und unabhängig von Groß-/Kleinschreibung', () => {
    expect(kurzId('<ABC@x>')).toBe(kurzId('<abc@x> '));
    expect(kurzId('<abc@x>')).toMatch(/^m-[0-9a-f]{8}$/);
  });

  test('IBAN wird bis auf die letzten vier Stellen gekürzt', () => {
    expect(maskiere('Zahlung an DE89 3704 0044 0532 0130 00 erfolgt')).toBe('Zahlung an DE89…3000 erfolgt');
    expect(maskiere('IBAN DE89370400440532013000')).toBe('IBAN DE89…3000');
  });

  test('IBAN klein oder mit Bindestrichen, Girokonto, Kto.-Nr., Account no.', () => {
    expect(maskiere('de89370400440532013000')).toBe('DE89…3000');
    expect(maskiere('DE89-3704-0044-0532-0130-00')).toBe('DE89…3000');
    expect(maskiere('Girokonto 1234567890')).toBe('Girokonto …7890');
    expect(maskiere('Kto.-Nr. 1234567890')).toBe('Kto.-Nr. …7890');
    expect(maskiere('Account no. 123456789')).toBe('Account no. …6789');
  });

  test('Zahlungsfrist und Belege werden erkannt', () => {
    expect(bewerte(m({ betreff: 'Ihre Zahlungsfrist endet' }), R).vorschlag).toBe('d');
    expect(bewerte(m({ betreff: 'Ihre Belege Oktober' }), R).vorschlag).toBe('a');
    expect(bewerte(m({ betreff: 'Fristlose Kündigung' }), R).vorschlag).toBe('d');
  });

  test('Kontonummer wird gekürzt, Rechnungsnummer bleibt', () => {
    expect(maskiere('Kontonummer: 1234567890')).toBe('Kontonummer: …7890');
    expect(maskiere('Rechnung 6007412724')).toBe('Rechnung 6007412724');
  });
});
