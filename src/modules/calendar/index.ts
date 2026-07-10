/**
 * calendar module — public interface.
 * Other modules MUST import from here — never from internal files.
 */

// Commands (Telegram registration)
export { registerCalendarCommands, initCalendarCommands, createCalendarEventDirect } from './commands.js';
export type { CalendarDeps } from './commands.js';
