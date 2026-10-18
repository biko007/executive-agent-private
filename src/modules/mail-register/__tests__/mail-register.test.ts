import { describe, expect, test, beforeEach, afterEach } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  herkunftAusKopf, originalDatum, eintragAus, ordnerUebergehen,
  ladeRegister, haengeAnRegister, registerCsv, belegCsv, belegEintraege,
  verarbeiteRegisterEinmal, reportAbschnitt,
  originalAbsenderAusText, ladeAblagestand, speichereAblagestand, ablageNoetig,
  vergebeAblageordner, legeAb,
  SAMMELSTELLE, PROTON_ORDNER, DROPBOX_REGISTER,
  type MailboxZugang, type RohMail, type RegisterEintrag, type Ablagestand,
} from '../index.js';
import { DROPBOX_MAIL_INBOX, STANDARD_KONFIGURATION } from '../../mail-eingang/index.js';
import type { DropboxAdapter } from '../../../adapters/dropbox.js';
import { kopfVerzeichnis } from '../graph.js';

// ── Doppel ─────────────────────────────────────────────────────────────────

/** Kopfzeilen einer echten Proton-Weiterleitung (18.10.2026, gekuerzt). */
const KOPF_WEITERGELEITET = {
  'x-pm-forwarded-from': 'jbickel2@protonmail.com',
  'x-original-to': 'jbickel2@protonmail.com',
  'return-path': 'jbickel2=protonmail.com+data=bikolino.com@forward.protonmail.ch',
  date: 'Sun, 18 Oct 2026 17:14:06 +0200',
};

/** Dieselbe Weiterleitung, aber ohne die Proton-eigene Kopfzeile. */
const KOPF_NUR_RUECKWEG = {
  'return-path': 'jbickel2=protonmail.com+data=bikolino.com@forward.protonmail.ch',
  date: 'Sun, 18 Oct 2026 17:14:06 +0200',
};

const KOPF_DIREKT = {
  'return-path': 'jbickel2@protonmail.com',
  date: 'Wed, 14 Oct 2026 12:52:47 +0000',
};

function mail(teil: Partial<RohMail> = {}): RohMail {
  return {
    id: 'AAA',
    messageId: '<m1@protonmail.com>',
    empfangenIso: '2026-10-18T15:14:00Z',
    absender: 'hello@hansdampf.pro',
    absenderName: 'Hans Dampf',
    betreff: 'Testmail',
    hatAnhaenge: false,
    kopf: KOPF_WEITERGELEITET,
    ...teil,
  };
}

function fakePostfach(
  ordner: Array<{ id: string; name: string; anzahl: number }>,
  mails: Record<string, RohMail[]>,
  opts?: {
    verschiebenScheitert?: boolean;
    anhaenge?: Record<string, string[]>;
    inhalte?: Record<string, Array<{ name: string; bytes: Buffer; contentType?: string }>>;
    text?: string;
  },
) {
  const bewegt: Array<{ id: string; ziel: string }> = [];
  const postfach: MailboxZugang = {
    async ordner() { return ordner; },
    async mails(id: string) { return mails[id] ?? []; },
    async anhangsnamen(id: string) { return opts?.anhaenge?.[id] ?? []; },
    async mime(id: string) { return `Message-ID: <${id}>\r\n\r\nRohnachricht.`; },
    async text() { return opts?.text ?? 'Weitergeleiteter Text.'; },
    async anhaenge(id: string) { return opts?.inhalte?.[id] ?? []; },
    async verschiebe(id: string, ziel: string) {
      if (opts?.verschiebenScheitert) return 'nicht_moeglich';
      bewegt.push({ id, ziel });
      return 'verschoben';
    },
  };
  return { postfach, bewegt };
}

/** Dropbox-Doppel: haelt die Uploads im Speicher. */
function fakeDropbox() {
  const hochgeladen: Array<{ path: string; text: string; bytes: number }> = [];
  const adapter: DropboxAdapter = {
    async uploadFile(p) {
      hochgeladen.push({ path: p.path, text: p.body.toString('utf-8'), bytes: p.body.length });
      return { ok: true } as any;
    },
    async uploadFileStream() { throw new Error('nicht verwendet'); },
    async createFolder() { /* der Upload legt an */ },
    async listFolder() { return []; },
    async downloadFile() { throw new Error('nicht verwendet'); },
    async moveFile() { throw new Error('nicht verwendet'); },
    async healthCheck() { return true; },
  };
  return { adapter, hochgeladen };
}

let tmp = '';
beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mailregister-')); });
afterEach(() => { fs.rmSync(tmp, { recursive: true, force: true }); });

// ── Herkunft ───────────────────────────────────────────────────────────────

describe('herkunftAusKopf', () => {
  test('X-Pm-Forwarded-From belegt die Weiterleitung', () => {
    const b = herkunftAusKopf(KOPF_WEITERGELEITET, 'hello@hansdampf.pro');
    expect(b.herkunft).toBe('proton');
    expect(b.weitergeleitetVon).toBe('jbickel2@protonmail.com');
    expect(b.beleg).toContain('X-Pm-Forwarded-From');
    expect(b.protonBezug).toBe(false);
  });

  test('der Rückweg über forward.protonmail.ch genügt auch allein', () => {
    const b = herkunftAusKopf(KOPF_NUR_RUECKWEG, 'rechnung@lieferant.de');
    expect(b.herkunft).toBe('proton');
    expect(b.weitergeleitetVon).toBe('jbickel2@protonmail.com');
    expect(b.beleg).toContain('Return-Path');
  });

  test('ein Absender bei Proton allein ist keine Weiterleitung', () => {
    const b = herkunftAusKopf(KOPF_DIREKT, 'jbickel2@protonmail.com');
    expect(b.herkunft).toBe('direkt');
    expect(b.weitergeleitetVon).toBeUndefined();
    // Der Bezug zu Proton wird trotzdem vermerkt.
    expect(b.protonBezug).toBe(true);
  });

  test('die Bestätigungsmail von Proton wird als Proton-Bezug erkannt', () => {
    const b = herkunftAusKopf(
      { 'return-path': 'no-reply+data=bikolino.com@mail.proton.me' },
      'no-reply@mail.proton.me');
    expect(b.herkunft).toBe('direkt');
    expect(b.protonBezug).toBe(true);
  });

  test('ohne Kopfzeilen bleibt es bei direkt', () => {
    const b = herkunftAusKopf({}, 'irgendwer@example.com');
    expect(b.herkunft).toBe('direkt');
    expect(b.protonBezug).toBe(false);
  });

  test('Großschreibung der Kopfzeilennamen schadet nicht', () => {
    const b = herkunftAusKopf({ 'X-Pm-Forwarded-From': 'jbickel2@protonmail.com' } as any,
      'a@b.de');
    expect(b.herkunft).toBe('proton');
  });
});

describe('originalDatum', () => {
  test('nimmt die Kopfzeile Date, nicht das Eintreffdatum', () => {
    expect(originalDatum(KOPF_WEITERGELEITET, '2026-10-18T15:14:00Z'))
      .toBe('2026-10-18T15:14:06.000Z');
    // 17:14:06 +0200 ist 15:14:06 UTC — das Original, nicht die Annahme.
    expect(originalDatum({ date: 'Wed, 14 Oct 2026 12:52:47 +0000' }, '2026-10-18T15:00:00Z'))
      .toBe('2026-10-14T12:52:47.000Z');
  });

  test('fällt auf das Eintreffdatum zurück', () => {
    expect(originalDatum({}, '2026-10-18T15:14:00Z')).toBe('2026-10-18T15:14:00Z');
    expect(originalDatum({ date: 'völliger Unsinn' }, '2026-10-18T15:14:00Z'))
      .toBe('2026-10-18T15:14:00Z');
  });
});

describe('kopfVerzeichnis', () => {
  test('schreibt Schlüssel klein und fasst Mehrfachzeilen zusammen', () => {
    const v = kopfVerzeichnis([
      { name: 'Received', value: 'von A' },
      { name: 'received', value: 'von B' },
      { name: 'X-Pm-Forwarded-From', value: 'jbickel2@protonmail.com' },
    ]);
    expect(v['received']).toBe('von A\nvon B');
    expect(v['x-pm-forwarded-from']).toBe('jbickel2@protonmail.com');
  });

  test('hält leere Eingaben aus', () => {
    expect(kopfVerzeichnis(undefined)).toEqual({});
    expect(kopfVerzeichnis([{ value: 'ohne Namen' }])).toEqual({});
  });
});

describe('ordnerUebergehen', () => {
  test('Gelöschtes, Junk, Entwürfe und Postausgang bleiben draußen', () => {
    for (const n of ['Deleted Items', 'Gelöschte Elemente', 'Junk Email', 'Drafts',
      'Entwürfe', 'Outbox', 'Conversation History']) {
      expect(ordnerUebergehen(n)).toBe(true);
    }
  });

  test('Posteingang, Archiv und Proton gehören ins Register', () => {
    for (const n of ['Inbox', 'Archive', 'Proton', 'Sent Items']) {
      expect(ordnerUebergehen(n)).toBe(false);
    }
  });
});

// ── Eintrag ────────────────────────────────────────────────────────────────

describe('eintragAus', () => {
  test('behält ursprünglichen Absender und Originaldatum', () => {
    const e = eintragAus(mail(), 'Inbox', [], '2026-10-18T15:20:00Z');
    expect(e.quelle).toBe('data');
    expect(e.herkunft).toBe('proton');
    expect(e.weitergeleitetVon).toBe('jbickel2@protonmail.com');
    // Der Originalabsender wird nicht durch die Weiterleitungsadresse ersetzt.
    expect(e.absender).toBe('hello@hansdampf.pro');
    expect(e.originalIso).toBe('2026-10-18T15:14:06.000Z');
    expect(e.empfangenIso).toBe('2026-10-18T15:14:00Z');
  });

  test('ordnet nach derselben Mechanik wie das Postfachregister ein', () => {
    const r = eintragAus(mail({ betreff: 'Rechnung 4711 zur Police' }), 'Inbox', [],
      '2026-10-18T15:20:00Z');
    expect(r.register).toContain('rechnungen');
    expect(r.register).toContain('versicherungen');
    expect(r.ausschluss).toBeNull();

    const v = eintragAus(mail({ betreff: 'Dienstleistungsvertrag Nachtrag' }), 'Inbox', [],
      '2026-10-18T15:20:00Z');
    expect(v.register).toContain('vertraege');
  });

  test('Gesundheitspost und Rundschreiben fallen aus den Registern', () => {
    const g = eintragAus(mail({ betreff: 'Rechnung der Zahnarztpraxis' }), 'Inbox', [],
      '2026-10-18T15:20:00Z');
    expect(g.ausschluss).toBe('gesundheit');
    expect(g.register).toEqual([]);

    const n = eintragAus(mail({ betreff: 'Newsletter Oktober' }), 'Inbox', [],
      '2026-10-18T15:20:00Z');
    expect(n.ausschluss).toBe('newsletter');
  });

  test('Anhangsnamen werden übernommen', () => {
    const e = eintragAus(mail({ hatAnhaenge: true }), 'Inbox', ['rechnung.pdf'],
      '2026-10-18T15:20:00Z');
    expect(e.anhaenge).toEqual(['rechnung.pdf']);
  });
});

// ── Registerdatei ──────────────────────────────────────────────────────────

describe('Registerdatei', () => {
  test('hängt an und liest zurück', () => {
    const p = path.join(tmp, 'tief', 'data.jsonl');
    const e1 = eintragAus(mail(), 'Inbox', [], '2026-10-18T15:20:00Z');
    const e2 = eintragAus(mail({ messageId: '<m2@x>', betreff: 'Zweite' }), 'Inbox', [],
      '2026-10-18T15:21:00Z');
    haengeAnRegister(p, [e1]);
    haengeAnRegister(p, [e2]);
    const stand = ladeRegister(p);
    expect(stand.eintraege.length).toBe(2);
    expect(stand.eintraege.map((e) => e.messageId)).toEqual(['<m1@protonmail.com>', '<m2@x>']);
  });

  test('leere Liste schreibt keine Datei', () => {
    const p = path.join(tmp, 'leer.jsonl');
    haengeAnRegister(p, []);
    expect(fs.existsSync(p)).toBe(false);
    expect(ladeRegister(p).eintraege).toEqual([]);
  });

  test('kaputte Zeile bringt den Lauf nicht zu Fall', () => {
    const p = path.join(tmp, 'kaputt.jsonl');
    fs.writeFileSync(p, '{kein json}\n');
    expect(ladeRegister(p).eintraege).toEqual([]);
  });
});

describe('registerCsv', () => {
  test('Kopfzeile, Sortierung nach Originaldatum und maskierte Trennzeichen', () => {
    const alt = eintragAus(mail({ messageId: '<alt@x>', kopf: KOPF_DIREKT,
      absender: 'jbickel2@protonmail.com', betreff: 'Alt; mit "Zeichen"' }), 'Inbox', [],
      '2026-10-18T15:20:00Z');
    const neu = eintragAus(mail(), 'Inbox', ['a.pdf'], '2026-10-18T15:20:00Z');
    const csv = registerCsv([neu, alt]);
    const zeilen = csv.trim().split('\n');
    expect(zeilen[0]).toBe('quelle;herkunft;weitergeleitet_von;proton_bezug;ordner;'
      + 'original_datum;empfangen;absender;absender_name;betreff;register;ausschluss;anhaenge');
    // 14.10. steht vor 18.10.
    expect(zeilen[1]).toContain('2026-10-14');
    expect(zeilen[1]).toContain('"Alt; mit ""Zeichen"""');
    expect(zeilen[2]).toContain('proton;jbickel2@protonmail.com;nein');
    expect(zeilen[2]).toContain('a.pdf');
  });
});

describe('belegEintraege', () => {
  test('nimmt Rechnungen, Verträge und Versicherungen — sonst nichts', () => {
    const e = [
      eintragAus(mail({ messageId: '<1@x>', betreff: 'Rechnung 4711' }), 'Inbox', [], 'j'),
      eintragAus(mail({ messageId: '<2@x>', betreff: 'Mietvertrag' }), 'Inbox', [], 'j'),
      eintragAus(mail({ messageId: '<3@x>', betreff: 'Versicherungsschein' }), 'Inbox', [], 'j'),
      eintragAus(mail({ messageId: '<4@x>', betreff: 'Zahlungserinnerung' }), 'Inbox', [], 'j'),
      eintragAus(mail({ messageId: '<5@x>', betreff: 'Testmail' }), 'Inbox', [], 'j'),
      eintragAus(mail({ messageId: '<6@x>', betreff: 'Rechnung der Praxis' }), 'Inbox', [], 'j'),
    ];
    const b = belegEintraege(e);
    expect(b.map((x) => x.messageId)).toEqual(['<1@x>', '<2@x>', '<3@x>']);
    // Die Gesundheitsrechnung bleibt draußen, die reine Zahlungserinnerung auch.
    expect(belegCsv(e).trim().split('\n').length).toBe(4);
  });
});

// ── Ein Durchlauf ──────────────────────────────────────────────────────────

describe('verarbeiteRegisterEinmal', () => {
  const ordner = [
    { id: 'inbox', name: 'Inbox', anzahl: 2 },
    { id: 'del', name: 'Deleted Items', anzahl: 7 },
    { id: 'proton', name: PROTON_ORDNER, anzahl: 0 },
  ];

  test('registriert, verschiebt Proton-Post und übergeht Gelöschtes', async () => {
    const p = fakePostfach(ordner, {
      inbox: [
        mail(),
        mail({ id: 'B', messageId: '<direkt@x>', kopf: KOPF_DIREKT,
          absender: 'jbickel2@protonmail.com', betreff: 'Ausführlicher Test' }),
      ],
    });
    const registerPfad = path.join(tmp, 'data.jsonl');

    const lauf = await verarbeiteRegisterEinmal({ postfach: p.postfach, registerPfad });

    expect(lauf.mailsGesehen).toBe(2);
    expect(lauf.neu.length).toBe(2);
    expect(lauf.ordnerGesehen).toBe(2);              // Inbox und Proton
    expect(lauf.uebergangen).toEqual([{ name: 'Deleted Items', anzahl: 7 }]);
    // Nur die weitergeleitete Nachricht wandert.
    expect(p.bewegt).toEqual([{ id: 'AAA', ziel: PROTON_ORDNER }]);
    expect(lauf.verschoben).toBe(1);
    const proton = lauf.neu.find((e) => e.herkunft === 'proton')!;
    expect(proton.ordner).toBe(PROTON_ORDNER);       // Eintrag nennt den Zielordner
    expect(ladeRegister(registerPfad).eintraege.length).toBe(2);
  });

  test('zweiter Lauf registriert nichts doppelt', async () => {
    const p = fakePostfach(ordner, { inbox: [mail()] });
    const registerPfad = path.join(tmp, 'data.jsonl');

    await verarbeiteRegisterEinmal({ postfach: p.postfach, registerPfad });
    const zweiter = await verarbeiteRegisterEinmal({ postfach: p.postfach, registerPfad });

    expect(zweiter.neu).toEqual([]);
    expect(zweiter.bekannt).toBe(1);
    expect(ladeRegister(registerPfad).eintraege.length).toBe(1);
  });

  test('wer schon im Proton-Ordner liegt, wird nicht erneut verschoben', async () => {
    const p = fakePostfach(ordner, { proton: [mail()] });
    await verarbeiteRegisterEinmal({
      postfach: p.postfach, registerPfad: path.join(tmp, 'data.jsonl'),
    });
    expect(p.bewegt).toEqual([]);
  });

  test('--ohne-verschieben lässt alles liegen', async () => {
    const p = fakePostfach(ordner, { inbox: [mail()] });
    const lauf = await verarbeiteRegisterEinmal({
      postfach: p.postfach, registerPfad: path.join(tmp, 'data.jsonl'), verschieben: false,
    });
    expect(p.bewegt).toEqual([]);
    expect(lauf.verschoben).toBe(0);
    expect(lauf.neu[0].ordner).toBe('Inbox');
  });

  test('fehlendes Schreibrecht wird gezählt, der Eintrag bleibt', async () => {
    const p = fakePostfach(ordner, { inbox: [mail()] }, { verschiebenScheitert: true });
    const registerPfad = path.join(tmp, 'data.jsonl');
    const lauf = await verarbeiteRegisterEinmal({ postfach: p.postfach, registerPfad });
    expect(lauf.nichtVerschoben).toBe(1);
    expect(lauf.verschoben).toBe(0);
    expect(ladeRegister(registerPfad).eintraege.length).toBe(1);
    expect(ladeRegister(registerPfad).eintraege[0].ordner).toBe('Inbox');
  });

  test('Anhangsnamen werden nur bei Anhang geholt', async () => {
    const p = fakePostfach(ordner,
      { inbox: [mail({ hatAnhaenge: true })] },
      { anhaenge: { AAA: ['police.pdf'] } });
    const lauf = await verarbeiteRegisterEinmal({
      postfach: p.postfach, registerPfad: path.join(tmp, 'data.jsonl'),
    });
    expect(lauf.neu[0].anhaenge).toEqual(['police.pdf']);
  });
});

describe('reportAbschnitt', () => {
  test('nennt Zahlen, Herkunft und Register', () => {
    const e = eintragAus(mail({ betreff: 'Rechnung 4711' }), 'Inbox', [], 'j');
    const md = reportAbschnitt({
      ordnerGesehen: 2, mailsGesehen: 5, neu: [e], bekannt: 4,
      verschoben: 1, nichtVerschoben: 0,
      uebergangen: [{ name: 'Deleted Items', anzahl: 7 }],
    }, 5);
    expect(md).toContain('5 Nachrichten im Register, davon 1 in diesem Lauf neu');
    expect(md).toContain('| proton | hello@hansdampf.pro | Rechnung 4711 | rechnungen |');
    expect(md).toContain('Übergangen: Deleted Items (7)');
  });
});

// ── Ablage in Dropbox (Owner-Regel 18.10.2026) ─────────────────────────────

describe('originalAbsenderAusText', () => {
  test('liest die Von-Zeile einer Outlook-Weiterleitung', () => {
    const text = 'Hallo,\n\nVon: Matthias Bauser <matthias.bauser@bikolino.com>\n'
      + 'Gesendet: Sonntag, 18. Oktober 2026 15:26\nAn: Jürgen Bickel\nBetreff: AW: Zählerfragen';
    expect(originalAbsenderAusText(text)).toBe('matthias.bauser@bikolino.com');
  });

  test('kommt auch mit „From:" und blanker Adresse zurecht', () => {
    expect(originalAbsenderAusText('From: absender@example.com\nSubject: x'))
      .toBe('absender@example.com');
  });

  test('ohne Adresse bleibt der Name, ohne Von-Zeile kommt null', () => {
    expect(originalAbsenderAusText('Von: Matthias Bauser')).toBe('Matthias Bauser');
    expect(originalAbsenderAusText('Nur ein Text ohne Kopfzeile')).toBeNull();
    expect(originalAbsenderAusText('')).toBeNull();
  });
});

describe('Ablagestand', () => {
  test('schreibt und liest die Ordnervergabe', () => {
    const p = path.join(tmp, 'a', 'ablage.json');
    speichereAblagestand(p, { version: 1, ordner: { '<a@x>': '2026-10-18_2017_test' } });
    expect(ladeAblagestand(p).ordner).toEqual({ '<a@x>': '2026-10-18_2017_test' });
  });

  test('fehlende und kaputte Datei ergeben einen leeren Stand', () => {
    expect(ladeAblagestand(path.join(tmp, 'weg.json'))).toEqual({ version: 1, ordner: {} });
    const p = path.join(tmp, 'kaputt.json');
    fs.writeFileSync(p, 'kein json');
    expect(ladeAblagestand(p)).toEqual({ version: 1, ordner: {} });
  });
});

describe('ablageNoetig', () => {
  const leer: Ablagestand = { version: 1, ordner: {} };

  test('Proton-Weiterleitungen bleiben draußen', () => {
    const proton = eintragAus(mail(), 'Inbox', [], 'j');
    expect(proton.herkunft).toBe('proton');
    expect(ablageNoetig(proton, leer)).toBe(false);
  });

  test('direkt zugestellte Post gehört in die Ablage — aber nur einmal', () => {
    const direkt = eintragAus(mail({ kopf: KOPF_DIREKT, absender: 'juergen.bickel@bikolino.com' }),
      'Inbox', [], 'j');
    expect(ablageNoetig(direkt, leer)).toBe(true);
    expect(ablageNoetig(direkt, { version: 1, ordner: { [direkt.messageId]: 'schon-da' } }))
      .toBe(false);
  });
});

describe('vergebeAblageordner', () => {
  test('gleicher Name für zwei Nachrichten bekommt einen Zusatz', () => {
    const stand: Ablagestand = { version: 1, ordner: {} };
    expect(vergebeAblageordner('2026-10-18_2017_x', '<a@x>', stand)).toBe('2026-10-18_2017_x');
    stand.ordner['<a@x>'] = '2026-10-18_2017_x';
    expect(vergebeAblageordner('2026-10-18_2017_x', '<b@x>', stand)).toBe('2026-10-18_2017_x-2');
  });

  test('dieselbe Nachricht behält ihren Ordner', () => {
    const stand: Ablagestand = { version: 1, ordner: { '<a@x>': 'fester-ordner' } };
    expect(vergebeAblageordner('2026-10-18_2017_x', '<a@x>', stand)).toBe('fester-ordner');
  });
});

describe('legeAb', () => {
  const weiterleitung = () => mail({
    kopf: KOPF_DIREKT, absender: 'juergen.bickel@bikolino.com',
    absenderName: 'Jürgen Bickel', betreff: 'WG: Zählerfragen MG24 und N24',
    hatAnhaenge: true,
  });

  function deps(d: ReturnType<typeof fakeDropbox>, p: ReturnType<typeof fakePostfach>) {
    return {
      postfach: p.postfach, dropbox: d.adapter, homeDir: tmp,
      konfiguration: STANDARD_KONFIGURATION,
      ablageStandPfad: path.join(tmp, 'ablage.json'),
    };
  }

  test('legt Anhänge, mail.eml und body.md ab und nennt den Originalabsender', async () => {
    const d = fakeDropbox();
    const p = fakePostfach([], {}, {
      inhalte: { AAA: [{ name: 'bild datei.png', bytes: Buffer.from('PNG') }] },
      text: 'Von: Matthias Bauser <matthias.bauser@bikolino.com>\nBetreff: AW: Zählerfragen',
    });
    const m = weiterleitung();
    const e = eintragAus(m, 'Inbox', ['bild datei.png'], '2026-10-18T18:30:00Z');
    const stand: Ablagestand = { version: 1, ordner: {} };

    const erg = await legeAb(m, e, deps(d, p), stand);

    // Ordnername aus dem Eintreffzeitpunkt (15:14 UTC = 17:14 Berlin).
    const basis = `${DROPBOX_MAIL_INBOX}/2026-10-18_1714_wg-zaehlerfragen-mg24-und-n24`;
    expect(erg.ablagePfad).toBe(basis);
    expect(d.hochgeladen.map((h) => h.path)).toEqual([
      `${basis}/bild_datei.png`, `${basis}/mail.eml`, `${basis}/body.md`,
    ]);
    const body = d.hochgeladen.find((h) => h.path.endsWith('body.md'))!.text;
    expect(body).toContain('**Von:** juergen.bickel@bikolino.com');
    expect(body).toContain('**An:** data@bikolino.com');
    expect(body).toContain('**Ursprünglicher Absender:** matthias.bauser@bikolino.com');
    expect(erg.originalAbsender).toBe('matthias.bauser@bikolino.com');
    // Die Vergabe ist vermerkt.
    expect(stand.ordner[e.messageId]).toBe('2026-10-18_1714_wg-zaehlerfragen-mg24-und-n24');
    // Kein Auftrag → keine Datei in ~/inbox
    expect(fs.existsSync(path.join(tmp, 'inbox'))).toBe(false);
  });

  test('ohne erkennbaren Originalabsender steht das auch so da', async () => {
    const d = fakeDropbox();
    const p = fakePostfach([], {}, { text: 'Nur Text, keine Kopfzeile.' });
    const m = mail({ kopf: KOPF_DIREKT, absender: 'juergen.bickel@bikolino.com',
      betreff: 'Notiz', hatAnhaenge: false });
    const e = eintragAus(m, 'Inbox', [], 'j');
    await legeAb(m, e, deps(d, p), { version: 1, ordner: {} });
    expect(d.hochgeladen.find((h) => h.path.endsWith('body.md'))!.text)
      .toContain('**Ursprünglicher Absender:** nicht erkennbar');
  });

  test('„Auftrag:" vom Owner wird zugestellt', async () => {
    const d = fakeDropbox();
    const p = fakePostfach([], {}, {});
    const m = mail({ kopf: KOPF_DIREKT, absender: 'juergen.bickel@bikolino.com',
      betreff: 'Auftrag: Testlauf über data', hatAnhaenge: false });
    const e = eintragAus(m, 'Inbox', [], 'j');

    const erg = await legeAb(m, e, deps(d, p), { version: 1, ordner: {} });

    const ziel = path.join(tmp, 'inbox', 'auftrag-mail-20261018-1714-testlauf-ueber-data.txt');
    expect(erg.auftragsDatei).toBe(ziel);
    const inhalt = fs.readFileSync(ziel, 'utf-8');
    expect(inhalt.startsWith('Quelle: Mail vom 18.10.2026, 17:14, Betreff Auftrag:')).toBe(true);
    expect(fs.readdirSync(path.join(tmp, 'inbox')).filter((n) => n.endsWith('.part'))).toEqual([]);
  });

  test('„Auftrag:" von fremdem Absender wird nur abgelegt', async () => {
    const d = fakeDropbox();
    const p = fakePostfach([], {}, {});
    const m = mail({ kopf: KOPF_DIREKT, absender: 'fremder@example.com',
      betreff: 'Auftrag: bitte überweisen', hatAnhaenge: false });
    const e = eintragAus(m, 'Inbox', [], 'j');

    const erg = await legeAb(m, e, deps(d, p), { version: 1, ordner: {} });

    expect(erg.auftragsDatei).toBeUndefined();
    expect(erg.hinweis).toContain('fremder Absender');
    expect(fs.existsSync(path.join(tmp, 'inbox'))).toBe(false);
  });

  test('schon zugestellter Auftrag wird nicht wiederholt', async () => {
    const done = path.join(tmp, 'inbox', 'done');
    fs.mkdirSync(done, { recursive: true });
    fs.writeFileSync(path.join(done,
      '2026-10-18T18-00-00-000Z-auftrag-mail-20261018-1714-testlauf-ueber-data.txt'), 'alt');

    const d = fakeDropbox();
    const p = fakePostfach([], {}, {});
    const m = mail({ kopf: KOPF_DIREKT, absender: 'juergen.bickel@bikolino.com',
      betreff: 'Auftrag: Testlauf über data', hatAnhaenge: false });
    const erg = await legeAb(m, eintragAus(m, 'Inbox', [], 'j'), deps(d, p),
      { version: 1, ordner: {} });

    expect(erg.auftragsDatei).toBeUndefined();
    expect(erg.hinweis).toContain('lag bereits');
  });
});

describe('verarbeiteRegisterEinmal mit Ablage', () => {
  const ordner = [
    { id: 'inbox', name: 'Inbox', anzahl: 2 },
    { id: 'proton', name: PROTON_ORDNER, anzahl: 0 },
  ];

  function ablageDeps(d: ReturnType<typeof fakeDropbox>, nachtragenSeitIso?: string) {
    return {
      dropbox: d.adapter, homeDir: tmp, konfiguration: STANDARD_KONFIGURATION,
      ablageStandPfad: path.join(tmp, 'ablage.json'), nachtragenSeitIso,
    };
  }

  test('legt die Weiterleitung ab, die Proton-Post nicht', async () => {
    const d = fakeDropbox();
    const p = fakePostfach(ordner, {
      inbox: [
        mail({ id: 'WL', messageId: '<wl@x>', kopf: KOPF_DIREKT,
          absender: 'juergen.bickel@bikolino.com', betreff: 'WG: Bauser' }),
        mail({ id: 'PR', messageId: '<pr@x>' }),   // Proton-Weiterleitung
      ],
    }, { text: 'Von: matthias.bauser@bikolino.com' });

    const lauf = await verarbeiteRegisterEinmal({
      postfach: p.postfach, registerPfad: path.join(tmp, 'data.jsonl'),
      ablage: ablageDeps(d),
    });

    expect(lauf.neu.length).toBe(2);
    expect(lauf.abgelegt.length).toBe(1);
    expect(lauf.abgelegt[0].betreff).toBe('WG: Bauser');
    // Nur die drei Dateien der Weiterleitung, nichts von der Proton-Post.
    expect(d.hochgeladen.every((h) => h.path.includes('wg-bauser'))).toBe(true);
    // Die Proton-Post ist trotzdem registriert und verschoben.
    expect(p.bewegt).toEqual([{ id: 'PR', ziel: PROTON_ORDNER }]);
  });

  test('zweiter Lauf legt nichts erneut ab', async () => {
    const d = fakeDropbox();
    const p = fakePostfach(ordner, {
      inbox: [mail({ id: 'WL', messageId: '<wl@x>', kopf: KOPF_DIREKT,
        absender: 'juergen.bickel@bikolino.com', betreff: 'WG: Bauser' })],
    });
    const gleich = {
      postfach: p.postfach, registerPfad: path.join(tmp, 'data.jsonl'),
      ablage: ablageDeps(d),
    };
    await verarbeiteRegisterEinmal(gleich);
    const vorher = d.hochgeladen.length;
    const zweiter = await verarbeiteRegisterEinmal(gleich);
    expect(zweiter.abgelegt).toEqual([]);
    expect(d.hochgeladen.length).toBe(vorher);
  });

  test('--nachtragen holt schon registrierte Nachrichten nach', async () => {
    const registerPfad = path.join(tmp, 'data.jsonl');
    const d1 = fakeDropbox();
    const p = fakePostfach(ordner, {
      inbox: [mail({ id: 'WL', messageId: '<wl@x>', kopf: KOPF_DIREKT,
        absender: 'juergen.bickel@bikolino.com', betreff: 'WG: Bauser' })],
    });
    // Erster Lauf ohne Ablage — wie vor der Erweiterung.
    await verarbeiteRegisterEinmal({ postfach: p.postfach, registerPfad });
    expect(d1.hochgeladen).toEqual([]);

    const d2 = fakeDropbox();
    const lauf = await verarbeiteRegisterEinmal({
      postfach: p.postfach, registerPfad,
      ablage: ablageDeps(d2, '2026-10-01T00:00:00Z'),
    });

    expect(lauf.nachgetragen.length).toBe(1);
    expect(lauf.nachgetragen[0].betreff).toBe('WG: Bauser');
    expect(d2.hochgeladen.length).toBe(2);   // mail.eml und body.md, kein Anhang
    // Und nicht zweimal.
    const dritter = await verarbeiteRegisterEinmal({
      postfach: p.postfach, registerPfad,
      ablage: ablageDeps(d2, '2026-10-01T00:00:00Z'),
    });
    expect(dritter.nachgetragen).toEqual([]);
  });

  test('ohne Ablage-Deps bleibt alles wie vorher', async () => {
    const d = fakeDropbox();
    const p = fakePostfach(ordner, {
      inbox: [mail({ id: 'WL', messageId: '<wl@x>', kopf: KOPF_DIREKT,
        absender: 'juergen.bickel@bikolino.com', betreff: 'WG: Bauser' })],
    });
    const lauf = await verarbeiteRegisterEinmal({
      postfach: p.postfach, registerPfad: path.join(tmp, 'data.jsonl'),
    });
    expect(lauf.abgelegt).toEqual([]);
    expect(d.hochgeladen).toEqual([]);
  });
});

// ── Riegel ─────────────────────────────────────────────────────────────────

describe('Sicherungen', () => {
  test('das Modul versendet nichts und löscht nichts', () => {
    const quelle = fs.readFileSync(path.join(import.meta.dir, '..', 'index.ts'), 'utf-8')
      + fs.readFileSync(path.join(import.meta.dir, '..', 'graph.ts'), 'utf-8');
    for (const verboten of ['sendMail', 'createReply', 'createForward', 'nodemailer',
      'graphDelete', "'DELETE'"]) {
      expect(quelle).not.toContain(verboten);
    }
  });

  test('die Sammelstelle und die Ablagepfade stehen fest', () => {
    expect(SAMMELSTELLE).toBe('data@bikolino.com');
    expect(PROTON_ORDNER).toBe('Proton');
    expect(DROPBOX_REGISTER).toBe('/bikosoc-reports/transfer/postfach/data');
  });
});
