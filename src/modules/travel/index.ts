/**
 * travel module — public interface.
 * Other modules MUST import from here — never from internal files.
 */

// Types
export type {
  SegmentType, Climate, ActivityType, TripSegment, Trip,
  BookingType, ParsedBooking, ParsedMeeting,
  TripEnrichment, WeatherDay, WeatherDayData, WeatherBriefing, TripParseResult,
} from './types.js';

export { BOOKING_TO_SEGMENT, BOOKING_EMOJI, SEGMENT_EMOJI } from './types.js';

// Store (data access)
export {
  createTrip, getTrip, listTrips,
  addSegment, removeSegment, updateSegment, updateTrip,
  generatePacklist,
} from './store.js';

// Weather
export { fetchWeatherBriefing, fetchWeatherForecast, wmoToText } from './weather.js';

// Enrichment & Booking Analysis
export {
  enrichTripWithOpenAI, parseTripFreeText,
  analyzeMailForBooking, formatBookingMessage, formatMeetingMessage, isMeeting,
} from './enrichment.js';

// Commands (Telegram registration)
export { registerTravelCommands, initTravelCommands, addBookingAsSegment, handleSegmentDeletionCallback } from './commands.js';
export type { TravelDeps } from './commands.js';
