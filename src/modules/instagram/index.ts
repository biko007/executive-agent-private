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
  pendingInstaSubmits, activeRawSessions, activeCraftDialogs,
  // Helpers used by command-guard in index.ts
  detectMediaType, formatFileSize, loadRawSession, saveRawSession, createRawSession,
  generateRawSessionId, sessionDir,
  // Voice / audio helpers used by command-guard in index.ts
  findRecentAudioFile, transcribeVoice,
} from './commands.js';

export type { InstagramDeps } from './commands.js';

// Session + naming helpers (E2a + E5)
export {
  getOrCreateActiveSession, nextMediaIndex, buildMediaName,
  sanitizeSessionId, recordMediaUpload, computeFileSha256,
  PARAMS_HASH_CENTER_4X5, recordCropVariant, recordCropFailure,
  insertEditVariant, setEditOutput, softDeleteVariant,
  computeVisionParamsHash, recordVisionCropVariant, findExistingVisionCrop,
} from './session-helper.js';
export type { UploadSource } from './session-helper.js';

// Image editing (E3 + E5)
export { centerCrop4x5, subjectAwareCrop4x5 } from './image-edit.js';

// Video editing (E4b)
export { probeVideo, cropVideoTo4x5, extractCoverFrame, computeVideoParamsHash } from './video-edit.js';
export type { VideoCropResult, CoverFrameResult } from './video-edit.js';

// Inbox HTTP endpoint (E2b)
export { registerInboxHttpRoute } from './inbox.js';

// Edit Queue (E4a)
export {
  submitJob, registerJobHandler, recoverStaleJobs, getQueueHealth,
  waitForIdle, registerEditQueueRoutes,
} from './edit-queue.js';
export type { EditJob, JobHandler } from './edit-queue.js';

// ffmpeg Engine (E4a)
export { runFfmpeg, runFfprobe, FfmpegError } from './ffmpeg-engine.js';
export type { FfmpegResult, RunOptions } from './ffmpeg-engine.js';

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
} from './store.js';
