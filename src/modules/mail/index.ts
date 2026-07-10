/**
 * mail module — public interface.
 * Other modules MUST import from here — never from internal files.
 */

// Types
export type { DraftStatus, Account, MailDraft, UnifiedMsg, ProcessedMails } from './types.js';

// Store (for /brief and generateBriefingText in index.ts)
export { listDrafts } from './commands.js';

// Mail Fetchers (for /brief and generateBriefingText in index.ts)
export { m365Unread, yahooUnread, m365Recent, yahooRecent } from './commands.js';

// Mail Scanner (for background task in index.ts)
export { scanMailsForBookings } from './commands.js';

// State (for booking + meeting callback handlers in index.ts)
export { pendingBookings, pendingTripSelections, pendingMeetings } from './commands.js';

// Commands (Telegram registration)
export { registerMailCommands, initMailCommands } from './commands.js';
export type { MailDeps } from './commands.js';
