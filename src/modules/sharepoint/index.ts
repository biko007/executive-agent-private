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
  searchLocalIndex, getIndexAge,
} from './commands.js';
