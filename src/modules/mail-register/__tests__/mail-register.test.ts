import { describe, expect, test, beforeEach, afterEach } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  herkunftAusKopf, originalDatum, eintragAus, ordnerUebergehen,
  ladeRegister, haengeAnRegister, registerCsv, belegCsv, belegEintraege,
  verarbeiteRegisterEinmal, reportAbschnitt,
  SAMMELSTELLE, PROTON_ORDNER, DROPBOX_REGISTER,
  type MailboxZugang, type RohMail, type RegisterEintrag,
} from '../index.js';
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
  opts?: { verschiebenScheitert?: boolean; anhaenge?: Record<string, string[]> },
) {
  const bewegt: Array<{ id: string; ziel: string }> = [];
  const postfach: MailboxZugang = {
    async ordner() { return ordner; },
    async mails(id: string) { return mails[id] ?? []; },
    async anhangsnamen(id: string) { return opts?.anhaenge?.[id] ?? []; },
    async verschiebe(id: string, ziel: string) {
      if (opts?.verschiebenScheitert) return 'nicht_moeglich';
      bewegt.push({ id, ziel });
      return 'verschoben';
    },
  };
  return { postfach, bewegt };
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
