import { describe, expect, test, beforeEach, afterEach } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  adresseNormal, istZieladresse, empfaengerTreffer, istOwnerAbsender,
  istAuftrag, lage, betreffSlug, berlinTeile, ablageOrdner, auftragsDateiname,
  anhangName, bodyMarkdown, auftragsInhalt, datumDeutsch,
  ladeKonfiguration, STANDARD_KONFIGURATION,
  ladeVermerk, speichereVermerk, auftragSchonZugestellt, vergebeOrdner,
  verarbeiteMailEingangEinmal, meldungstext, reportAbschnitt,
  DROPBOX_MAIL_INBOX,
  textAusKoerper, anhaengeAusGraph,
  type EingangsMail, type EingangsAnhang, type PostfachZugang,
} from '../index.js';
import type { DropboxAdapter } from '../../../adapters/dropbox.js';

// ── Doppel ─────────────────────────────────────────────────────────────────

function fakeDropbox() {
  const hochgeladen: { path: string; bytes: number; text: string }[] = [];
  const adapter: DropboxAdapter = {
    async uploadFile(p) {
      hochgeladen.push({
        path: p.path, bytes: p.body.length, text: p.body.toString('utf-8'),
      });
      return { ok: true } as any;
    },
    async uploadFileStream() { throw new Error('nicht verwendet'); },
    async createFolder() { /* nicht nötig, der Upload legt den Ordner an */ },
    async listFolder() { return []; },
    async downloadFile() { throw new Error('nicht verwendet'); },
    async moveFile() { throw new Error('nicht verwendet'); },
    async healthCheck() { return true; },
  };
  return { adapter, hochgeladen };
}

function mail(teil: Partial<EingangsMail> = {}): EingangsMail {
  return {
    id: 'AAA',
    messageId: '<m1@bikolino.com>',
    empfangenIso: '2026-10-18T13:47:00Z',
    absender: 'juergen.bickel@bikolino.com',
    to: ['juergen.bickel+bikosoc@bikolino.com'],
    cc: [],
    betreff: 'Rechnung Oktober',
    text: 'Anbei die Rechnung.',
    hatAnhaenge: false,
    ...teil,
  };
}

function fakePostfach(mails: EingangsMail[], opts?: {
  anhaenge?: Record<string, EingangsAnhang[]>;
  mime?: string;
  einsortieren?: 'verschoben' | 'nicht_moeglich';
  mimeFehler?: boolean;
}) {
  const einsortiert: string[] = [];
  const postfach: PostfachZugang = {
    async neueMails() { return mails; },
    async mime() {
      if (opts?.mimeFehler) throw new Error('graph_get_error: status=404');
      return opts?.mime ?? 'From: a@b.c\r\nSubject: x\r\n\r\nText';
    },
    async anhaenge(id: string) { return opts?.anhaenge?.[id] ?? []; },
    async einsortieren(id: string) {
      einsortiert.push(id);
      return opts?.einsortieren ?? 'verschoben';
    },
  };
  return { postfach, einsortiert };
}

let tmp = '';
beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'maileingang-')); });
afterEach(() => { fs.rmSync(tmp, { recursive: true, force: true }); });

// ── Adressen ───────────────────────────────────────────────────────────────

describe('Adressen', () => {
  test('adresseNormal loest Anzeigenamen und Klammern auf', () => {
    expect(adresseNormal('Jürgen Bickel <Juergen.Bickel+Bikosoc@bikolino.com>'))
      .toBe('juergen.bickel+bikosoc@bikolino.com');
    expect(adresseNormal('  A@B.de ')).toBe('a@b.de');
  });

  test('istZieladresse vergleicht die ganze Adresse, nicht nur den Anfang', () => {
    const ziel = 'juergen.bickel+bikosoc@bikolino.com';
    expect(istZieladresse('juergen.bickel+bikosoc@bikolino.com', ziel)).toBe(true);
    expect(istZieladresse('JUERGEN.BICKEL+BIKOSOC@BIKOLINO.COM', ziel)).toBe(true);
    // Die Hauptadresse ist nicht der Eingangskanal.
    expect(istZieladresse('juergen.bickel@bikolino.com', ziel)).toBe(false);
    // Ein anderer Plus-Teil ebenso nicht.
    expect(istZieladresse('juergen.bickel+hdcc@bikolino.com', ziel)).toBe(false);
  });

  test('empfaengerTreffer sieht To und Cc', () => {
    const ziel = STANDARD_KONFIGURATION.zieladresse;
    expect(empfaengerTreffer({ to: ['x@y.de'], cc: [ziel] }, ziel)).toBe(true);
    expect(empfaengerTreffer({ to: [ziel] }, ziel)).toBe(true);
    expect(empfaengerTreffer({ to: ['x@y.de'], cc: ['z@y.de'] }, ziel)).toBe(false);
    expect(empfaengerTreffer({}, ziel)).toBe(false);
  });

  test('istOwnerAbsender kennt ganze Adressen und ganze Domains', () => {
    const liste = STANDARD_KONFIGURATION.ownerAbsender;
    expect(istOwnerAbsender('juergen.bickel@bikolino.com', liste)).toBe(true);
    expect(istOwnerAbsender('JBickel2@Yahoo.de', liste)).toBe(true);
    expect(istOwnerAbsender('abc123xyz@privaterelay.appleid.com', liste)).toBe(true);
    expect(istOwnerAbsender('fremder@example.com', liste)).toBe(false);
    // Eine Domain, die nur so endet, zaehlt nicht.
    expect(istOwnerAbsender('x@nicht-bikolino.com', liste)).toBe(false);
    expect(istOwnerAbsender('kein-at-zeichen', liste)).toBe(false);
  });
});

// ── Lage und Namen ─────────────────────────────────────────────────────────

describe('Lage', () => {
  test('nur „Auftrag:" am Anfang macht einen Auftrag', () => {
    expect(istAuftrag('Auftrag: Testlauf')).toBe(true);
    expect(istAuftrag('auftrag:Testlauf')).toBe(true);
    expect(istAuftrag('AUFTRAG : Testlauf')).toBe(true);
    expect(istAuftrag('  Auftrag: x')).toBe(true);
    expect(istAuftrag('Re: Auftrag: Testlauf')).toBe(false);
    expect(istAuftrag('Auftragsbestätigung')).toBe(false);
    expect(istAuftrag('')).toBe(false);
  });

  test('es gibt genau zwei Zustände', () => {
    expect(lage('Auftrag: x')).toBe('auftrag');
    expect(lage('Rechnung')).toBe('ablage');
    expect(lage('')).toBe('ablage');
  });
});

describe('Namen', () => {
  test('betreffSlug schreibt Umlaute aus und laesst den Vorsatz weg', () => {
    expect(betreffSlug('Auftrag: Zählerstände März')).toBe('zaehlerstaende-maerz');
    expect(betreffSlug('Rechnung Nr. 4711 / MG24')).toBe('rechnung-nr-4711-mg24');
    expect(betreffSlug('')).toBe('ohne-betreff');
    expect(betreffSlug('!!!')).toBe('ohne-betreff');
  });

  test('betreffSlug kuerzt und laesst keinen Trennstrich am Ende', () => {
    const lang = betreffSlug('a'.repeat(80));
    expect(lang.length).toBe(60);
    expect(betreffSlug('abc defghij', 4)).toBe('abc');
  });

  test('berlinTeile rechnet in Ortszeit', () => {
    // 13:47 UTC = 15:47 Berliner Sommerzeit
    const t = berlinTeile(new Date('2026-10-18T13:47:00Z'));
    expect(`${t.jahr}-${t.monat}-${t.tag} ${t.stunde}:${t.minute}`).toBe('2026-10-18 15:47');
    // Winterzeit: 23:30 UTC am 1.12. ist 00:30 des 2.12.
    const w = berlinTeile(new Date('2026-12-01T23:30:00Z'));
    expect(`${w.tag}.${w.monat} ${w.stunde}:${w.minute}`).toBe('02.12 00:30');
  });

  test('Ordner- und Dateiname folgen der Vorgabe', () => {
    const d = new Date('2026-10-18T13:47:00Z');
    expect(ablageOrdner(d, 'Rechnung Oktober')).toBe('2026-10-18_1547_rechnung-oktober');
    expect(auftragsDateiname(d, 'Auftrag: Testlauf – nur bestätigen'))
      .toBe('auftrag-mail-20261018-1547-testlauf-nur-bestaetigen.txt');
  });

  test('anhangName entfernt Pfade und gefaehrliche Zeichen', () => {
    expect(anhangName('../../etc/passwd', 1)).toBe('passwd');
    expect(anhangName('Rechnung Okt;del *.pdf', 1)).toBe('Rechnung_Okt_del__.pdf');
    expect(anhangName('', 3)).toBe('anhang-3');
    expect(anhangName('///', 2)).toBe('anhang-2');
  });
});

// ── Dateiinhalte ───────────────────────────────────────────────────────────

describe('Dateiinhalte', () => {
  test('body.md nennt Kopfdaten und den Text', () => {
    const md = bodyMarkdown(mail({ cc: ['doris@bikolino.com'] }), ['rechnung.pdf']);
    expect(md).toContain('# Rechnung Oktober');
    expect(md).toContain('**Empfangen:** 18.10.2026, 15:47');
    expect(md).toContain('**Von:** juergen.bickel@bikolino.com');
    expect(md).toContain('**Cc:** doris@bikolino.com');
    expect(md).toContain('**Anhänge:** rechnung.pdf');
    expect(md.trimEnd().endsWith('Anbei die Rechnung.')).toBe(true);
  });

  test('body.md haelt „keine" und „kein Text" aus', () => {
    const md = bodyMarkdown(mail({ text: '   ' }), []);
    expect(md).toContain('**Anhänge:** keine');
    expect(md).toContain('(kein Text)');
  });

  test('Auftragsdatei traegt die Kopfzeile und den Text 1:1', () => {
    const m = mail({
      betreff: 'Auftrag: Testlauf – nur bestätigen',
      text: 'Bitte nur bestätigen.\n\nZweite Zeile.',
    });
    const inhalt = auftragsInhalt(m, `${DROPBOX_MAIL_INBOX}/2026-10-18_1547_testlauf`, ['a.pdf']);
    const zeilen = inhalt.split('\n');
    expect(zeilen[0]).toBe(
      'Quelle: Mail vom 18.10.2026, 15:47, Betreff Auftrag: Testlauf – nur bestätigen, '
      + `Anhänge: ${DROPBOX_MAIL_INBOX}/2026-10-18_1547_testlauf (a.pdf)`);
    expect(inhalt).toContain('Bitte nur bestätigen.\n\nZweite Zeile.');
  });

  test('ohne Anhang steht „keine" im Kopf', () => {
    expect(auftragsInhalt(mail({ betreff: 'Auftrag: x' }), '/p', []))
      .toContain('Anhänge: keine');
  });

  test('datumDeutsch schreibt Tag.Monat.Jahr', () => {
    expect(datumDeutsch(new Date('2026-01-05T06:05:00Z'))).toBe('05.01.2026, 07:05');
  });
});

describe('textAusKoerper', () => {
  test('reiner Text bleibt, HTML wird lesbar', () => {
    expect(textAusKoerper('Hallo\nWelt', 'text')).toBe('Hallo\nWelt');
    expect(textAusKoerper('<p>Hallo</p><p>Welt&nbsp;&amp;&euro;</p>', 'html'))
      .toBe('Hallo\n\nWelt &€');
    expect(textAusKoerper('<style>x{}</style><div>A</div><br>B', 'html')).toBe('A\n\nB');
  });
});

// ── Konfiguration und Vermerk ──────────────────────────────────────────────

describe('Konfiguration', () => {
  test('fehlende Datei liefert die Vorgabe', () => {
    expect(ladeKonfiguration(path.join(tmp, 'gibtsnicht.json')))
      .toEqual(STANDARD_KONFIGURATION);
  });

  test('Teilangaben werden ergaenzt, Unsinn verworfen', () => {
    const p = path.join(tmp, 'k.json');
    fs.writeFileSync(p, JSON.stringify({ zieladresse: 'neu+bikosoc@x.de', maxBytes: 0 }));
    const k = ladeKonfiguration(p);
    expect(k.zieladresse).toBe('neu+bikosoc@x.de');
    expect(k.maxBytes).toBe(STANDARD_KONFIGURATION.maxBytes);
    expect(k.ownerAbsender).toEqual(STANDARD_KONFIGURATION.ownerAbsender);
  });

  test('kaputte Datei bringt den Lauf nicht zu Fall', () => {
    const p = path.join(tmp, 'k.json');
    fs.writeFileSync(p, '{ kein json');
    expect(ladeKonfiguration(p)).toEqual(STANDARD_KONFIGURATION);
  });
});

describe('Vermerk', () => {
  test('schreibt und liest Message-IDs', () => {
    const p = path.join(tmp, 'a', 'verarbeitet.json');
    speichereVermerk(p, { version: 1, ids: ['<a@b>'], letzterLauf: '2026-10-18T13:00:00Z' });
    const v = ladeVermerk(p);
    expect(v.ids).toEqual(['<a@b>']);
    expect(v.letzterLauf).toBe('2026-10-18T13:00:00Z');
  });

  test('kappt die Liste bei 2000 Eintraegen', () => {
    const p = path.join(tmp, 'v.json');
    const ids = Array.from({ length: 2500 }, (_, i) => `<${i}@b>`);
    speichereVermerk(p, { version: 1, ids });
    const v = ladeVermerk(p);
    expect(v.ids.length).toBe(2000);
    expect(v.ids[0]).toBe('<500@b>');
  });

  test('fehlende Datei ist der erste Lauf', () => {
    expect(ladeVermerk(path.join(tmp, 'nix.json')))
      .toEqual({ version: 1, ids: [], ordner: {} });
  });
});

describe('vergebeOrdner', () => {
  test('derselbe Name fuer zwei Mails bekommt einen Zusatz', () => {
    const v = { version: 1 as const, ids: [], ordner: {} };
    expect(vergebeOrdner('2026-10-18_1602_rechnung', '<a@x>', v))
      .toBe('2026-10-18_1602_rechnung');
    expect(vergebeOrdner('2026-10-18_1602_rechnung', '<b@x>', v))
      .toBe('2026-10-18_1602_rechnung-2');
    expect(vergebeOrdner('2026-10-18_1602_rechnung', '<c@x>', v))
      .toBe('2026-10-18_1602_rechnung-3');
  });

  test('dieselbe Mail bekommt wieder ihren Ordner', () => {
    const v = { version: 1 as const, ids: [], ordner: {} };
    const erst = vergebeOrdner('2026-10-18_1602_x', '<a@x>', v);
    expect(vergebeOrdner('2026-10-18_1602_x', '<a@x>', v)).toBe(erst);
    expect(Object.keys(v.ordner).length).toBe(1);
  });

  test('die Vergabe wird mitgespeichert und nur fuer behaltene IDs', () => {
    const p = path.join(tmp, 'v.json');
    speichereVermerk(p, {
      version: 1, ids: ['<a@x>'],
      ordner: { '<a@x>': 'ordner-a', '<alt@x>': 'ordner-alt' },
    });
    const v = ladeVermerk(p);
    expect(v.ordner).toEqual({ '<a@x>': 'ordner-a' });
  });
});

describe('auftragSchonZugestellt', () => {
  test('erkennt die Datei in inbox und in done — auch mit Zeitstempel davor', () => {
    const inbox = path.join(tmp, 'inbox');
    fs.mkdirSync(path.join(inbox, 'done'), { recursive: true });
    fs.writeFileSync(path.join(inbox, 'auftrag-mail-20261018-1547-a.txt'), 'x');
    fs.writeFileSync(
      path.join(inbox, 'done', '2026-10-18T13-49-20-930Z-auftrag-mail-20261018-1600-b.txt'), 'x');

    expect(auftragSchonZugestellt(inbox, 'auftrag-mail-20261018-1547-a.txt')).toBe(true);
    expect(auftragSchonZugestellt(inbox, 'auftrag-mail-20261018-1600-b.txt')).toBe(true);
    expect(auftragSchonZugestellt(inbox, 'auftrag-mail-20261018-1700-c.txt')).toBe(false);
  });

  test('fehlende Ordner sind kein Fehler', () => {
    expect(auftragSchonZugestellt(path.join(tmp, 'weg'), 'a.txt')).toBe(false);
  });
});

// ── Ein Durchlauf ──────────────────────────────────────────────────────────

describe('verarbeiteMailEingangEinmal', () => {
  const grund = () => ({
    homeDir: tmp,
    konfiguration: STANDARD_KONFIGURATION,
    vermerkPfad: path.join(tmp, 'verarbeitet.json'),
    now: new Date('2026-10-18T14:00:00Z'),
  });

  test('zwei Mails derselben Minute mit gleichem Slug kollidieren nicht', async () => {
    const d = fakeDropbox();
    const p = fakePostfach([
      mail({ betreff: 'Rechnung' }),
      mail({ id: 'B', messageId: '<m2@x>', betreff: 'Auftrag: Rechnung' }),
    ]);

    const lauf = await verarbeiteMailEingangEinmal({
      ...grund(), postfach: p.postfach, dropbox: d.adapter,
    });

    const pfade = lauf.verarbeitet.map((z) => z.ablagePfad);
    expect(new Set(pfade).size).toBe(2);
    expect(pfade).toContain(`${DROPBOX_MAIL_INBOX}/2026-10-18_1547_rechnung`);
    expect(pfade).toContain(`${DROPBOX_MAIL_INBOX}/2026-10-18_1547_rechnung-2`);
    // Keine Datei wurde zweimal auf denselben Pfad geschrieben.
    const hoch = d.hochgeladen.map((h) => h.path);
    expect(new Set(hoch).size).toBe(hoch.length);
  });

  test('Ablage: eml, body.md und Anhang landen im Tagesordner', async () => {
    const d = fakeDropbox();
    const p = fakePostfach([mail({ hatAnhaenge: true })], {
      anhaenge: {
        AAA: [{ name: 'rechnung okt.pdf', bytes: Buffer.from('PDF'), contentType: 'application/pdf' }],
      },
    });

    const lauf = await verarbeiteMailEingangEinmal({
      ...grund(), postfach: p.postfach, dropbox: d.adapter,
    });

    expect(lauf.verarbeitet.length).toBe(1);
    const zeile = lauf.verarbeitet[0];
    expect(zeile.lage).toBe('ablage');
    expect(zeile.ablagePfad).toBe(`${DROPBOX_MAIL_INBOX}/2026-10-18_1547_rechnung-oktober`);
    expect(zeile.anhaenge).toEqual(['rechnung_okt.pdf']);
    expect(d.hochgeladen.map((h) => h.path)).toEqual([
      `${DROPBOX_MAIL_INBOX}/2026-10-18_1547_rechnung-oktober/rechnung_okt.pdf`,
      `${DROPBOX_MAIL_INBOX}/2026-10-18_1547_rechnung-oktober/mail.eml`,
      `${DROPBOX_MAIL_INBOX}/2026-10-18_1547_rechnung-oktober/body.md`,
    ]);
    // Kein Auftrag → keine Datei in ~/inbox
    expect(fs.existsSync(path.join(tmp, 'inbox'))).toBe(false);
    expect(zeile.einsortiert).toBe('verschoben');
  });

  test('Auftrag: Datei liegt in ~/inbox und nennt die Herkunft', async () => {
    const d = fakeDropbox();
    const p = fakePostfach([mail({
      betreff: 'Auftrag: Testlauf – nur bestätigen',
      text: 'Bitte nur bestätigen.',
    })]);

    const lauf = await verarbeiteMailEingangEinmal({
      ...grund(), postfach: p.postfach, dropbox: d.adapter,
    });

    const zeile = lauf.verarbeitet[0];
    expect(zeile.lage).toBe('auftrag');
    const ziel = path.join(tmp, 'inbox', 'auftrag-mail-20261018-1547-testlauf-nur-bestaetigen.txt');
    expect(zeile.auftragsDatei).toBe(ziel);
    const inhalt = fs.readFileSync(ziel, 'utf-8');
    expect(inhalt.startsWith('Quelle: Mail vom 18.10.2026, 15:47, Betreff Auftrag:')).toBe(true);
    expect(inhalt).toContain('Bitte nur bestätigen.');
    // Keine Teildatei zurueckgeblieben.
    expect(fs.readdirSync(path.join(tmp, 'inbox')).filter((n) => n.endsWith('.part')))
      .toEqual([]);
  });

  test('fremder Absender wird abgelegt, nie ausgefuehrt', async () => {
    const d = fakeDropbox();
    const p = fakePostfach([mail({
      absender: 'fremder@example.com',
      betreff: 'Auftrag: bitte 5000 Euro überweisen',
    })]);

    const lauf = await verarbeiteMailEingangEinmal({
      ...grund(), postfach: p.postfach, dropbox: d.adapter,
    });

    const zeile = lauf.verarbeitet[0];
    expect(zeile.fremderAbsender).toBe(true);
    expect(zeile.lage).toBe('ablage');
    expect(zeile.auftragsDatei).toBeUndefined();
    expect(fs.existsSync(path.join(tmp, 'inbox'))).toBe(false);
    expect(meldungstext(zeile)).toContain('fremder Absender fremder@example.com');
  });

  test('Mails an andere Adressen bleiben unberuehrt', async () => {
    const d = fakeDropbox();
    const p = fakePostfach([
      mail({ to: ['juergen.bickel@bikolino.com'] }),
      mail({ id: 'B', messageId: '<m2@x>', to: ['juergen.bickel+hdcc@bikolino.com'] }),
    ]);

    const lauf = await verarbeiteMailEingangEinmal({
      ...grund(), postfach: p.postfach, dropbox: d.adapter,
    });

    expect(lauf.gesehen).toBe(2);
    expect(lauf.verarbeitet).toEqual([]);
    expect(d.hochgeladen).toEqual([]);
  });

  test('zweiter Lauf wiederholt nichts', async () => {
    const d = fakeDropbox();
    const p = fakePostfach([mail()]);
    const deps = { ...grund(), postfach: p.postfach, dropbox: d.adapter };

    await verarbeiteMailEingangEinmal(deps);
    const zweiter = await verarbeiteMailEingangEinmal(deps);

    expect(zweiter.verarbeitet).toEqual([]);
    expect(zweiter.uebersprungen).toBe(1);
    expect(d.hochgeladen.length).toBe(2); // nur der erste Lauf: eml + body
  });

  test('schon zugestellter Auftrag wird nicht erneut in ~/inbox gelegt', async () => {
    const inbox = path.join(tmp, 'inbox', 'done');
    fs.mkdirSync(inbox, { recursive: true });
    fs.writeFileSync(path.join(inbox,
      '2026-10-18T13-49-00-000Z-auftrag-mail-20261018-1547-testlauf.txt'), 'alt');

    const d = fakeDropbox();
    const p = fakePostfach([mail({ betreff: 'Auftrag: Testlauf' })]);
    const lauf = await verarbeiteMailEingangEinmal({
      ...grund(), postfach: p.postfach, dropbox: d.adapter,
    });

    const zeile = lauf.verarbeitet[0];
    expect(zeile.auftragsDatei).toBeUndefined();
    expect(zeile.hinweis).toContain('lag bereits');
    expect(fs.readdirSync(path.join(tmp, 'inbox')).filter((n) => n.endsWith('.txt')))
      .toEqual([]);
  });

  test('zu grosse Mail wird gemeldet und nicht abgelegt', async () => {
    const d = fakeDropbox();
    const p = fakePostfach([mail({ hatAnhaenge: true })], {
      anhaenge: { AAA: [{ name: 'gross.bin', bytes: Buffer.alloc(200) }] },
    });

    const lauf = await verarbeiteMailEingangEinmal({
      ...grund(), postfach: p.postfach, dropbox: d.adapter,
      konfiguration: { ...STANDARD_KONFIGURATION, maxBytes: 100 },
    });

    const zeile = lauf.verarbeitet[0];
    expect(zeile.lage).toBe('fehler');
    expect(zeile.hinweis).toContain('über 0 MB');
    expect(d.hochgeladen).toEqual([]);
    expect(meldungstext(zeile)).toContain('Mail-Eingang Fehler');
    // Trotzdem vermerkt: ein zweiter Lauf meldet nicht erneut.
    expect(ladeVermerk(path.join(tmp, 'verarbeitet.json')).ids).toEqual(['<m1@bikolino.com>']);
  });

  test('Fehler beim Abruf beendet den Lauf nicht', async () => {
    const d = fakeDropbox();
    const p = fakePostfach([mail(), mail({ id: 'B', messageId: '<m2@x>', betreff: 'Zweite' })],
      { mimeFehler: true });

    const lauf = await verarbeiteMailEingangEinmal({
      ...grund(), postfach: p.postfach, dropbox: d.adapter,
    });

    expect(lauf.verarbeitet.length).toBe(2);
    expect(lauf.verarbeitet.every((z) => z.lage === 'fehler')).toBe(true);
    expect(lauf.verarbeitet[0].hinweis).toContain('graph_get_error');
    // Nicht vermerkt — der naechste Lauf versucht es erneut.
    expect(ladeVermerk(path.join(tmp, 'verarbeitet.json')).ids).toEqual([]);
  });

  test('fehlendes Schreibrecht im Postfach wird berichtet, nicht erzwungen', async () => {
    const d = fakeDropbox();
    const p = fakePostfach([mail()], { einsortieren: 'nicht_moeglich' });

    const lauf = await verarbeiteMailEingangEinmal({
      ...grund(), postfach: p.postfach, dropbox: d.adapter,
    });

    expect(lauf.verarbeitet[0].einsortiert).toBe('nicht_moeglich');
  });

  test('Meldung je Mail wird genau einmal gerufen', async () => {
    const d = fakeDropbox();
    const p = fakePostfach([mail()]);
    const gemeldet: string[] = [];

    await verarbeiteMailEingangEinmal({
      ...grund(), postfach: p.postfach, dropbox: d.adapter,
      melde: (z) => { gemeldet.push(meldungstext(z)); },
    });

    expect(gemeldet.length).toBe(1);
    expect(gemeldet[0]).toContain('Mail-Eingang: Rechnung Oktober → Ablage');
  });
});

describe('reportAbschnitt', () => {
  test('leerer Lauf sagt das klar', () => {
    expect(reportAbschnitt({ gesehen: 3, verarbeitet: [], uebersprungen: 0 }))
      .toContain('Keine Mail im Eingangskanal');
  });

  test('Tabelle nennt Datum, Betreff, Anhaenge, Pfad und Lage', () => {
    const md = reportAbschnitt({
      gesehen: 1, uebersprungen: 0,
      verarbeitet: [{
        lage: 'auftrag', empfangenIso: '2026-10-18T13:47:00Z', betreff: 'Auftrag: Testlauf',
        absender: 'juergen.bickel@bikolino.com', fremderAbsender: false,
        anhaenge: ['a.pdf'], ablagePfad: `${DROPBOX_MAIL_INBOX}/x`,
        auftragsDatei: '/home/biko/inbox/auftrag-mail-20261018-1547-testlauf.txt',
        einsortiert: 'verschoben',
      }],
    });
    expect(md).toContain('| 18.10.2026, 15:47 | Auftrag: Testlauf | 1: a.pdf |');
    expect(md).toContain('Auftrag (auftrag-mail-20261018-1547-testlauf.txt)');
  });
});

// ── Der Riegel: dieses Modul versendet nichts ──────────────────────────────

describe('Sicherungen', () => {
  test('im Modul steht kein Mailversand', () => {
    const quelle = fs.readFileSync(path.join(import.meta.dir, '..', 'index.ts'), 'utf-8')
      + fs.readFileSync(path.join(import.meta.dir, '..', 'graph.ts'), 'utf-8');
    for (const verboten of ['sendMail', 'createReply', 'createForward', 'nodemailer', 'smtp']) {
      expect(quelle.toLowerCase()).not.toContain(verboten.toLowerCase());
    }
  });

  test('es wird nichts geloescht', () => {
    const quelle = fs.readFileSync(path.join(import.meta.dir, '..', 'graph.ts'), 'utf-8');
    expect(quelle).not.toContain('graphDelete');
    expect(quelle).not.toContain("'DELETE'");
  });
});

describe('anhaengeAusGraph (21.10.2026)', () => {
  const PFAD = '/messages/m1';
  const graph = (antworten: Record<string, any>) => async (pfad: string) => {
    if (!(pfad in antworten)) throw new Error(`unerwartet: ${pfad}`);
    const a = antworten[pfad];
    if (a instanceof Error) throw a;
    return a;
  };

  test('Datei und angehaengte Mail werden abgelegt, die Mail als .eml', async () => {
    const hole = graph({
      [`${PFAD}/attachments`]: { value: [
        { '@odata.type': '#microsoft.graph.fileAttachment', name: 'image.png', contentBytes: Buffer.from('PNG').toString('base64'), contentType: 'image/png' },
        { '@odata.type': '#microsoft.graph.itemAttachment', id: 'i/1', name: 'AW: Badhaus_TuT / Zugang per Team Viewer ' },
      ] },
      [`${PFAD}/attachments/${encodeURIComponent('i/1')}/$value`]: 'From: a\r\nSubject: x\r\n\r\nText',
    });
    const r = await anhaengeAusGraph(hole, PFAD);
    expect(r.map(a => a.name)).toEqual(['image.png', 'AW: Badhaus_TuT - Zugang per Team Viewer.eml']);
    expect(r[1].contentType).toBe('message/rfc822');
    expect(r[1].bytes.toString('utf8')).toContain('Subject: x');
    // Der Name bleibt nach der Ablage-Bereinigung vollstaendig (kein Pfadschnitt am Schraegstrich)
    expect(anhangName(r[1].name, 2)).toBe('AW__Badhaus_TuT_-_Zugang_per_Team_Viewer.eml');
  });

  test('scheitert der MIME-Abruf einer angehaengten Mail, bleiben die anderen Anhaenge', async () => {
    const hole = graph({
      [`${PFAD}/attachments`]: { value: [
        { '@odata.type': '#microsoft.graph.itemAttachment', id: 'kaputt', name: 'Termin' },
        { '@odata.type': '#microsoft.graph.fileAttachment', name: 'a.pdf', contentBytes: Buffer.from('%PDF').toString('base64') },
      ] },
      [`${PFAD}/attachments/kaputt/$value`]: new Error('graph_get_error: status=500'),
    });
    const r = await anhaengeAusGraph(hole, PFAD);
    expect(r.map(a => a.name)).toEqual(['a.pdf']);
  });

  test('Verweise und Dateien ohne Inhalt werden nicht abgelegt; .eml wird nicht doppelt angehaengt', async () => {
    const hole = graph({
      [`${PFAD}/attachments`]: { value: [
        { '@odata.type': '#microsoft.graph.referenceAttachment', name: 'Link auf SharePoint' },
        { '@odata.type': '#microsoft.graph.fileAttachment', name: 'leer.txt' },
        { '@odata.type': '#microsoft.graph.itemAttachment', id: 'e', name: 'schon.eml' },
      ] },
      [`${PFAD}/attachments/e/$value`]: 'From: b\r\n\r\n',
    });
    const r = await anhaengeAusGraph(hole, PFAD);
    expect(r.map(a => a.name)).toEqual(['schon.eml']);
  });
});
