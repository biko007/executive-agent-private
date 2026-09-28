/**
 * BITE-Test Sensibel-Filter (Pflicht-Test — NIEMALS löschen oder deaktivieren).
 *
 * Zusicherung: eine als sensitive=true markierte Seite ist über die
 * Agententools wiki_search und wiki_read NICHT erreichbar — weder als Treffer
 * noch als Textausschnitt.
 *
 * Der Test ist so gebaut, dass er rot wird, sobald der Filter entfernt wird:
 * die sensible Seite enthält einen Suchbegriff, der in keiner anderen Seite
 * vorkommt. Fällt `AND p.sensitive = false` aus searchForAgent bzw.
 * `AND sensitive = false` aus readForAgent weg, liefert die Suche einen Treffer
 * und der Test schlägt fehl.
 */
import { describe, expect, test, beforeAll, afterAll } from 'bun:test';
import { setupTestDb } from './test-db-setup.js';

let cleanup: () => Promise<void>;
let store: typeof import('../store.js');

/** Begriff, der ausschließlich auf der sensiblen Seite steht. */
const SECRET_MARKER = 'Zirbelkiefernschlossbeschlag';

beforeAll(async () => {
  const setup = await setupTestDb();
  cleanup = setup.cleanup;
  // Erst nach dem Umbiegen von POSTGRES_URL laden.
  store = await import('../store.js');

  // Sensible Seite: enthält den Marker und ein Geheimnismuster.
  await store.upsertImportedPage({
    slug: 'geheime-zugaenge',
    title: 'Geheime Zugänge',
    category: 'Accounts & Dienste',
    bodyMd: `Der ${SECRET_MARKER} sitzt hinter der Tür. Passwort: nicht hier notieren.`,
    sourceMarkup: 'roh',
    sensitive: true,
    sourcePageName: 'GeheimeZugaenge',
    sourceAuthor: 'import',
    sourceModifiedAt: new Date('2016-05-01T10:00:00Z'),
  });

  // Unbedenkliche Seite als Gegenprobe: muss auffindbar bleiben.
  await store.upsertImportedPage({
    slug: 'kaffeeautomat',
    title: 'Kaffeeautomat',
    category: 'Technik',
    bodyMd: 'Den Kaffeeautomat alle zwei Monate entkalken.',
    sourceMarkup: 'roh',
    sensitive: false,
    sourcePageName: 'Kaffeeautomat',
    sourceAuthor: 'import',
    sourceModifiedAt: new Date('2016-05-02T10:00:00Z'),
  });

  // Anhang an der sensiblen Seite — auch dessen Text darf der Agent nicht sehen.
  const sensitiveId = await store.getPageIdBySlug('geheime-zugaenge');
  await store.upsertAttachment({
    pageId: sensitiveId as number,
    filename: 'zugang.pdf',
    mime: 'application/pdf',
    size: 1234,
    sha256: 'a'.repeat(64),
    path: 'geheime-zugaenge/zugang.pdf',
    textContent: `Im Anhang steht ebenfalls ${SECRET_MARKER}.`,
  });
});

afterAll(async () => {
  if (cleanup) await cleanup();
});

describe('Agenten-Suche (wiki_search)', () => {
  test('sensible Seite erscheint NICHT in den Treffern', async () => {
    const hits = await store.searchForAgent(SECRET_MARKER, 25);
    expect(hits.length).toBe(0);
  });

  test('sensible Seite erscheint auch bei Suche nach ihrem Titel nicht', async () => {
    const hits = await store.searchForAgent('Geheime Zugänge', 25);
    expect(hits.some((h) => h.slug === 'geheime-zugaenge')).toBe(false);
  });

  test('Anhangtext einer sensiblen Seite liefert keinen Treffer', async () => {
    const hits = await store.searchForAgent('Anhang steht', 25);
    expect(hits.some((h) => h.slug === 'geheime-zugaenge')).toBe(false);
  });

  test('kein Textausschnitt enthält den geheimen Marker', async () => {
    const hits = await store.searchForAgent(SECRET_MARKER, 25);
    for (const hit of hits) {
      expect(hit.snippet).not.toContain(SECRET_MARKER);
    }
  });

  test('Gegenprobe: unbedenkliche Seite ist auffindbar', async () => {
    const hits = await store.searchForAgent('Kaffeeautomat', 25);
    expect(hits.some((h) => h.slug === 'kaffeeautomat')).toBe(true);
  });
});

describe('Agenten-Lesen (wiki_read)', () => {
  test('sensible Seite wird nicht geliefert', async () => {
    const page = await store.readForAgent('geheime-zugaenge');
    expect(page).toBeNull();
  });

  test('unbedenkliche Seite wird geliefert', async () => {
    const page = await store.readForAgent('kaffeeautomat');
    expect(page).not.toBeNull();
    expect(page?.title).toBe('Kaffeeautomat');
  });
});

describe('Dashboard-Pfad bleibt vollständig', () => {
  test('Dashboard-Suche findet die sensible Seite', async () => {
    const hits = await store.searchWiki(SECRET_MARKER, 25);
    expect(hits.some((h) => h.slug === 'geheime-zugaenge')).toBe(true);
  });

  test('Dashboard-Lesen liefert die sensible Seite mit Markierung', async () => {
    const page = await store.getPageBySlug('geheime-zugaenge');
    expect(page).not.toBeNull();
    expect(page?.sensitive).toBe(true);
  });
});

describe('Tool-Ebene: wiki_search und wiki_read', () => {
  /**
   * Prueft die Zusicherung dort, wo der Agent sie tatsaechlich benutzt: an den
   * registrierten Tools. registerWikiTools wird mit einer Attrappe der Plugin-API
   * aufgerufen, danach werden die Tools direkt ausgefuehrt.
   */
  async function loadTools() {
    const { registerWikiTools } = await import('../tools.js');
    const registered = new Map<string, any>();
    registerWikiTools({
      registerTool: (tool: any) => registered.set(tool.name, tool),
      logger: { info: () => {}, error: () => {} },
    });
    return registered;
  }

  test('beide Tools werden registriert', async () => {
    const tools = await loadTools();
    expect([...tools.keys()].sort()).toEqual(['wiki_read', 'wiki_search']);
  });

  test('wiki_search liefert die sensible Seite nicht', async () => {
    const tools = await loadTools();
    const result = await tools.get('wiki_search').execute('t1', { query: SECRET_MARKER });
    expect(result.details.count).toBe(0);
    expect(result.details.hits).toEqual([]);
    // Der Antworttext gibt nur den Suchbegriff des Fragenden zurueck. Geprueft
    // wird, dass kein Inhalt der sensiblen Seite darin auftaucht.
    const text = result.content.map((c: any) => c.text).join('\n');
    expect(text).not.toContain('Geheime');
    expect(text).not.toContain('geheime-zugaenge');
    expect(text).not.toContain('sitzt hinter der');
    expect(text).not.toContain('zugang.pdf');
  });

  test('wiki_search findet die unbedenkliche Seite', async () => {
    const tools = await loadTools();
    const result = await tools.get('wiki_search').execute('t2', { query: 'Kaffeeautomat' });
    expect(result.details.count).toBeGreaterThan(0);
    expect(result.details.hits.some((h: any) => h.slug === 'kaffeeautomat')).toBe(true);
  });

  test('wiki_read verweigert die sensible Seite und verraet ihre Existenz nicht', async () => {
    const tools = await loadTools();
    const result = await tools.get('wiki_read').execute('t3', { slug: 'geheime-zugaenge' });
    expect(result.details.found).toBe(false);
    expect(result.details.bodyMd).toBe('');
    const text = result.content.map((c: any) => c.text).join('\n');
    expect(text).not.toContain(SECRET_MARKER);
    // Gleiche Antwort wie fuer eine gar nicht vorhandene Seite.
    const missing = await tools.get('wiki_read').execute('t4', { slug: 'gibt-es-nicht' });
    expect(text.replace('geheime-zugaenge', 'X'))
      .toBe(missing.content.map((c: any) => c.text).join('\n').replace('gibt-es-nicht', 'X'));
  });

  test('wiki_read liefert die unbedenkliche Seite samt Anhangliste', async () => {
    const tools = await loadTools();
    const result = await tools.get('wiki_read').execute('t5', { slug: 'kaffeeautomat' });
    expect(result.details.found).toBe(true);
    expect(result.details.title).toBe('Kaffeeautomat');
    expect(Array.isArray(result.details.attachments)).toBe(true);
  });

  test('die Tools haben keinen Schreibpfad', async () => {
    const tools = await loadTools();
    for (const tool of tools.values()) {
      const source = String(tool.execute);
      expect(source).not.toContain('savePage');
      expect(source).not.toContain('createPage');
      expect(source).not.toContain('upsert');
    }
  });
});
