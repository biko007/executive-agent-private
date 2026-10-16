/**
 * Pfadbasis und Zugangswahl für Dropbox.
 *
 * Der Punkt, auf den es ankommt: Mit der neuen App „BikosOpenClawFA" sieht
 * bikosoc das ganze Konto. Dieselben Pfade, die im App-Ordner-Betrieb richtig
 * waren, zeigen dort woanders hin — eine Datei landete im Wurzelverzeichnis
 * statt im Reportordner. Der Adapter setzt deshalb die Basis davor und nimmt
 * sie aus den Antworten wieder heraus; der übrige Code merkt nichts davon.
 */
import { describe, test, expect } from 'bun:test';
import { createDropboxAdapter, DROPBOX_BASE } from '../dropbox.js';
import { dropboxZugang } from '../dropbox-zugang.js';

/** Fängt die Anfragen ab und gibt verwertbare Antworten zurück. */
function fetchAttrappe(aufrufe: { url: string; arg: any; body?: any }[]) {
  return (async (url: any, init: any) => {
    const u = String(url);
    const kopf = init?.headers?.['Dropbox-API-Arg'];
    let body: any = null;
    try { body = typeof init?.body === 'string' ? JSON.parse(init.body) : null; } catch { /* Formulardaten */ }
    aufrufe.push({ url: u, arg: kopf ? JSON.parse(kopf) : null, body });

    if (u.endsWith('/oauth2/token')) {
      return new Response(JSON.stringify({ access_token: 't', expires_in: 14400 }), { status: 200 });
    }
    if (u.includes('/files/upload')) {
      return new Response(JSON.stringify({
        path_display: `${DROPBOX_BASE}/bikosoc-reports/a.md`, size: 3, content_hash: 'x',
      }), { status: 200 });
    }
    if (u.includes('/files/list_folder')) {
      return new Response(JSON.stringify({
        entries: [{ '.tag': 'file', path_lower: `${DROPBOX_BASE.toLowerCase()}/bikosoc-reports/a.md`,
          path_display: `${DROPBOX_BASE}/bikosoc-reports/a.md`, name: 'a.md', size: 3 }],
        has_more: false,
      }), { status: 200 });
    }
    return new Response('{}', { status: 200 });
  }) as unknown as typeof fetch;
}

describe('Dropbox-Basis', () => {
  test('setzt die Basis vor jeden Pfad', async () => {
    const aufrufe: any[] = [];
    const a = createDropboxAdapter({
      appKey: 'k', refreshToken: 'r', basis: DROPBOX_BASE, fetchImpl: fetchAttrappe(aufrufe),
    });
    await a.uploadFile({ path: '/bikosoc-reports/a.md', body: Buffer.from('abc'), contentType: 'text/plain' });
    const hochladen = aufrufe.find(x => x.url.includes('/files/upload'));
    expect(hochladen.arg.path).toBe(`${DROPBOX_BASE}/bikosoc-reports/a.md`);
  });

  test('nimmt die Basis aus den Antworten wieder heraus', async () => {
    const aufrufe: any[] = [];
    const a = createDropboxAdapter({
      appKey: 'k', refreshToken: 'r', basis: DROPBOX_BASE, fetchImpl: fetchAttrappe(aufrufe),
    });
    const r = await a.uploadFile({ path: '/bikosoc-reports/a.md', body: Buffer.from('abc'), contentType: 'text/plain' });
    expect(r.pathDisplay).toBe('/bikosoc-reports/a.md');

    const liste = await a.listFolder('/bikosoc-reports');
    /* Entscheidend: Was hier herauskommt, muss wieder in moveFile oder
       downloadFile hineingegeben werden koennen, ohne doppeltes Praefix. */
    expect(liste[0].pathDisplay).toBe('/bikosoc-reports/a.md');
    expect(liste[0].pathLower).toBe('/bikosoc-reports/a.md');
  });

  test('praefixt nicht zweimal', async () => {
    const aufrufe: any[] = [];
    const a = createDropboxAdapter({
      appKey: 'k', refreshToken: 'r', basis: DROPBOX_BASE, fetchImpl: fetchAttrappe(aufrufe),
    });
    await a.downloadFile(`${DROPBOX_BASE}/bikosoc-reports/a.md`);
    const ruf = aufrufe.find(x => x.url.includes('/files/download'));
    expect(ruf.arg.path).toBe(`${DROPBOX_BASE}/bikosoc-reports/a.md`);
  });

  test('ohne Basis bleibt alles wie bisher', async () => {
    const aufrufe: any[] = [];
    const a = createDropboxAdapter({
      appKey: 'k', appSecret: 's', refreshToken: 'r', fetchImpl: fetchAttrappe(aufrufe),
    });
    await a.uploadFile({ path: '/bikosoc-reports/a.md', body: Buffer.from('abc'), contentType: 'text/plain' });
    const hochladen = aufrufe.find(x => x.url.includes('/files/upload'));
    expect(hochladen.arg.path).toBe('/bikosoc-reports/a.md');
  });

  test('ohne Secret wird kein client_secret gesendet', async () => {
    const gesendet: string[] = [];
    const f = (async (url: any, init: any) => {
      if (String(url).endsWith('/oauth2/token')) gesendet.push(String(init.body));
      return new Response(JSON.stringify({ access_token: 't', expires_in: 100 }), { status: 200 });
    }) as unknown as typeof fetch;
    const a = createDropboxAdapter({ appKey: 'k', refreshToken: 'r', fetchImpl: f });
    await a.createFolder('/x').catch(() => { /* Antwort ist leer, egal */ });
    expect(gesendet[0]).toContain('client_id=k');
    expect(gesendet[0]).not.toContain('client_secret');
  });
});

describe('Zugangswahl', () => {
  const neu: Record<string, string> = {
    DROPBOX_APP_KEY: '4fm8hxopf6s4yx3', DROPBOX_REFRESH_TOKEN: 'neu',
  };
  const alt: Record<string, string> = {
    EA_DROPBOX_APP_KEY: 'alt', EA_DROPBOX_APP_SECRET: 'geheim', EA_DROPBOX_REFRESH_TOKEN: 'alt',
  };

  test('die neue App hat Vorrang und bringt die Basis mit', () => {
    const z = dropboxZugang((k) => ({ ...alt, ...neu })[k]);
    expect(z?.app).toBe('BikosOpenClawFA');
    expect(z?.basis).toBe(DROPBOX_BASE);
  });

  test('ohne neue Werte bleibt die alte App und kein Praefix', () => {
    const z = dropboxZugang((k) => alt[k]);
    expect(z?.app).toBe('BikosOpenClaw');
    expect(z?.basis).toBe('');
  });

  test('halbe Angaben zaehlen nicht', () => {
    expect(dropboxZugang((k) => ({ DROPBOX_APP_KEY: '4fm8hxopf6s4yx3' })[k])).toBeNull();
    expect(dropboxZugang(() => null)).toBeNull();
    /* Leerzeichen in der Env-Datei duerfen nicht als Wert durchgehen. */
    expect(dropboxZugang((k) => ({ DROPBOX_APP_KEY: '  ', DROPBOX_REFRESH_TOKEN: '  ' })[k])).toBeNull();
  });
});
