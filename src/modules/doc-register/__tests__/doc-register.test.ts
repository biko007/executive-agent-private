import { describe, expect, test } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  bewerteDok, dokAusschluss, ladeDokRegeln, dokRegelnErgaenzen, dokKennung, STANDARD_DOK_REGELN,
} from '../relevanz.js';
import { dokLauf, ladeDokRegister, dokCsv } from '../lauf.js';
import {
  graphQuelle, dropboxQuelle, pfadAusReferenz, verzeichnisQuelle, spiegelZustand, type DokDatei, type DokQuelle,
} from '../quellen.js';
import { STANDARD_REGELN } from '../../mail-register/relevanz.js';
import type { DropboxAdapter, DropboxChangePage } from '../../../adapters/dropbox.js';

const R = STANDARD_REGELN;
const D = STANDARD_DOK_REGELN;
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'dok-'));

function datei(teil: Partial<DokDatei> = {}): DokDatei {
  return {
    quelle: 'dropbox', id: 'id:1', pfad: '/Austausch/2026-10-20_ZZ5 Rechnung Heilo.pdf',
    name: '2026-10-20_ZZ5 Rechnung Heilo.pdf', groesse: 220175,
    geaendertIso: '2026-10-27T07:45:00Z', hash: 'h1', ...teil,
  };
}

describe('Relevanz — Positivfälle (echte Dateien seit 18.10.2026)', () => {
  test('Rechnung mit Objektkürzel trotz Unterstrich → a, ZZ5', () => {
    const b = bewerteDok(datei(), R, D);
    expect(b.relevant).toBe(true);
    expect(b.vorschlag).toBe('a');
    expect(b.objekt).toBe('ZZ5');
  });

  test('Objekt aus dem Pfad (Marktgasse) und Rechnungsnummer RE_…', () => {
    const b = bewerteDok(datei({
      quelle: 'sharepoint', pfad: '/6-Marktgasse 24/Gebäudeakte/MG24/Koch Brennstoffe/2026/2026-10-21_MG24_RE_206157.pdf',
      name: '2026-10-21_MG24_RE_206157.pdf',
    }), R, D);
    expect(b.objekt).toBe('MG24');
    expect(b.vorschlag).toBe('a');
  });

  test('Protokoll/Servicebericht → b', () => {
    expect(bewerteDok(datei({ pfad: '/9.1-PV Zelterweg/Wartungen/Anlagenzustandprotokoll_ALZP.pdf', name: 'Anlagenzustandprotokoll_ALZP.pdf' }), R, D).vorschlag).toBe('b');
  });

  test('Genehmigung → d', () => {
    expect(bewerteDok(datei({ pfad: '/x/2026-10-20_Z5_Wasserrechtliche Genehmigung.pdf', name: '2026-10-20_Z5_Wasserrechtliche Genehmigung.pdf' }), R, D).vorschlag).toBe('d');
  });

  test('Stichwort nur auf Seite 1 des PDF', () => {
    const b = bewerteDok(datei({ pfad: '/Austausch/Scan_001.pdf', name: 'Scan_001.pdf' }), R, D,
      { text: 'Rechnung Nr. 4711\nLeistungsort Leutenbergstraße 19' });
    expect(b.relevant).toBe(true);
    expect(b.vorschlag).toBe('a');
    expect(b.objekt).toBe('L19');
    expect(b.textGenutzt).toBe(true);
  });

  test('jpg-Scan mit Stichwort im Namen ist ein Dokument', () => {
    expect(bewerteDok(datei({ pfad: '/Austausch/Lieferschein_Koch.jpg', name: 'Lieferschein_Koch.jpg' }), R, D).relevant).toBe(true);
  });

  test('nur Objekt, kein Stichwort → relevant, Vorschlag offen', () => {
    const b = bewerteDok(datei({ pfad: '/Austausch/2026-10-19_MG24 Erfuellungsnachweis.pdf', name: '2026-10-19_MG24 Erfuellungsnachweis.pdf' }), R, D);
    expect(b.relevant).toBe(true);
    expect(b.vorschlag).toBe('offen');
  });
});

describe('Relevanz — Negativfälle', () => {
  const faelle: Array<[string, Partial<DokDatei>, string, { kopie?: boolean; text?: string }?]> = [
    ['eigener Report-Kanal', { pfad: '/Apps/bikosoc-reports/transfer/mail-inbox/x/Rechnung.pdf', name: 'Rechnung.pdf' }, 'eigener Kanal/cc-Ablage'],
    ['cc-Ablage Reisen', { pfad: '/Austausch/reisen/done/x-rechnung.pdf', name: 'x-rechnung.pdf' }, 'eigener Kanal/cc-Ablage'],
    ['cc-Kopie L19-Anleitung', { pfad: '/Austausch/l19/enthaertung/L19_Anleitung.pdf', name: 'L19_Anleitung.pdf' }, 'eigener Kanal/cc-Ablage'],
    ['Kopie aus SharePoint', { pfad: '/Austausch/Vertrag.pdf', name: 'Vertrag.pdf' }, 'Kopie aus anderer Ablage', { kopie: true }],
    ['Office-Sperrdatei', { pfad: '/x/~$Rechnung.docx', name: '~$Rechnung.docx' }, 'System/temporär'],
    ['temporäre Datei', { pfad: '/x/Rechnung.pdf.part', name: 'Rechnung.pdf.part' }, 'System/temporär'],
    ['CSV ist kein Dokument', { pfad: '/x/rechnung.csv', name: 'rechnung.csv' }, 'Dateityp'],
    ['Foto im Kameraordner', { pfad: '/Camera Uploads/IMG_1234.jpg', name: 'IMG_1234.jpg' }, 'Foto'],
    ['Foto ohne Dokumentcharakter', { pfad: '/Austausch/IMG_1234.jpg', name: 'IMG_1234.jpg' }, 'Foto ohne Dokumentcharakter'],
    ['Gesundheit im Namen', { pfad: '/Scans/Arztrechnung.pdf', name: 'Arztrechnung.pdf' }, 'Gesundheit'],
    ['Gesundheit auf Seite 1', { pfad: '/Scans/2026-10-27_JB Beitragsrückerstattung.pdf', name: '2026-10-27_JB Beitragsrückerstattung.pdf' }, 'Gesundheit', { text: 'LKH Landeskrankenhilfe V.V.a.G. Beitragsrückerstattung' }],
    ['kein Merkmal', { pfad: '/FoTA/Adressliste.docx', name: 'Adressliste.docx' }, 'kein Merkmal'],
  ];
  for (const [name, teil, grund, opts] of faelle) {
    test(name, () => {
      const b = bewerteDok(datei(teil), R, D, opts ?? {});
      expect(b.relevant).toBe(false);
      expect(b.grund).toBe(grund);
    });
  }

  test('„Labor" in einem Servicebericht ist keine Gesundheitspost', () => {
    const b = bewerteDok(datei({ pfad: '/x/Servicebericht.pdf', name: 'Servicebericht.pdf' }), R, D,
      { text: 'Laborwerte Sole, Frostschutz geprüft' });
    expect(b.relevant).toBe(true);
  });

  test('dokAusschluss braucht keinen Inhalt', () => {
    expect(dokAusschluss({ name: 'a.zip', pfad: '/a.zip' }, D)).toBe('Dateityp');
    expect(dokAusschluss({ name: 'a.pdf', pfad: '/a.pdf' }, D)).toBeNull();
  });
});

describe('Regelwerk', () => {
  test('Block „dokumente" wird ergänzt, übrige Blöcke bleiben', () => {
    const p = path.join(tmp(), 'relevanz.json');
    fs.writeFileSync(p, JSON.stringify({ kontakte: [{ name: 'X', absender: '@x' }] }));
    expect(dokRegelnErgaenzen(p)).toBe(true);
    const roh = JSON.parse(fs.readFileSync(p, 'utf-8'));
    expect(roh.kontakte).toEqual([{ name: 'X', absender: '@x' }]);
    expect(roh.dokumente.typen).toBe(D.typen);
    expect(dokRegelnErgaenzen(p)).toBe(false);
  });

  test('Owner-Änderung wirkt, kaputte Regex fällt zurück', () => {
    const p = path.join(tmp(), 'relevanz.json');
    fs.writeFileSync(p, JSON.stringify({ dokumente: { ausschlussPfade: ['^/papa/', '(('], typen: '((' } }));
    const { regeln, warnungen } = ladeDokRegeln(p);
    expect(regeln.ausschlussPfade).toEqual(['^/papa/']);
    expect(regeln.typen).toBe(D.typen);
    expect(warnungen).toHaveLength(2);
    expect(bewerteDok(datei({ pfad: '/Papa/Rechnung.pdf', name: 'Rechnung.pdf' }), R, regeln).grund).toBe('eigener Kanal/cc-Ablage');
  });

  test('Kennung je Datei und Version', () => {
    expect(dokKennung(datei())).toMatch(/^d-[0-9a-f]{8}$/);
    expect(dokKennung(datei())).toBe(dokKennung(datei()));
    expect(dokKennung(datei({ hash: 'h2' }))).not.toBe(dokKennung(datei()));
  });
});

/** Fake-Quelle, die zaehlt, was aufgerufen wird. */
function fakeQuelle(seiten: DokDatei[][], inhalt = () => Buffer.from('%PDF')): DokQuelle & { aufrufe: string[] } {
  const aufrufe: string[] = [];
  let n = 0;
  return {
    name: 'dropbox', aufrufe,
    async aenderungen(stand) { aufrufe.push(`aenderungen:${stand}`); return { dateien: seiten[Math.min(n, seiten.length - 1)] ?? [], stand: `c${++n}` }; },
    async inhalt(d) { aufrufe.push(`inhalt:${d.pfad}`); return inhalt(); },
  };
}

describe('Register, Dedup über Hash, Stand', () => {
  const basis = { regeln: R, dokRegeln: D, ersteSeite: () => '' };

  test('ohne Stand und ohne Nachlauf: nur Stand setzen, nichts registrieren', async () => {
    const z = tmp();
    const q = fakeQuelle([[datei()]]);
    const e = await dokLauf({ ...basis, zustand: z, quellen: [q] });
    expect(e.neu).toHaveLength(0);
    expect(JSON.parse(fs.readFileSync(path.join(z, 'stand.json'), 'utf-8')).quellen.dropbox.stand).toBe('c1');
  });

  test('Nachlauf registriert ab 18.10., ältere Dateien nicht', async () => {
    const z = tmp();
    const q = fakeQuelle([[datei(), datei({ id: 'id:alt', geaendertIso: '2026-09-01T00:00:00Z' })]]);
    const e = await dokLauf({ ...basis, zustand: z, quellen: [q], nachlauf: true });
    expect(e.neu.map((x) => x.id)).toEqual(['id:1']);
    expect(e.relevant).toHaveLength(1);
    expect(ladeDokRegister(path.join(z, 'dropbox.jsonl'))).toHaveLength(1);
  });

  test('gleiche Datei, gleicher Hash: keine zweite Zeile; neuer Hash: Status geändert', async () => {
    const z = tmp();
    await dokLauf({ ...basis, zustand: z, quellen: [fakeQuelle([[datei()]])], nachlauf: true });
    const zwei = await dokLauf({ ...basis, zustand: z, quellen: [fakeQuelle([[datei()]])] });
    expect(zwei.neu).toHaveLength(0);
    const drei = await dokLauf({ ...basis, zustand: z, quellen: [fakeQuelle([[datei({ hash: 'h2' })]])] });
    expect(drei.neu).toHaveLength(1);
    expect(drei.neu[0].status).toBe('geaendert');
    expect(ladeDokRegister(path.join(z, 'dropbox.jsonl'))).toHaveLength(2);
  });

  test('Stundenlauf fragt mit dem gespeicherten Stand', async () => {
    const z = tmp();
    await dokLauf({ ...basis, zustand: z, quellen: [fakeQuelle([[]])] });
    const q = fakeQuelle([[]]);
    await dokLauf({ ...basis, zustand: z, quellen: [q] });
    expect(q.aufrufe[0]).toBe('aenderungen:c1');
  });

  test('erste Seite nicht lesbar: nicht registrieren, im nächsten Lauf nachholen', async () => {
    const z = tmp();
    const scan = datei({ id: 'id:scan', pfad: '/Austausch/Scan.pdf', name: 'Scan.pdf' });
    const q = fakeQuelle([[scan]], () => { throw new Error('netz'); });
    const e = await dokLauf({ ...basis, zustand: z, quellen: [q], nachlauf: true });
    expect(e.neu).toHaveLength(0);
    expect(e.hinweise.join(' ')).toContain('nicht vollständig lesbar');
    const ok = fakeQuelle([[]]);
    const zwei = await dokLauf({ ...basis, zustand: z, quellen: [ok], ersteSeite: () => 'Rechnung' });
    expect(zwei.neu.map((x) => x.id)).toEqual(['id:scan']);
    expect(zwei.relevant).toHaveLength(1);
  });

  test('Ausfall einer Quelle lässt ihren Stand unverändert', async () => {
    const z = tmp();
    await dokLauf({ ...basis, zustand: z, quellen: [fakeQuelle([[]])] });
    const kaputt: DokQuelle = { name: 'dropbox', async aenderungen() { throw new Error('weg'); }, async inhalt() { return Buffer.from(''); } };
    const e = await dokLauf({ ...basis, zustand: z, quellen: [kaputt] });
    expect(e.fehler[0]).toContain('nicht lesbar');
    expect(JSON.parse(fs.readFileSync(path.join(z, 'stand.json'), 'utf-8')).quellen.dropbox.stand).toBe('c1');
  });

  test('Probe schreibt nichts', async () => {
    const z = tmp();
    await dokLauf({ ...basis, zustand: z, quellen: [fakeQuelle([[datei()]])], nachlauf: true, probe: true });
    expect(fs.existsSync(path.join(z, 'stand.json'))).toBe(false);
    expect(fs.existsSync(path.join(z, 'dropbox.jsonl'))).toBe(false);
  });

  test('Kopie in Austausch über Größe und Endung erkannt', async () => {
    const z = tmp();
    const e = await dokLauf({ ...basis, zustand: z, quellen: [fakeQuelle([[datei()]])], nachlauf: true,
      kopieMerkmale: new Set(['220175.pdf']) });
    expect(e.relevant).toHaveLength(0);
    expect(e.zaehler['Kopie aus anderer Ablage']).toBe(1);
  });

  test('CSV mit Kopf und einer Zeile je Version', () => {
    const csv = dokCsv([{ ...datei(), erkanntIso: 'x', status: 'neu', relevant: true, grund: 'g', vorschlag: 'a', text: 'a) …', kennung: 'd-1' } as any]);
    expect(csv.split('\n')[0]).toContain('quelle;pfad;name');
    expect(csv.trim().split('\n')).toHaveLength(2);
  });
});

describe('nur lesend', () => {
  test('Graph: nur GET, Delta-Link als Stand', async () => {
    const urls: string[] = [];
    const q = graphQuelle('onedrive', '/users/x/drive', async (u) => {
      urls.push(u);
      return urls.length === 1
        ? { value: [{ id: 'a', name: 'R.pdf', size: 1, lastModifiedDateTime: '2026-10-20T00:00:00Z', file: { hashes: { quickXorHash: 'q' } }, parentReference: { driveId: 'dr' } }], '@odata.nextLink': 'next' }
        : { value: [{ id: 'f', name: 'Ordner', folder: {} }, { id: 'g', name: 'weg.pdf', file: {}, deleted: {} }], '@odata.deltaLink': 'delta-1' };
    }, async () => Buffer.from(''));
    const a = await q.aenderungen(null);
    expect(a.stand).toBe('delta-1');
    expect(a.dateien.map((d) => d.id)).toEqual(['a']);
    expect(a.dateien[0].hash).toBe('q');
    expect(urls[0]).toContain('/users/x/drive/root/delta');
  });

  test('Graph: Pfad aus parentReference', () => {
    expect(pfadAusReferenz('/drives/b!x/root:/N24/Mietverträge', 'a.pdf')).toBe('/N24/Mietverträge/a.pdf');
    expect(pfadAusReferenz('/drive/root:', 'a.pdf')).toBe('/a.pdf');
  });

  test('Dropbox: nur listChanges und downloadFile', async () => {
    const schreib: string[] = [];
    const nein = (n: string) => async () => { schreib.push(n); throw new Error('verboten'); };
    const seite: DropboxChangePage = {
      entries: [{ tag: 'file', id: 'id:1', pathLower: '/a.pdf', pathDisplay: '/A.pdf', name: 'A.pdf', size: 1, serverModified: '2026-10-20T00:00:00Z', contentHash: 'c' }],
      cursor: 'cur', hasMore: false,
    };
    const adapter = {
      uploadFile: nein('upload'), uploadFileStream: nein('stream'), createFolder: nein('mkdir'),
      moveFile: nein('move'), listFolder: async () => [], healthCheck: async () => true,
      downloadFile: async () => Buffer.from('%PDF'), listChanges: async () => seite,
    } as unknown as DropboxAdapter;
    const q = dropboxQuelle(adapter);
    const a = await q.aenderungen(null);
    await q.inhalt(a.dateien[0]);
    expect(a.stand).toBe('cur');
    expect(schreib).toEqual([]);
  });

  test('statisch: Quellen und Lauf ohne Schreibbefehl', () => {
    const wurzel = path.resolve(import.meta.dir, '..', '..', '..', '..');
    const code = (p: string) => fs.readFileSync(path.join(wurzel, p), 'utf-8')
      .replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
    const quellen = code('src/modules/doc-register/quellen.ts');
    expect(quellen).not.toMatch(/graphPost|graphPatch|graphDelete|uploadFile|moveFile|createFolder|method:\s*'(POST|PATCH|PUT|DELETE)'/);
    const lauf = code('src/modules/doc-register/lauf.ts');
    expect(lauf).not.toMatch(/moveFile|createFolder|graphPost|graphDelete/);
    /* uploadFile nur fuer die eigene CSV unter transfer/doc-register */
    expect((lauf.match(/uploadFile\(/g) ?? []).length).toBe(1);
    expect(lauf).toContain('DROPBOX_DOK_REGISTER');
  });
});

describe('iCloud-Spiegel (lokal, privat)', () => {
  function spiegel(): string {
    const w = tmp();
    fs.mkdirSync(path.join(w, 'Dokumente', 'L19'), { recursive: true });
    fs.writeFileSync(path.join(w, 'Dokumente', 'L19', 'Rechnung Maurer.pdf'), '%PDF');
    fs.writeFileSync(path.join(w, 'Dokumente', 'Alt.pdf.icloud'), 'platzhalter');
    fs.writeFileSync(path.join(w, '.DS_Store'), 'x');
    fs.writeFileSync(path.join(w, '.letzter-lauf'), '');
    fs.symlinkSync('/etc', path.join(w, 'ausbruch'));
    return w;
  }

  test('Scan: Platzhalter, Marker, .DS_Store und Symlinks bleiben draußen', async () => {
    const q = verzeichnisQuelle('icloud', spiegel());
    const a = await q.aenderungen(null);
    expect(a.dateien.map((d) => d.pfad)).toEqual(['/Dokumente/L19/Rechnung Maurer.pdf']);
    expect(a.dateien[0].hash).toMatch(/^4-\d+$/);
  });

  test('inhalt liest nur innerhalb des Spiegels', async () => {
    const w = spiegel();
    const q = verzeichnisQuelle('icloud', w);
    expect((await q.inhalt({ ...datei(), quelle: 'icloud', pfad: '/Dokumente/L19/Rechnung Maurer.pdf' })).toString()).toBe('%PDF');
    await expect(q.inhalt({ ...datei(), quelle: 'icloud', pfad: '/../../etc/passwd' })).rejects.toThrow('außerhalb');
  });

  test('Spiegelzustand: Marker vor Verzeichniszeit, Größe gezählt; fehlender Spiegel', () => {
    const w = spiegel();
    const alt = new Date('2026-10-20T10:00:00Z');
    fs.utimesSync(path.join(w, '.letzter-lauf'), alt, alt);
    const z = spiegelZustand(w);
    expect(z.vorhanden).toBe(true);
    expect(z.quelleZeitpunkt).toBe('marker');
    expect(z.letzterIso).toBe('2026-10-20T10:00:00.000Z');
    expect(z.groesseBytes).toBe(4);
    fs.unlinkSync(path.join(w, '.letzter-lauf'));
    expect(spiegelZustand(w).quelleZeitpunkt).toBe('verzeichnis');
    expect(spiegelZustand(path.join(w, 'gibtsnicht')).vorhanden).toBe(false);
  });

  test('privat: ohne Stand ab 18.10. registriert, keine CSV nach Dropbox, Spiegel unverändert', async () => {
    const w = spiegel();
    const neu = new Date('2026-10-26T10:00:00Z');
    fs.utimesSync(path.join(w, 'Dokumente', 'L19', 'Rechnung Maurer.pdf'), neu, neu);
    /* Stand des Spiegels: Liste je Ordner und mtime der Datei (ohne dem Symlink zu folgen). */
    const abbild = () => JSON.stringify([fs.readdirSync(w).sort(), fs.readdirSync(path.join(w, 'Dokumente')).sort(),
      fs.readdirSync(path.join(w, 'Dokumente', 'L19')), fs.statSync(path.join(w, 'Dokumente', 'L19', 'Rechnung Maurer.pdf')).mtimeMs]);
    const vorher = abbild();
    const uploads: string[] = [];
    const dropbox = { uploadFile: async (p: any) => { uploads.push(p.path); return { pathDisplay: '', size: 0, contentHash: '' }; } } as any;
    const z = tmp();
    const e = await dokLauf({ zustand: z, regeln: R, dokRegeln: D, quellen: [verzeichnisQuelle('icloud', w)],
      ersteSeite: () => '', dropbox });
    expect(e.relevant.map((x) => x.objekt)).toEqual(['L19']);
    expect(uploads).toEqual([]);
    expect(fs.existsSync(path.join(z, 'icloud.jsonl'))).toBe(true);
    expect(abbild()).toBe(vorher);
  });

  test('statisch: keine schreibende Dateioperation im Spiegelteil', () => {
    const wurzel = path.resolve(import.meta.dir, '..', '..', '..', '..');
    const quellen = fs.readFileSync(path.join(wurzel, 'src/modules/doc-register/quellen.ts'), 'utf-8')
      .replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
    expect(quellen).not.toMatch(/writeFile|appendFile|unlink|rmSync|rmdir|renameSync|mkdir|copyFile|utimes|chmod/);
  });
});

describe('Review-Befunde 27.10.2026', () => {
  const basis = { regeln: R, dokRegeln: D, ersteSeite: () => '' };

  test('eigene Uploads (Apps/bikosoc-reports) kommen nicht ins Register — keine Upload-Schleife', async () => {
    const z = tmp();
    const uploads: string[] = [];
    const dropbox = { uploadFile: async (p: any) => { uploads.push(p.path); return {}; } } as any;
    const eigen = datei({ id: 'id:csv', pfad: '/Apps/bikosoc-reports/transfer/doc-register/dropbox-register.csv', name: 'dropbox-register.csv' });
    const e = await dokLauf({ ...basis, zustand: z, quellen: [fakeQuelle([[eigen]])], nachlauf: true, dropbox });
    expect(e.neu).toHaveLength(0);
    expect(uploads).toEqual([]);
    expect(e.zaehler['eigener Kanal/cc-Ablage']).toBe(1);
  });

  test('Kopie gegen SharePoint-Datei desselben Laufs', async () => {
    const z = tmp();
    const sp: DokQuelle = { name: 'sharepoint', async aenderungen() { return { dateien: [datei({ quelle: 'sharepoint', id: 'sp1', pfad: '/Scans/2026-10-20_ZZ5 Rechnung Heilo.pdf', name: '2026-10-20_ZZ5 Rechnung Heilo.pdf' })], stand: 's' }; }, async inhalt() { return Buffer.from(''); } };
    const e = await dokLauf({ ...basis, zustand: z, quellen: [sp, fakeQuelle([[datei()]])], nachlauf: true, kopieMerkmale: new Set() });
    expect(e.relevant.map((x) => x.quelle)).toEqual(['sharepoint']);
    expect(e.zaehler['Kopie aus anderer Ablage']).toBe(1);
  });

  test('fehlender Pfad: nicht raten, nachholen', async () => {
    const z = tmp();
    const e = await dokLauf({ ...basis, zustand: z, quellen: [fakeQuelle([[datei({ pfad: '' })]])], nachlauf: true });
    expect(e.neu).toHaveLength(0);
    expect(JSON.parse(fs.readFileSync(path.join(z, 'stand.json'), 'utf-8')).nachholen.dropbox).toHaveLength(1);
  });

  test('neuere Version ersetzt den wartenden Eintrag der Nachholliste', async () => {
    const z = tmp();
    await dokLauf({ ...basis, zustand: z, quellen: [fakeQuelle([[datei({ pfad: '' })]])], nachlauf: true });
    const e = await dokLauf({ ...basis, zustand: z, quellen: [fakeQuelle([[datei({ hash: 'h2' })]])] });
    expect(e.neu.map((x) => x.hash)).toEqual(['h2']);
  });

  test('Graph: abgelaufener Stand (410) → neu von vorn', async () => {
    const urls: string[] = [];
    const q = graphQuelle('onedrive', '/users/x/drive', async (u) => {
      urls.push(u);
      if (u === 'alt') throw new Error('graph_get_error: status=410 body={"error":{"code":"resyncRequired"}}');
      return { value: [], '@odata.deltaLink': 'neu' };
    }, async () => Buffer.from(''));
    expect((await q.aenderungen('alt')).stand).toBe('neu');
    expect(urls[1]).toContain('/root/delta');
  });

  test('CSV: IBAN gekürzt, Gesundheit ohne Name und Pfad', () => {
    const zeile = (t: any) => ({ ...datei(), erkanntIso: 'x', status: 'neu', relevant: false, vorschlag: 'offen', text: '', kennung: 'd', ...t });
    const csv = dokCsv([zeile({ name: 'Überweisung DE89370400440532013000.pdf', grund: 'kein Merkmal' }),
      zeile({ name: 'Arztrechnung.pdf', pfad: '/Scans/Arztrechnung.pdf', grund: 'Gesundheit' })]);
    expect(csv).not.toContain('DE89370400440532013000');
    expect(csv).not.toContain('Arztrechnung');
    expect(csv).toContain('(Gesundheit)');
  });
});

describe('Nachschärfung 27.10.2026 — gleiche Regeln für Dokumente', () => {
  test('privater Beleg → Privatausgaben, Bestellung ohne Rechnung → nicht relevant', () => {
    const a = bewerteDok(datei({ pfad: '/Austausch/2026-10-25_Amazon Rechnung.pdf', name: '2026-10-25_Amazon Rechnung.pdf' }), R, D);
    expect(a.objekt).toBe('Privatausgaben');
    expect(a.vorschlag).toBe('a');
    expect(bewerteDok(datei({ pfad: '/Austausch/Vodafone Vertrag.pdf', name: 'Vodafone Vertrag.pdf' }), R, D).grund).toBe('Privatkauf ohne Rechnung');
  });

  test('Vereinsdateien (FoTA) → nicht relevant', () => {
    expect(bewerteDok(datei({ quelle: 'onedrive', pfad: '/FoTA/2025/2026-10-16_FoTA Einladung Mitgliederversammlung 2026.pdf', name: '2026-10-16_FoTA Einladung Mitgliederversammlung 2026.pdf' }), R, D, { text: 'Protokoll' }).grund).toBe('Verein/Social');
  });
});
