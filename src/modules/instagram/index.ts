/**
 * instagram module — public interface.
 * Other modules MUST import from here — never from internal files.
 */

// Types
export type {
  CutSegment, CutPlan, InstaFormat, CutResult, VideoProbe,
  FileAnalysis, ContentProposal, ScanResult, CraftDialogState,
  RawSessionFile, RawSession,
} from './types.js';

// Commands (Telegram registration)
export {
  registerInstagramCommands, initInstagramCommands, bootstrapInstagramToken,
  // State exports for command-guard in index.ts
  instaSubmitActive, instaSubmitLastActivatedAt, setInstaSubmitLastActivatedAt,
  pendingInstaSubmits, activeRawSessions,
  // Helpers used by command-guard in index.ts
  detectMediaType, formatFileSize, loadRawSession, saveRawSession, createRawSession,
  generateRawSessionId, sessionDir,
  // Voice / audio helpers used by command-guard in index.ts
  findRecentAudioFile, transcribeVoice,
  // Briefing helper
  getInstagramBriefingLines,
} from './commands.js';

export type { InstagramDeps } from './commands.js';

// Session + naming helpers (E2a)
export {
  getOrCreateActiveSession, nextMediaIndex, buildMediaName,
  sanitizeSessionId, recordMediaUpload, computeFileSha256,
  PARAMS_HASH_CENTER_4X5, recordCropVariant, recordCropFailure,
} from './session-helper.js';
export type { UploadSource } from './session-helper.js';

// Image editing (E3)
export { centerCrop4x5 } from './image-edit.js';

// Inbox HTTP endpoint (E2b)
export { registerInboxHttpRoute } from './inbox.js';

// Re-export store functions needed by other modules (Dashboard API, system-health)
export {
  isAuthorized as instaAuthorized,
  tokenDaysRemaining,
  loadInsightsCache, loadMediaCache,
  listDrafts as listInstaDrafts,
  loadDraft as loadInstaDraft,
  saveDraft as saveInstaDraft,
  loadTokens as loadInstaTokens,
  ensureFreshToken as ensureInstaToken,
  markTokenFailed as markInstaTokenFailed,
  fetchInsights,
  // Approval-Hard-Rule (spec §17.2) — testable publish validation
  createDraft, publish, validateDraftApproval,
  // Token Guardian (Sprint 3 §5.2)
  getTokenHealth,
} from './store.js';
