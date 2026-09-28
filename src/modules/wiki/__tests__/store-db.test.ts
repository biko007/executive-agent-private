/**
 * Store-Tests — Roundtrip, Revisionen, Suche, Anhänge.
 *
 * Läuft gegen eine frische Test-Datenbank (C1 Test-DB-Isolation).
 */
import { describe, expect, test, beforeAll, afterAll } from 'bun:test';
import { setupTestDb } from './test-db-setup.js';

let cleanup: () => Promise<void>;
let store: typeof import('../store.js');

beforeAll(async () => {
  const setup = await setupTestDb();
  cleanup = setup.cleanup;
  store = await import('../store.js');
});

afterAll(async () => {
  if (cleanup) await cleanup();
});

describe('Seiten anlegen und lesen', () => {
  test('createPage legt Seite mit Revision 1 an', async () => {
    const page = await store.createPage({
      title: 'Gartenhaus',
      bodyMd: 'Das Gartenhaus wurde 2015 errichtet. Die Fenster werden alle zwei Monate geputzt.',
      category: 'Haus Neuhausen',
      author: 'test',
    });
    expect(page.slug).toBe('gartenhaus');
    expect(page.latestRev).toBe(1);
    expect(page.source).toBe('local');
    expect(page.sensitive).toBe(false);

    const revisions = await store.listRevisions('gartenhaus');
    expect(revisions.length).toBe(1);
    expect(revisions[0].rev).toBe(1);
    expect(revisions[0].author).toBe('test');
  });

  test('gleicher Titel erhält einen lesbaren Zweitslug', async () => {
    const first = await store.createPage({ title: 'Doppelt', bodyMd: 'a' });
    const second = await store.createPage({ title: 'Doppelt', bodyMd: 'b' });
    expect(first.slug).toBe('doppelt');
    expect(second.slug).toBe('doppelt-2');
  });

  test('getPageBySlug liefert null für unbekannte Seiten', async () => {
    expect(await store.getPageBySlug('gibt-es-nicht')).toBeNull();
  });
});

describe('Speichern erzeugt Revisionen', () => {
  test('jedes Speichern zählt die Revision hoch', async () => {
    await store.createPage({ title: 'Heizung', bodyMd: 'Erste Fassung', author: 'test' });

    await store.savePage('heizung', { title: 'Heizung', bodyMd: 'Zweite Fassung', author: 'biko' });
    await store.savePage('heizung', { title: 'Heizung neu', bodyMd: 'Dritte Fassung', author: 'biko' });

    const page = await store.getPageBySlug('heizung');
    expect(page?.latestRev).toBe(3);
    expect(page?.bodyMd).toBe('Dritte Fassung');
    expect(page?.title).toBe('Heizung neu');

    const revisions = await store.listRevisions('heizung');
    expect(revisions.map((r) => r.rev)).toEqual([3, 2, 1]);

    const first = await store.getRevision('heizung', 1);
    expect(first?.bodyMd).toBe('Erste Fassung');
    const second = await store.getRevision('heizung', 2);
    expect(second?.bodyMd).toBe('Zweite Fassung');
  });

  test('alte Revisionen bleiben unverändert erhalten', async () => {
    const first = await store.getRevision('heizung', 1);
    expect(first?.bodyMd).toBe('Erste Fassung');
  });

  test('Speichern einer unbekannten Seite schlägt fehl', async () => {
    await expect(
      store.savePage('gibt-es-nicht', { title: 'x', bodyMd: 'y' }),
    ).rejects.toThrow();
  });

  test('getRevision liefert null für unbekannte Revision', async () => {
    expect(await store.getRevision('heizung', 99)).toBeNull();
  });
});

describe('Import-Pfad', () => {
  test('upsertImportedPage ist idempotent und legt nur eine Revision an', async () => {
    const input = {
      slug: 'sauna',
      title: 'Sauna',
      category: 'Haus Neuhausen',
      bodyMd: 'Die Sauna steht im Keller.',
      sourceMarkup: '!!Sauna\nDie Sauna steht im Keller.',
      sensitive: false,
      sourcePageName: 'Sauna',
      sourceAuthor: 'JuergenBickel',
      sourceModifiedAt: new Date('2016-03-04T09:00:00Z'),
    };

    const firstId = await store.upsertImportedPage(input);
    const secondId = await store.upsertImportedPage({ ...input, bodyMd: 'Korrigierter Text.' });
    expect(secondId).toBe(firstId);

    const page = await store.getPageBySlug('sauna');
    expect(page?.bodyMd).toBe('Korrigierter Text.');
    expect(page?.source).toBe('nuveon');
    expect(page?.sourceAuthor).toBe('JuergenBickel');
    expect(page?.sourcePageName).toBe('Sauna');
    expect(page?.latestRev).toBe(1);

    const revisions = await store.listRevisions('sauna');
    expect(revisions.length).toBe(1);
  });

  test('Originalmarkup wird mitgespeichert', async () => {
    const page = await store.getPageBySlug('sauna');
    expect(page?.sourceMarkup).toContain('!!Sauna');
  });

  test('erneuter Import ueberschreibt eine Dashboard-Bearbeitung nicht stillschweigend', async () => {
    // Importstand anlegen (Rev 1)
    const input = {
      slug: 'terrasse',
      title: 'Terrasse',
      category: 'Haus Neuhausen',
      bodyMd: 'Importierter Stand.',
      sourceMarkup: '!!Terrasse',
      sensitive: false,
      sourcePageName: 'Terrasse',
      sourceAuthor: 'nuveon',
      sourceModifiedAt: new Date('2016-06-01T08:00:00Z'),
    };
    await store.upsertImportedPage(input);
    expect((await store.getPageBySlug('terrasse'))?.latestRev).toBe(1);

    // Owner bearbeitet im Dashboard → Rev 2
    await store.savePage('terrasse', {
      title: 'Terrasse', bodyMd: 'Vom Owner ergaenzt.', author: 'dashboard',
    });
    expect((await store.getPageBySlug('terrasse'))?.latestRev).toBe(2);

    // Erneuter Importlauf: Importstand wird als Rev 3 angehaengt, nicht als
    // stille Ersetzung. Die Bearbeitung bleibt in Rev 2 nachvollziehbar.
    await store.upsertImportedPage(input);
    const page = await store.getPageBySlug('terrasse');
    expect(page?.latestRev).toBe(3);
    expect(page?.bodyMd).toBe('Importierter Stand.');

    const rev2 = await store.getRevision('terrasse', 2);
    expect(rev2?.bodyMd).toBe('Vom Owner ergaenzt.');
    const rev3 = await store.getRevision('terrasse', 3);
    expect(rev3?.bodyMd).toBe('Importierter Stand.');
    expect(rev3?.author).toBe('nuveon');
  });
});

describe('Anhänge', () => {
  test('upsertAttachment ist idempotent je Seite und Dateiname', async () => {
    const pageId = await store.getPageIdBySlug('sauna');
    expect(pageId).not.toBeNull();

    const first = await store.upsertAttachment({
      pageId: pageId as number,
      filename: 'sauna-anleitung.pdf',
      mime: 'application/pdf',
      size: 204800,
      sha256: 'b'.repeat(64),
      path: 'sauna/sauna-anleitung.pdf',
      textContent: 'Aufheizzeit etwa 40 Minuten.',
    });
    const second = await store.upsertAttachment({
      pageId: pageId as number,
      filename: 'sauna-anleitung.pdf',
      mime: 'application/pdf',
      size: 204801,
      sha256: 'c'.repeat(64),
      path: 'sauna/sauna-anleitung.pdf',
      textContent: 'Aufheizzeit etwa 45 Minuten.',
    });
    expect(second).toBe(first);

    const page = await store.getPageBySlug('sauna');
    expect(page?.attachments.length).toBe(1);
    expect(page?.attachments[0].size).toBe(204801);
    expect(page?.attachments[0].sha256).toBe('c'.repeat(64));
    expect(page?.attachments[0].hasText).toBe(true);
    expect(page?.attachmentCount).toBe(1);
  });

  test('getAttachment findet über Slug und Dateiname', async () => {
    const attachment = await store.getAttachment('sauna', 'sauna-anleitung.pdf');
    expect(attachment?.path).toBe('sauna/sauna-anleitung.pdf');
    expect(attachment?.pageSlug).toBe('sauna');
  });

  test('getAttachment liefert null für unbekannte Datei', async () => {
    expect(await store.getAttachment('sauna', 'gibtesnicht.pdf')).toBeNull();
  });
});

describe('Volltextsuche', () => {
  test('findet Treffer im Seitentext', async () => {
    const hits = await store.searchWiki('Gartenhaus', 25);
    expect(hits.some((h) => h.slug === 'gartenhaus' && h.hitType === 'page')).toBe(true);
  });

  test('findet Treffer im PDF-Text des Anhangs', async () => {
    const hits = await store.searchWiki('Aufheizzeit', 25);
    const hit = hits.find((h) => h.hitType === 'attachment');
    expect(hit).toBeDefined();
    expect(hit?.filename).toBe('sauna-anleitung.pdf');
    expect(hit?.slug).toBe('sauna');
  });

  test('deutsche Wortstammsuche greift', async () => {
    // Die Seite schreibt "Monate", gesucht wird "Monat" — der deutsche
    // Stemmer fuehrt beide auf denselben Wortstamm zurueck.
    const hits = await store.searchWiki('Monat', 25);
    expect(hits.some((h) => h.slug === 'gartenhaus')).toBe(true);
  });

  test('leerer Suchbegriff liefert keine Treffer und keinen Fehler', async () => {
    expect(await store.searchWiki('   ', 25)).toEqual([]);
  });

  test('Sonderzeichen im Suchbegriff erzeugen keinen SQL-Fehler', async () => {
    const hits = await store.searchWiki('"unbalanciert & (kaputt|', 25);
    expect(Array.isArray(hits)).toBe(true);
  });
});

describe('Kategorie und Kennzahlen', () => {
  test('setCategory ändert die Kategorie', async () => {
    expect(await store.setCategory('sauna', 'Technik')).toBe(true);
    const page = await store.getPageBySlug('sauna');
    expect(page?.category).toBe('Technik');
  });

  test('setCategory auf unbekannter Seite meldet false', async () => {
    expect(await store.setCategory('gibt-es-nicht', 'Technik')).toBe(false);
  });

  test('listPages liefert alle Seiten mit Anhangzahl', async () => {
    const pages = await store.listPages();
    expect(pages.length).toBeGreaterThanOrEqual(5);
    const sauna = pages.find((p) => p.slug === 'sauna');
    expect(sauna?.attachmentCount).toBe(1);
  });

  test('getStats zählt Seiten, Anhänge und Bytes', async () => {
    const stats = await store.getStats();
    expect(stats.pages).toBeGreaterThanOrEqual(5);
    expect(stats.attachments).toBe(1);
    expect(stats.attachmentsWithText).toBe(1);
    expect(stats.totalAttachmentBytes).toBe(204801);
  });
});
