/**
 * wiki/tools — Nur-Lese-Agententools für Hans_Dampf.
 *
 * Zwei Tools, beide ausschließlich lesend:
 *   wiki_search(query)  → Titel, Slug, Textausschnitt (auch aus PDF-Inhalten)
 *   wiki_read(slug)     → Seiteninhalt + Anhangliste
 *
 * Sicherheitsgrenze: die Tools rufen ausschließlich searchForAgent/readForAgent
 * aus store.ts auf. Diese Funktionen filtern `sensitive = true` hart in SQL.
 * Es gibt hier absichtlich keinen Parameter, mit dem der Filter abschaltbar wäre,
 * und keinen Schreibpfad.
 */
import { Type } from 'typebox';
import { searchForAgent, readForAgent } from './store.js';

/** Obergrenze für gelieferten Seitentext, damit ein Kontextfenster nicht überläuft. */
const MAX_BODY_CHARS = 12_000;

function formatBytes(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  if (bytes >= 1024) return `${Math.round(bytes / 1024)} kB`;
  return `${bytes} B`;
}

/**
 * Beide Wiki-Tools an der Plugin-API registrieren.
 * Muss in openclaw.plugin.json unter contracts.tools deklariert sein.
 */
export function registerWikiTools(api: any): void {
  api.registerTool({
    name: 'wiki_search',
    label: 'Wiki-Suche',
    description:
      'Durchsucht das private Wiki von Jürgen Bickel (Haus Neuhausen, L19, Technik, '
      + 'Accounts & Dienste) per Volltextsuche. Findet auch Text in angehängten PDFs '
      + '(Bedienungsanleitungen, Pläne). Liefert Titel, Slug und Textausschnitt. '
      + 'Mit wiki_read und dem Slug die vollständige Seite lesen.',
    promptSnippet: 'wiki_search: privates Wiki (Haus, Technik, Anleitungen) durchsuchen',
    parameters: Type.Object({
      query: Type.String({
        description: 'Suchbegriff auf Deutsch, z. B. "Kaffeeautomat Entkalken" oder "KNX Aktor".',
      }),
      limit: Type.Optional(Type.Number({
        description: 'Höchstzahl der Treffer (1–25, Standard 10).',
      })),
    }),
    outputSchema: Type.Object({
      hits: Type.Array(Type.Object({
        slug: Type.String(),
        title: Type.String(),
        category: Type.String(),
        hitType: Type.String(),
        filename: Type.Union([Type.String(), Type.Null()]),
        snippet: Type.String(),
      })),
      count: Type.Number(),
    }, { additionalProperties: false }),
    async execute(_toolCallId: string, params: { query: string; limit?: number }) {
      const limit = Math.min(Math.max(1, Math.trunc(params.limit ?? 10)), 25);
      const hits = await searchForAgent(params.query, limit);

      const details = {
        hits: hits.map((h) => ({
          slug: h.slug,
          title: h.title,
          category: h.category,
          hitType: h.hitType,
          filename: h.filename,
          snippet: h.snippet,
        })),
        count: hits.length,
      };

      if (hits.length === 0) {
        return {
          content: [{ type: 'text', text: `Keine Wiki-Treffer für "${params.query}".` }],
          details,
        };
      }

      const lines = hits.map((h) => {
        const source = h.hitType === 'attachment' ? ` [Anhang: ${h.filename}]` : '';
        return `• ${h.title} (${h.category}, slug: ${h.slug})${source}\n  ${h.snippet}`;
      });

      return {
        content: [{
          type: 'text',
          text: `${hits.length} Wiki-Treffer für "${params.query}":\n\n${lines.join('\n\n')}`,
        }],
        details,
      };
    },
  });

  api.registerTool({
    name: 'wiki_read',
    label: 'Wiki-Seite lesen',
    description:
      'Liest eine Seite aus dem privaten Wiki vollständig. Der Slug kommt aus '
      + 'wiki_search. Liefert Inhalt als Markdown plus die Liste der Anhänge.',
    promptSnippet: 'wiki_read: eine Wiki-Seite per Slug vollständig lesen',
    parameters: Type.Object({
      slug: Type.String({
        description: 'Slug der Seite, z. B. "haus-neuhausen-heizung" (aus wiki_search).',
      }),
    }),
    outputSchema: Type.Object({
      found: Type.Boolean(),
      slug: Type.String(),
      title: Type.String(),
      category: Type.String(),
      bodyMd: Type.String(),
      truncated: Type.Boolean(),
      attachments: Type.Array(Type.Object({
        filename: Type.String(),
        mime: Type.String(),
        size: Type.Number(),
      })),
    }, { additionalProperties: false }),
    async execute(_toolCallId: string, params: { slug: string }) {
      const page = await readForAgent(params.slug);

      if (!page) {
        // Gleiche Antwort für "gibt es nicht" und "ist sensibel" — die Existenz
        // einer sensiblen Seite soll nicht aus der Fehlermeldung ableitbar sein.
        return {
          content: [{
            type: 'text',
            text: `Keine lesbare Wiki-Seite mit dem Slug "${params.slug}".`,
          }],
          details: {
            found: false, slug: params.slug, title: '', category: '',
            bodyMd: '', truncated: false, attachments: [],
          },
        };
      }

      const truncated = page.bodyMd.length > MAX_BODY_CHARS;
      const body = truncated ? `${page.bodyMd.slice(0, MAX_BODY_CHARS)}\n\n[…gekürzt]` : page.bodyMd;

      const attachmentBlock = page.attachments.length
        ? `\n\nAnhänge (${page.attachments.length}):\n`
          + page.attachments.map((a) => `• ${a.filename} (${a.mime}, ${formatBytes(a.size)})`).join('\n')
        : '\n\nKeine Anhänge.';

      const modified = page.sourceModifiedAt
        ? ` — letzte Änderung ${page.sourceModifiedAt.slice(0, 10)}`
        : '';

      return {
        content: [{
          type: 'text',
          text: `# ${page.title}\nKategorie: ${page.category}${modified}\n\n${body}${attachmentBlock}`,
        }],
        details: {
          found: true,
          slug: page.slug,
          title: page.title,
          category: page.category,
          bodyMd: body,
          truncated,
          attachments: page.attachments,
        },
      };
    },
  });
}
