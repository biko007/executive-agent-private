/**
 * sharepoint module — public interface.
 * Other modules MUST import from here — never from internal files.
 */

// Commands (Telegram registration)
export { registerSharePointCommands, initSharePointCommands } from './commands.js';
export type { SharePointDeps } from './commands.js';

// Re-exports used by other modules (fleet links, travel links, briefing)
export {
  getLinksForEntity, formatLinksForTelegram,
  searchSharePointForLinking,
  addSharePointLink, removeLink,
} from './commands.js';

// Sprint 10: DB-backed store + queries
export { fullSync, upsertFile, upsertSingleFileAfterUpload, markMissingSince } from './store.js';
export { searchFiles, listSitesFromDb, listDrivesFromDb, listFilesFromDb, getFileByKey, countActiveFiles } from './queries.js';
export { buildSpItemKey } from './key.js';
export { registerSharePointHttpRoutes } from './routes.js';
