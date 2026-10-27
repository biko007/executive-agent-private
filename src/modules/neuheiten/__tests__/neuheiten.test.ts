import { describe, expect, test } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { stundenReport, melde, freigabeZeilen, sperre, type NeuheitZeile } from '../bericht.js';
import { mailLauf, mailZeile } from '../mail-lauf.js';
import { STANDARD_REGELN } from '../../mail-register/relevanz.js';
import type { LeseQuelle } from '../../mail-register/lesend.js';
import type { RohMail } from '../../mail-register/types.js';

const mail: NeuheitZeile = {
  kennung: 'm-11111111', art: 'Mail', datum: '2026-10-26T19:04:02Z', quelle: 'juergen.bickel@',
  von: 'Matthias Bauser (matthias.bauser@bikolino.com)', titel: 'Fw: N24 Zählerstände', vorschlag: 'b',
  text: 'b) Zählerstände/Fakten in bikosoc einarbeiten (N24)',
};
const dok: NeuheitZeile = {
  kennung: 'd-22222222', art: 'Dok', datum: '2026-10-27T07:45:00Z', quelle: 'Dropbox', von: '/Austausch',
  titel: '2026-10-20_ZZ5 Rechnung Heilo.pdf', vorschlag: 'offen', text: 'Vorschlag offen',
};

describe('gemeinsamer Stundenreport', () => {
  test('Abschnitte Mails und Dokumente, je Zeile eine Freigabe', () => {
    const r = stundenReport({ mails: [mail], dokumente: [dok], jetzt: new Date('2026-10-27T11:07:00Z'), fehler: [] });
    expect(r).toContain('## Mails');
    expect(r).toContain('## Dokumente');
    expect(r).toContain('`Freigabe Mail m-11111111 b`');
    expect(r).toContain('`Freigabe Dok d-22222222 <a–f>`');
    expect(r).toContain('| Kennung | Geändert (UTC) | Ablage |');
  });

  test('leerer Abschnitt heißt „keine"', () => {
    const r = stundenReport({ mails: [], dokumente: [dok], jetzt: new Date(), fehler: ['x'] });
    expect(r).toMatch(/## Mails\n\nkeine/);
    expect(r).toContain('## Hinweis');
  });

  test('IBAN in einem Betreff wird gekürzt', () => {
    const r = stundenReport({ mails: [{ ...mail, titel: 'Zahlung DE89370400440532013000' }], dokumente: [], jetzt: new Date(), fehler: [] });
    expect(r).not.toContain('DE89370400440532013000');
    expect(r).toContain('DE89…3000');
  });

  test('Freigabezeilen chronologisch', () => {
    expect(freigabeZeilen([dok, { ...dok, kennung: 'd-0', datum: '2026-10-01T00:00:00Z' }])[0]).toContain('d-0');
  });
});

describe('Telegram-Sammelmeldung', () => {
  test('höchstens 12 Zeilen, Titel mit beiden Zahlen, Owner-DM (keine Rolle dev)', async () => {
    let body: any;
    await melde({ mails: Array(10).fill(mail), dokumente: Array(5).fill(dok), reportName: 'r.md', hochgeladen: true },
      async (b) => { body = b; return { ok: true, status: 200 }; });
    expect(body.titel).toBe('Neu: 10 Mail(s), 5 Dokument(e)');
    expect(body.zeilen).toHaveLength(13);
    expect(body.zeilen[12]).toBe('… und 3 weitere');
    expect(body.role).toBeUndefined();
    expect(body.fuss[0]).toContain('(Dropbox)');
  });

  test('Fehler des Meldewegs wird geworfen', async () => {
    await expect(melde({ mails: [mail], dokumente: [], reportName: 'r', hochgeladen: false },
      async () => ({ ok: false, status: 503 }))).rejects.toThrow('notify 503');
  });
});

describe('Sperre', () => {
  test('zweiter Lauf wird abgewiesen, tote Sperre übernommen', () => {
    const p = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'sp-')), 'x.lock');
    const frei = sperre(p)!;
    expect(sperre(p)).toBeNull();
    frei();
    fs.writeFileSync(p, '999999999');
    const zwei = sperre(p);
    expect(zwei).not.toBeNull();
    zwei!();
  });
});

describe('Mailteil als Funktion', () => {
  function quelle(mails: RohMail[]): LeseQuelle {
    return {
      async ordner() { return [{ id: 'in', name: 'Posteingang', anzahl: 0 }]; },
      async mails() { return mails; },
      async anhangsnamen() { return []; },
      async text() { return ''; },
      async gesendeteIds() { return []; },
      async schliessen() { /* */ },
    };
  }
  const roh: RohMail = {
    id: '1', messageId: '<z@b>', empfangenIso: '2026-10-26T19:04:02Z', absender: 'matthias.bauser@bikolino.com',
    absenderName: 'Matthias Bauser', betreff: 'Fw: N24 Zählerstände', hatAnhaenge: false, kopf: {},
  };

  test('liefert Vorschläge, schreibt Register und Bewertung; zweiter Lauf meldet nichts erneut', async () => {
    const z = fs.mkdtempSync(path.join(os.tmpdir(), 'ml-'));
    const opts = { zustand: z, regeln: STANDARD_REGELN, env: () => '', quellen: [{ name: 'm365' as const, zugang: () => quelle([roh]) }] };
    const a = await mailLauf(opts);
    expect(a.vorschlaege).toHaveLength(1);
    expect(mailZeile(a.vorschlaege[0]).text).toContain('b)');
    expect(fs.existsSync(path.join(z, 'm365.jsonl'))).toBe(true);
    const b = await mailLauf(opts);
    expect(b.vorschlaege).toHaveLength(0);
  });
});

describe('Frühwarnung in der Meldung', () => {
  test('Hinweis steht vorn, auch ohne Neuheiten', async () => {
    let body: any;
    await melde({ mails: [], dokumente: [], reportName: 'r.md', hochgeladen: true,
      hinweise: ['iCloud-Spiegel steht seit 2026-10-25 08:00 UTC'] }, async (b) => { body = b; return { ok: true, status: 200 }; });
    expect(body.zeilen[0]).toBe('⚠ iCloud-Spiegel steht seit 2026-10-25 08:00 UTC');
  });
});
