// Re-export from new location — will be removed after full module migration
export {
  getLinksForEntity, getAllLinks, addSharePointLink, addLocalLink,
  removeLink, getLinkById, searchSharePointForLinking, updateEntityId,
  formatLinksForTelegram,
} from "./src/shared/links/index.js";
export type { DocumentLink, SpSearchResult } from "./src/shared/links/index.js";
