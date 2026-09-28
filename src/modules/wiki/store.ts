/**
 * wiki/store — Datenzugriff für das Wiki-Modul (openclaw_core).
 *
 * Zwei getrennte Lesepfade, absichtlich nicht zusammengeführt:
 *   - Dashboard-Pfad (searchWiki, getPageBySlug): sieht alle Seiten.
 *   - Agenten-Pfad (searchForAgent, readForAgent): filtert sensitive=true hart
 *     in der SQL-Bedingung heraus, auch für Textausschnitte.
 *
 * Der Agenten-Pfad ist bewusst eine eigene Funktion und kein Parameter des
 * Dashboard-Pfads: ein vergessener Parameter würde sonst Geheimnisse an das
 * Sprachmodell geben. Der Regressionstest in __tests__/agent-filter.test.ts
 * schlägt fehl, sobald die Bedingung entfernt wird.
 */
import { query, getClient } from '../../shared/db/index.js';
import { slugify } from './convert.js';

export interface WikiPageSummary {
  id: number;
  slug: string;
  title: string;
  category: string;
  sensitive: boolean;
  source: string;
  sourceAuthor: string | null;
  sourceModifiedAt: string | null;
  updatedAt: string;
  attachmentCount: number;
}

export interface WikiAttachment {
  id: number;
  pageId: number;
  filename: string;
  mime: string;
  size: number;
  sha256: string | null;
  path: string;
  previewPath: string | null;
  thumbPath: string | null;
  hasText: boolean;
  sourceAuthor: string | null;
  sourceModifiedAt: string | null;
}

export interface WikiPage extends WikiPageSummary {
  bodyMd: string;
  sourceMarkup: string | null;
  sourcePageName: string | null;
  createdAt: string;
  attachments: WikiAttachment[];
  latestRev: number;
}

export interface WikiSearchHit {
  slug: string;
  title: string;
  category: string;
  /** 'page' = Treffer im Seitentext, 'attachment' = Treffer im PDF-Text. */
  hitType: 'page' | 'attachment';
  /** Bei hitType 'attachment' der Dateiname, sonst null. */
  filename: string | null;
  snippet: string;
  rank: number;
}

export interface WikiRevision {
  rev: number;
  title: string | null;
  author: string;
  createdAt: string;
  bodyMd?: string;
}

// ── Abbildung DB-Zeile → Objekt ─────────────────────────────────────────────

function mapSummary(row: any): WikiPageSummary {
  return {
    id: row.id,
    slug: row.slug,
    title: row.title,
    category: row.category,
    sensitive: row.sensitive,
    source: row.source,
    sourceAuthor: row.source_author ?? null,
    sourceModifiedAt: row.source_modified_at ? new Date(row.source_modified_at).toISOString() : null,
    updatedAt: new Date(row.updated_at).toISOString(),
    attachmentCount: Number(row.attachment_count ?? 0),
  };
}

function mapAttachment(row: any): WikiAttachment {
  return {
    id: row.id,
    pageId: row.page_id,
    filename: row.filename,
    mime: row.mime,
    size: Number(row.size),
    sha256: row.sha256 ?? null,
    path: row.path,
    previewPath: row.preview_path ?? null,
    thumbPath: row.thumb_path ?? null,
    hasText: Boolean(row.has_text),
    sourceAuthor: row.source_author ?? null,
    sourceModifiedAt: row.source_modified_at ? new Date(row.source_modified_at).toISOString() : null,
  };
}

// ── Dashboard-Lesepfad ──────────────────────────────────────────────────────

/** Alle Seiten mit Anhangzahl, sortiert nach Kategorie und Titel. */
export async function listPages(): Promise<WikiPageSummary[]> {
  const { rows } = await query(
    `SELECT p.*, (SELECT COUNT(*) FROM wiki_attachments a WHERE a.page_id = p.id) AS attachment_count
       FROM wiki_pages p
      ORDER BY p.category, p.title`,
  );
  return rows.map(mapSummary);
}

/** Eine Seite samt Anhängen und höchster Revisionsnummer. */
export async function getPageBySlug(slug: string): Promise<WikiPage | null> {
  const { rows } = await query(
    `SELECT p.*, (SELECT COUNT(*) FROM wiki_attachments a WHERE a.page_id = p.id) AS attachment_count
       FROM wiki_pages p WHERE p.slug = $1`,
    [slug],
  );
  if (rows.length === 0) return null;
  const row = rows[0];

  const { rows: attachmentRows } = await query(
    `SELECT id, page_id, filename, mime, size, sha256, path, preview_path, thumb_path,
            (text_content IS NOT NULL AND text_content <> '') AS has_text,
            source_author, source_modified_at
       FROM wiki_attachments WHERE page_id = $1 ORDER BY filename`,
    [row.id],
  );

  const { rows: revRows } = await query(
    'SELECT COALESCE(MAX(rev), 0) AS latest FROM wiki_page_revisions WHERE page_id = $1',
    [row.id],
  );

  return {
    ...mapSummary(row),
    bodyMd: row.body_md,
    sourceMarkup: row.source_markup ?? null,
    sourcePageName: row.source_page_name ?? null,
    createdAt: new Date(row.created_at).toISOString(),
    attachments: attachmentRows.map(mapAttachment),
    latestRev: Number(revRows[0].latest),
  };
}

/**
 * Volltextsuche über Seitentext und extrahierten Anhangtext.
 * Dashboard-Pfad: liefert auch als sensibel markierte Seiten.
 */
export async function searchWiki(searchTerm: string, limit = 50): Promise<WikiSearchHit[]> {
  return runSearch(searchTerm, limit, false);
}

// ── Agenten-Lesepfad (Hans_Dampf) ───────────────────────────────────────────

/**
 * Suche für den Agenten. `sensitive = false` steht hart in beiden Teilabfragen —
 * sensible Seiten erscheinen weder als Treffer noch als Textausschnitt.
 */
export async function searchForAgent(searchTerm: string, limit = 10): Promise<WikiSearchHit[]> {
  return runSearch(searchTerm, limit, true);
}

/** Seite für den Agenten lesen. Sensible Seiten werden nie geliefert. */
export async function readForAgent(slug: string): Promise<{
  slug: string;
  title: string;
  category: string;
  bodyMd: string;
  sourceModifiedAt: string | null;
  attachments: Array<{ filename: string; mime: string; size: number }>;
} | null> {
  const { rows } = await query(
    `SELECT id, slug, title, category, body_md, source_modified_at
       FROM wiki_pages
      WHERE slug = $1 AND sensitive = false`,
    [slug],
  );
  if (rows.length === 0) return null;
  const row = rows[0];

  const { rows: attachmentRows } = await query(
    'SELECT filename, mime, size FROM wiki_attachments WHERE page_id = $1 ORDER BY filename',
    [row.id],
  );

  return {
    slug: row.slug,
    title: row.title,
    category: row.category,
    bodyMd: row.body_md,
    sourceModifiedAt: row.source_modified_at ? new Date(row.source_modified_at).toISOString() : null,
    attachments: attachmentRows.map((a: any) => ({
      filename: a.filename,
      mime: a.mime,
      size: Number(a.size),
    })),
  };
}

/**
 * Gemeinsame Suchmechanik für Dashboard und Agent.
 * `agentMode = true` schaltet den Sensibel-Filter ein.
 */
async function runSearch(
  searchTerm: string,
  limit: number,
  agentMode: boolean,
): Promise<WikiSearchHit[]> {
  const term = String(searchTerm ?? '').trim();
  if (!term) return [];

  // websearch_to_tsquery verträgt beliebige Nutzereingaben ohne Syntaxfehler.
  const sensitiveClause = agentMode ? 'AND p.sensitive = false' : '';
  // Nicht-Zahlen (NaN, undefined) wuerden als 'LIMIT NaN' im SQL landen und die
  // Abfrage sprengen. Daher auf den Standardwert zurueckfallen, nicht durchlassen.
  const requested = Number(limit);
  const safeLimit = Number.isFinite(requested)
    ? Math.min(Math.max(1, Math.trunc(requested)), 100)
    : 50;

  const sql = `
    WITH q AS (SELECT websearch_to_tsquery('german'::regconfig, $1) AS tsq)
    SELECT slug, title, category, hit_type, filename, snippet, rank FROM (
      SELECT p.slug, p.title, p.category,
             'page'::text AS hit_type,
             NULL::text AS filename,
             ts_headline('german'::regconfig, p.body_md, q.tsq,
                         'MaxWords=40, MinWords=15, ShortWord=3, MaxFragments=2') AS snippet,
             ts_rank(p.search_tsv, q.tsq) AS rank
        FROM wiki_pages p, q
       WHERE p.search_tsv @@ q.tsq ${sensitiveClause}
      UNION ALL
      SELECT p.slug, p.title, p.category,
             'attachment'::text AS hit_type,
             a.filename,
             ts_headline('german'::regconfig, COALESCE(a.text_content, ''), q.tsq,
                         'MaxWords=40, MinWords=15, ShortWord=3, MaxFragments=2') AS snippet,
             ts_rank(a.search_tsv, q.tsq) * 0.8 AS rank
        FROM wiki_attachments a
        JOIN wiki_pages p ON p.id = a.page_id, q
       WHERE a.search_tsv @@ q.tsq ${sensitiveClause}
    ) hits
    ORDER BY rank DESC, title
    LIMIT ${safeLimit}
  `;

  const { rows } = await query(sql, [term]);
  return rows.map((r: any) => ({
    slug: r.slug,
    title: r.title,
    category: r.category,
    hitType: r.hit_type as 'page' | 'attachment',
    filename: r.filename ?? null,
    snippet: String(r.snippet ?? '').replace(/\s+/g, ' ').trim(),
    rank: Number(r.rank),
  }));
}

// ── Schreibpfad ─────────────────────────────────────────────────────────────

export interface SavePageInput {
  title: string;
  bodyMd: string;
  category?: string;
  sensitive?: boolean;
  author?: string;
}

/**
 * Seite anlegen. Jede Neuanlage erzeugt Revision 1.
 * Der Slug wird aus dem Titel abgeleitet und bei Kollision numerisch ergänzt.
 */
export async function createPage(input: SavePageInput): Promise<WikiPage> {
  const base = slugify(input.title);
  const client = await getClient();
  try {
    await client.query('BEGIN');

    // Freien Slug suchen — der Zähler bleibt lesbar (haus-neuhausen-2).
    let slug = base;
    for (let suffix = 2; suffix < 200; suffix++) {
      const { rows } = await client.query('SELECT 1 FROM wiki_pages WHERE slug = $1', [slug]);
      if (rows.length === 0) break;
      slug = `${base}-${suffix}`;
    }

    const { rows: inserted } = await client.query(
      `INSERT INTO wiki_pages (slug, title, category, body_md, sensitive, source)
       VALUES ($1, $2, $3, $4, $5, 'local') RETURNING id`,
      [slug, input.title, input.category ?? 'Sonstiges', input.bodyMd, input.sensitive ?? false],
    );
    const pageId = inserted[0].id;

    await client.query(
      `INSERT INTO wiki_page_revisions (page_id, rev, title, body_md, author)
       VALUES ($1, 1, $2, $3, $4)`,
      [pageId, input.title, input.bodyMd, input.author ?? 'dashboard'],
    );

    await client.query('COMMIT');
    const page = await getPageBySlug(slug);
    if (!page) throw new Error(`Seite ${slug} nach dem Anlegen nicht lesbar`);
    return page;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Seite speichern. Jedes Speichern legt eine neue Revision an, damit eine
 * fehlerhafte Bearbeitung nachvollziehbar und rücknehmbar bleibt.
 */
export async function savePage(slug: string, input: SavePageInput): Promise<WikiPage> {
  const client = await getClient();
  try {
    await client.query('BEGIN');

    // Zeile sperren, damit zwei gleichzeitige Speichervorgänge nicht dieselbe
    // Revisionsnummer bekommen.
    const { rows } = await client.query(
      'SELECT id FROM wiki_pages WHERE slug = $1 FOR UPDATE',
      [slug],
    );
    if (rows.length === 0) {
      await client.query('ROLLBACK');
      throw new Error(`Seite ${slug} existiert nicht`);
    }
    const pageId = rows[0].id;

    const { rows: revRows } = await client.query(
      'SELECT COALESCE(MAX(rev), 0) + 1 AS next FROM wiki_page_revisions WHERE page_id = $1',
      [pageId],
    );
    const nextRev = Number(revRows[0].next);

    await client.query(
      `UPDATE wiki_pages
          SET title = $2, body_md = $3,
              category = COALESCE($4, category),
              sensitive = COALESCE($5, sensitive),
              updated_at = NOW()
        WHERE id = $1`,
      [pageId, input.title, input.bodyMd, input.category ?? null,
       input.sensitive === undefined ? null : input.sensitive],
    );

    await client.query(
      `INSERT INTO wiki_page_revisions (page_id, rev, title, body_md, author)
       VALUES ($1, $2, $3, $4, $5)`,
      [pageId, nextRev, input.title, input.bodyMd, input.author ?? 'dashboard'],
    );

    await client.query('COMMIT');
    const page = await getPageBySlug(slug);
    if (!page) throw new Error(`Seite ${slug} nach dem Speichern nicht lesbar`);
    return page;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

/** Revisionsliste einer Seite, neueste zuerst (ohne Volltext). */
export async function listRevisions(slug: string): Promise<WikiRevision[]> {
  const { rows } = await query(
    `SELECT r.rev, r.title, r.author, r.created_at
       FROM wiki_page_revisions r JOIN wiki_pages p ON p.id = r.page_id
      WHERE p.slug = $1 ORDER BY r.rev DESC`,
    [slug],
  );
  return rows.map((r: any) => ({
    rev: r.rev,
    title: r.title ?? null,
    author: r.author,
    createdAt: new Date(r.created_at).toISOString(),
  }));
}

/** Eine einzelne Revision samt Inhalt. */
export async function getRevision(slug: string, rev: number): Promise<WikiRevision | null> {
  const { rows } = await query(
    `SELECT r.rev, r.title, r.author, r.created_at, r.body_md
       FROM wiki_page_revisions r JOIN wiki_pages p ON p.id = r.page_id
      WHERE p.slug = $1 AND r.rev = $2`,
    [slug, rev],
  );
  if (rows.length === 0) return null;
  const r = rows[0];
  return {
    rev: r.rev,
    title: r.title ?? null,
    author: r.author,
    createdAt: new Date(r.created_at).toISOString(),
    bodyMd: r.body_md,
  };
}

/** Kategorie einer Seite ändern (Dashboard). */
export async function setCategory(slug: string, category: string): Promise<boolean> {
  const { rowCount } = await query(
    'UPDATE wiki_pages SET category = $2, updated_at = NOW() WHERE slug = $1',
    [slug, category],
  );
  return (rowCount ?? 0) > 0;
}

// ── Import-Schreibpfad ──────────────────────────────────────────────────────

export interface ImportPageInput {
  slug: string;
  title: string;
  category: string;
  bodyMd: string;
  sourceMarkup: string;
  sensitive: boolean;
  sourcePageName: string;
  sourceAuthor: string | null;
  sourceModifiedAt: Date | null;
}

/**
 * Importierte Seite anlegen oder aktualisieren. Wiederholte Importläufe sind
 * unschädlich (idempotent je Slug); Revision 1 wird nur beim ersten Mal erzeugt,
 * damit ein Wiederanlauf keine Scheinhistorie produziert.
 */
export async function upsertImportedPage(input: ImportPageInput): Promise<number> {
  const client = await getClient();
  try {
    await client.query('BEGIN');
    const { rows } = await client.query(
      `INSERT INTO wiki_pages
         (slug, title, category, body_md, source_markup, sensitive, source,
          source_page_name, source_author, source_modified_at)
       VALUES ($1, $2, $3, $4, $5, $6, 'nuveon', $7, $8, $9)
       ON CONFLICT (slug) DO UPDATE SET
         title = EXCLUDED.title,
         category = EXCLUDED.category,
         body_md = EXCLUDED.body_md,
         source_markup = EXCLUDED.source_markup,
         sensitive = EXCLUDED.sensitive,
         source_page_name = EXCLUDED.source_page_name,
         source_author = EXCLUDED.source_author,
         source_modified_at = EXCLUDED.source_modified_at,
         updated_at = NOW()
       RETURNING id`,
      [input.slug, input.title, input.category, input.bodyMd, input.sourceMarkup,
       input.sensitive, input.sourcePageName, input.sourceAuthor, input.sourceModifiedAt],
    );
    const pageId = rows[0].id;

    // Revision 1 ist der Importstand. Wurde die Seite zwischenzeitlich im
    // Dashboard bearbeitet (Revision > 1), darf ein erneuter Importlauf die
    // Bearbeitung nicht stillschweigend ersetzen: dann wird der Importstand als
    // NEUE Revision angehaengt, damit die Aenderung nachvollziehbar bleibt.
    const { rows: revRows } = await client.query(
      'SELECT COALESCE(MAX(rev), 0) AS latest FROM wiki_page_revisions WHERE page_id = $1',
      [pageId],
    );
    const latestRev = Number(revRows[0].latest);
    const targetRev = latestRev > 1 ? latestRev + 1 : 1;

    await client.query(
      `INSERT INTO wiki_page_revisions (page_id, rev, title, body_md, author)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (page_id, rev) DO NOTHING`,
      [pageId, targetRev, input.title, input.bodyMd, input.sourceAuthor ?? 'nuveon-import'],
    );

    await client.query('COMMIT');
    return pageId;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

export interface UpsertAttachmentInput {
  pageId: number;
  filename: string;
  mime: string;
  size: number;
  sha256: string | null;
  path: string;
  previewPath?: string | null;
  thumbPath?: string | null;
  textContent?: string | null;
  sourceAuthor?: string | null;
  sourceModifiedAt?: Date | null;
}

/** Anhang anlegen oder aktualisieren (idempotent je Seite + Dateiname). */
export async function upsertAttachment(input: UpsertAttachmentInput): Promise<number> {
  const { rows } = await query(
    `INSERT INTO wiki_attachments
       (page_id, filename, mime, size, sha256, path, preview_path, thumb_path,
        text_content, source_author, source_modified_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
     ON CONFLICT (page_id, filename) DO UPDATE SET
       mime = EXCLUDED.mime,
       size = EXCLUDED.size,
       sha256 = EXCLUDED.sha256,
       path = EXCLUDED.path,
       preview_path = EXCLUDED.preview_path,
       thumb_path = EXCLUDED.thumb_path,
       text_content = EXCLUDED.text_content,
       source_author = EXCLUDED.source_author,
       source_modified_at = EXCLUDED.source_modified_at
     RETURNING id`,
    [input.pageId, input.filename, input.mime, input.size, input.sha256, input.path,
     input.previewPath ?? null, input.thumbPath ?? null, input.textContent ?? null,
     input.sourceAuthor ?? null, input.sourceModifiedAt ?? null],
  );
  return rows[0].id;
}

/**
 * Anhang über Seiten-Slug und Dateiname auflösen — so kann der Konverter
 * Anhang-URLs ohne Kenntnis der Datenbank-IDs bilden.
 */
export async function getAttachment(
  slug: string,
  filename: string,
): Promise<(WikiAttachment & { pageSlug: string; sensitive: boolean }) | null> {
  const { rows } = await query(
    `SELECT a.id, a.page_id, a.filename, a.mime, a.size, a.sha256, a.path,
            a.preview_path, a.thumb_path,
            (a.text_content IS NOT NULL AND a.text_content <> '') AS has_text,
            a.source_author, a.source_modified_at, p.slug AS page_slug, p.sensitive
       FROM wiki_attachments a JOIN wiki_pages p ON p.id = a.page_id
      WHERE p.slug = $1 AND a.filename = $2`,
    [slug, filename],
  );
  if (rows.length === 0) return null;
  return {
    ...mapAttachment(rows[0]),
    pageSlug: rows[0].page_slug,
    sensitive: rows[0].sensitive,
  };
}

/** Seiten-ID zu einem Slug (Importer und Upload-Pfad). */
export async function getPageIdBySlug(slug: string): Promise<number | null> {
  const { rows } = await query('SELECT id FROM wiki_pages WHERE slug = $1', [slug]);
  return rows.length ? rows[0].id : null;
}

/** Kennzahlen für Verifikation und Report. */
export async function getStats(): Promise<{
  pages: number;
  sensitivePages: number;
  attachments: number;
  attachmentsWithText: number;
  totalAttachmentBytes: number;
}> {
  const { rows } = await query(
    `SELECT
       (SELECT COUNT(*) FROM wiki_pages) AS pages,
       (SELECT COUNT(*) FROM wiki_pages WHERE sensitive) AS sensitive_pages,
       (SELECT COUNT(*) FROM wiki_attachments) AS attachments,
       (SELECT COUNT(*) FROM wiki_attachments
          WHERE text_content IS NOT NULL AND text_content <> '') AS attachments_with_text,
       (SELECT COALESCE(SUM(size), 0) FROM wiki_attachments) AS total_bytes`,
  );
  const r = rows[0];
  return {
    pages: Number(r.pages),
    sensitivePages: Number(r.sensitive_pages),
    attachments: Number(r.attachments),
    attachmentsWithText: Number(r.attachments_with_text),
    totalAttachmentBytes: Number(r.total_bytes),
  };
}
