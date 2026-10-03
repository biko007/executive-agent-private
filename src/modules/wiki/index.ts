/**
 * wiki — Modulschnittstelle.
 *
 * Ersetzt das gehostete JSPWiki bei Nuveon (asp.nuveon.de/biko) durch
 * Postgres + Dashboard-Oberfläche + Nur-Lese-Agententools.
 *
 * Nur die hier exportierten Namen dürfen von außerhalb des Moduls verwendet
 * werden (ESLint-Regel no-deep-module-import).
 */
export {
  convertJspWikiToMarkdown, slugify, normalizePageName, titleFromPageName,
  deriveCategory, detectSensitive, WIKI_CATEGORIES,
} from './convert.js';
export type { ConvertOptions, ConvertResult, WikiCategory } from './convert.js';

export {
  listPages, getPageBySlug, searchWiki, searchForAgent, readForAgent,
  createPage, savePage, listRevisions, getRevision, setCategory,
  upsertImportedPage, upsertAttachment, getAttachment, getPageIdBySlug, getStats,
} from './store.js';
export type {
  WikiPage, WikiPageSummary, WikiAttachment, WikiSearchHit, WikiRevision,
  ImportPageInput, UpsertAttachmentInput, SavePageInput,
} from './store.js';

export { registerWikiHttpRoutes } from './routes.js';
export { registerWikiTools } from './tools.js';

export {
  parsePageIndex, parseAttachmentIndex, extractRawMarkup, parsePageMeta,
  extractRenderedContent, looksLikeLoginPage, looksLikeMissingPage, skipReason, parseSizeText,
  decodeHtmlEntities, stripTags, SYSTEM_PAGES, PASSWORD_PAGES,
  parseAttachmentInfo,
} from './nuveon-parsers.js';
export type { AttachmentIndexEntry, AttachmentInfo } from './nuveon-parsers.js';

export { readNuveonCredentials } from './nuveon-credentials.js';
export type { NuveonCredentials } from './nuveon-credentials.js';
