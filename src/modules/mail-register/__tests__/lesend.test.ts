import { describe, expect, test } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  registriereLesend, nurLesendGraph, bekannteIdsAus, ordnerAusgeschlossen, kopfAusRoh, textTeil,
  type LeseQuelle,
} from '../lesend.js';
import { ladeRegister, haengeAnRegister, eintragAus } from '../index.js';
import type { MailboxZugang, RohMail } from '../types.js';

function mail(id: string, mid: string, teil: Partial<RohMail> = {}): RohMail {
  return {
    id, messageId: mid, empfangenIso: '2026-10-26T19:04:02Z', absender: 'matthias.bauser@bikolino.com',
    absenderName: 'Matthias Bauser', betreff: 'Fw: N24 Zählerstände', hatAnhaenge: false, kopf: {}, ...teil,
  };
}

function quelle(ordner: Record<string, RohMail[]>): LeseQuelle & { aufrufe: string[] } {
  const aufrufe: string[] = [];
  return {
    aufrufe,
    async ordner() { aufrufe.push('ordner'); return Object.keys(ordner).map((n) => ({ id: n, name: n, anzahl: 0 })); },
    async mails(id, seit) { aufrufe.push(`mails:${id}:${seit}`); return ordner[id] ?? []; },
    async anhangsnamen() { aufrufe.push('anhangsnamen'); return ['a.pdf']; },
    async text() { aufrufe.push('text'); return ''; },
    async gesendeteIds() { return []; },
    async schliessen() { /* nichts */ },
  };
}

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'lesend-'));

describe('Dedup über Message-ID', () => {
  test('eine über Proton/data@ registrierte Mail wird nicht doppelt geschrieben', async () => {
    const dir = tmp();
    const data = path.join(dir, 'data.jsonl');
    haengeAnRegister(data, [eintragAus(mail('d1', '<ggf@gmail.com>'), 'Proton', [], '2026-10-21T06:30:00Z')]);
    const m365 = path.join(dir, 'm365.jsonl');
    const bekannte = bekannteIdsAus([data, m365]);
    const lauf = await registriereLesend({
      quelle: 'm365', registerPfad: m365, bekannteIds: bekannte, seitIso: '2026-10-18T00:00:00Z',
      postfach: quelle({ Posteingang: [mail('g1', '<ggf@gmail.com>'), mail('g2', '<neu@bikolino.com>')] }),
    });
    expect(lauf.doppelt).toBe(1);
    expect(lauf.neu.map((e) => e.messageId)).toEqual(['<neu@bikolino.com>']);
    expect(ladeRegister(m365).eintraege).toHaveLength(1);
    /* Die doppelte Mail ist trotzdem „gesehen" — die Relevanzprüfung braucht sie. */
    expect(lauf.gesehen).toHaveLength(2);
  });

  test('dieselbe Mail in M365 und Yahoo (cc an beide) nur einmal', async () => {
    const dir = tmp();
    const bekannte = new Set<string>();
    const a = await registriereLesend({
      quelle: 'm365', registerPfad: path.join(dir, 'm365.jsonl'), bekannteIds: bekannte,
      seitIso: '2026-10-18T00:00:00Z', postfach: quelle({ Posteingang: [mail('1', '<x@y>')] }),
    });
    const b = await registriereLesend({
      quelle: 'yahoo', registerPfad: path.join(dir, 'yahoo.jsonl'), bekannteIds: bekannte,
      seitIso: '2026-10-18T00:00:00Z', postfach: quelle({ INBOX: [mail('INBOX\u00001', '<x@y>')] }),
    });
    expect(a.neu).toHaveLength(1);
    expect(b.neu).toHaveLength(0);
    expect(b.doppelt).toBe(1);
  });

  test('ein zweiter Lauf schreibt nichts erneut', async () => {
    const dir = tmp();
    const p = path.join(dir, 'm365.jsonl');
    const q = quelle({ Posteingang: [mail('1', '<a@b>'), mail('2', '<c@d>')] });
    await registriereLesend({ quelle: 'm365', registerPfad: p, bekannteIds: bekannteIdsAus([p]), seitIso: 's', postfach: q });
    const zwei = await registriereLesend({ quelle: 'm365', registerPfad: p, bekannteIds: bekannteIdsAus([p]), seitIso: 's', postfach: q });
    expect(zwei.neu).toHaveLength(0);
    expect(ladeRegister(p).eintraege).toHaveLength(2);
    expect(ladeRegister(p).eintraege[0].quelle).toBe('m365');
  });
});

describe('Ordner', () => {
  test('Gelöscht, Junk, Entwürfe, Postausgang und Gesendet werden übergangen', () => {
    for (const n of ['Gelöschte Elemente', 'Junk-E-Mail', 'Entwürfe', 'Postausgang', 'Gesendete Elemente',
      'Sent', 'Deleted Items']) expect(ordnerAusgeschlossen(n), n).toBe(true);
    for (const n of ['Posteingang', 'Posteingang/Ablage', 'Posteingang/Clockin', 'INBOX', 'Lesestoff']) {
      expect(ordnerAusgeschlossen(n), n).toBe(false);
    }
  });

  test('übergangene Ordner werden gar nicht abgefragt', async () => {
    const q = quelle({ Posteingang: [], 'Gesendete Elemente': [mail('s', '<s@x>')], 'Junk-E-Mail': [] });
    const lauf = await registriereLesend({ quelle: 'm365', registerPfad: path.join(tmp(), 'r.jsonl'),
      bekannteIds: new Set(), seitIso: '2026-10-18T00:00:00Z', postfach: q });
    expect(lauf.ordnerGesehen).toBe(1);
    expect(q.aufrufe.filter((a) => a.startsWith('mails:'))).toEqual(['mails:Posteingang:2026-10-18T00:00:00Z']);
  });
});

describe('nur lesend — Graph', () => {
  /** Ein Graph-Zugang, dessen schreibende Methoden laut scheitern. */
  function graphFake(): MailboxZugang & { schreib: string[] } {
    const schreib: string[] = [];
    return {
      schreib,
      async ordner() { return [{ id: 'in', name: 'Posteingang', anzahl: 1 }]; },
      async mails() { return [mail('1', '<a@b>', { hatAnhaenge: true })]; },
      async anhangsnamen() { return ['x.pdf']; },
      async text() { return 'Text'; },
      async mime() { schreib.push('mime'); throw new Error('nicht erlaubt'); },
      async anhaenge() { schreib.push('anhaenge'); throw new Error('nicht erlaubt'); },
      async verschiebe() { schreib.push('verschiebe'); throw new Error('nicht erlaubt'); },
    };
  }
  const z = { tenantId: 't', clientId: 'c', clientSecret: 's', postfach: 'juergen.bickel@bikolino.com' };

  test('der Wrapper hat keine Methode zum Verschieben oder Ablegen', () => {
    const q = nurLesendGraph(graphFake(), z, async () => ({ value: [] }));
    expect(Object.keys(q).sort()).toEqual(['anhangsnamen', 'gesendeteIds', 'mails', 'ordner', 'schliessen', 'text']);
    expect((q as any).verschiebe).toBeUndefined();
    expect((q as any).mime).toBeUndefined();
    expect((q as any).anhaenge).toBeUndefined();
  });

  test('ein voller Lauf ruft nichts Schreibendes auf', async () => {
    const g = graphFake();
    const q = nurLesendGraph(g, z, async () => ({ value: [] }));
    const lauf = await registriereLesend({ quelle: 'm365', registerPfad: path.join(tmp(), 'r.jsonl'),
      bekannteIds: new Set(), seitIso: '2026-10-18T00:00:00Z', postfach: q });
    await q.text('1');
    expect(lauf.neu).toHaveLength(1);
    expect(g.schreib).toEqual([]);
  });

  test('gesendete IDs kommen aus sentitems, nur per GET', async () => {
    const urls: string[] = [];
    const q = nurLesendGraph(graphFake(), z, async (u) => {
      urls.push(u);
      return urls.length === 1
        ? { value: [{ internetMessageId: '<a@b>' }], '@odata.nextLink': 'https://graph/next' }
        : { value: [{ internetMessageId: '<c@d>' }] };
    });
    expect(await q.gesendeteIds('2026-08-01T00:00:00Z')).toEqual(['<a@b>', '<c@d>']);
    expect(urls[0]).toContain('/mailFolders/sentitems/messages');
    expect(urls[0]).toContain('juergen.bickel%40bikolino.com');
  });
});

describe('nur lesend — statische Prüfung', () => {
  const wurzel = path.resolve(import.meta.dir, '..', '..', '..', '..');
  const lesend = fs.readFileSync(path.join(wurzel, 'src', 'modules', 'mail-register', 'lesend.ts'), 'utf-8');
  /* Der Stundenlauf steht seit dem Dokumenten-Register (27.10.2026) in
     neuheiten/mail-lauf.ts, das Skript ist scripts/neuheiten-stunde.ts. */
  const skript = fs.readFileSync(path.join(wurzel, 'src', 'modules', 'neuheiten', 'mail-lauf.ts'), 'utf-8')
    + fs.readFileSync(path.join(wurzel, 'scripts', 'neuheiten-stunde.ts'), 'utf-8');
  const code = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');

  test('IMAP: kein verändernder Befehl in lesend.ts', () => {
    for (const verboten of ['messageFlagsAdd', 'messageFlagsSet', 'messageFlagsRemove', 'messageMove',
      'messageDelete', 'messageCopy', '.append(', 'mailboxCreate', 'mailboxDelete', 'setFlagColor']) {
      expect(code(lesend), verboten).not.toContain(verboten);
    }
  });

  test('IMAP: jeder Ordner wird nur lesend geöffnet', () => {
    const sperren = code(lesend).match(/getMailboxLock\([^)]*\)/g) ?? [];
    expect(sperren.length).toBeGreaterThan(0);
    for (const s of sperren) expect(s).toContain('readOnly: true');
    expect(code(lesend)).not.toContain('mailboxOpen');
  });

  test('Graph: kein POST/PATCH/DELETE in lesend.ts', () => {
    expect(code(lesend)).not.toMatch(/graphPost|graphPatch|graphDelete|method:\s*'(POST|PATCH|DELETE)'/);
  });

  test('Stundenlauf: kein Verschieben, keine Ablage, kein Versand', () => {
    for (const verboten of ['verschiebe', 'legeAb', 'verarbeiteRegisterEinmal', 'graphPost', 'sendMail',
      'DROPBOX_MAIL_INBOX', 'mail-inbox']) {
      expect(code(skript), verboten).not.toContain(verboten);
    }
  });
});

describe('Hilfen', () => {
  test('Kopfzeilen aus Rohtext, Folgezeilen angehängt', () => {
    const k = kopfAusRoh('List-Unsubscribe: <mailto:a>,\r\n <https://b>\r\nIn-Reply-To: <x@y>\r\n');
    expect(k['list-unsubscribe']).toBe('<mailto:a>, <https://b>');
    expect(k['in-reply-to']).toBe('<x@y>');
  });

  test('Textteil: plain vor html, Anhang übersprungen', () => {
    expect(textTeil({ type: 'text/plain' })).toEqual({ part: '1', html: false });
    expect(textTeil({ childNodes: [{ type: 'text/html', part: '1' }, { type: 'text/plain', part: '2' }] }))
      .toEqual({ part: '2', html: false });
    expect(textTeil({ childNodes: [{ type: 'text/plain', part: '2', disposition: 'attachment' }, { type: 'text/html', part: '3' }] }))
      .toEqual({ part: '3', html: true });
    expect(textTeil({ childNodes: [{ type: 'application/pdf', part: '2' }] })).toBeNull();
  });
});
