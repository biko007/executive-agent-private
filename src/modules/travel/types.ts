/**
 * travel/types — Domain types for Travel module.
 */

// ── Trip & Segment ──────────────────────────────────────────────────────────

export type SegmentType = 'flight' | 'hotel' | 'activity' | 'transfer' | 'note';
export type Climate = 'tropical' | 'temperate' | 'cold' | 'desert' | 'mixed';
export type ActivityType = 'business' | 'leisure' | 'outdoor' | 'beach' | 'city';

export interface TripSegment {
  id: string;
  type: SegmentType;
  datetime_local: string;
  datetime_utc: string;
  timezone: string;
  title: string;
  confirmation?: string;
  notes?: string;
  calendarEventId?: string;
  calendarWebLink?: string;
}

export interface Trip {
  id: string;
  name: string;
  destination: string;
  country_code: string;
  start_date: string;
  end_date: string;
  climate: Climate;
  activities: ActivityType[];
  segments: TripSegment[];
  calendar_event_ids: string[];
  created_at: string;
  updated_at: string;
  // KI-angereicherte Felder
  currency?: string;
  visa_de?: string;
  distance_km?: number;
  travel_mode?: string;
  door_to_door_estimate?: string;
  exchange_rate_eur?: string;
}

// ── Booking (Mail → Trip Segment) ───────────────────────────────────────────

export type BookingType = 'FLIGHT' | 'HOTEL' | 'TRAIN' | 'CAR' | 'EVENT';

export interface ParsedBooking {
  type: BookingType;
  title: string;
  destination: string;
  startDate: string;       // ISO8601
  endDate: string | null;
  confirmationNumber: string | null;
  provider: string;
}

export const BOOKING_TO_SEGMENT: Record<BookingType, 'flight' | 'hotel' | 'activity' | 'transfer'> = {
  FLIGHT: 'flight',
  HOTEL: 'hotel',
  TRAIN: 'transfer',
  CAR: 'transfer',
  EVENT: 'activity',
};

export const BOOKING_EMOJI: Record<BookingType, string> = {
  FLIGHT: '✈️',
  HOTEL: '🏨',
  TRAIN: '🚆',
  CAR: '🚗',
  EVENT: '🎫',
};

export const SEGMENT_EMOJI: Record<string, string> = {
  flight: '✈️', hotel: '🏨', transfer: '🚆', activity: '🎫', note: '📝',
};

// ── Meeting (Mail → Calendar Event) ─────────────────────────────────────────

export interface ParsedMeeting {
  _kind: 'meeting';
  title: string;
  startDate: string;       // ISO8601
  endDate: string | null;
  durationMin: number;
  link: string | null;
  organizer: string;
}

// ── Enrichment & Weather ────────────────────────────────────────────────────

export interface TripEnrichment {
  destination: string;
  country_code: string;
  lat: number;
  lon: number;
  climate: string;
  activities: string[];
  currency: string;
  visa_de: string;
  distance_km: number;
  travel_mode: string;
  door_to_door_estimate: string;
  exchange_rate_eur: string;
}

export interface WeatherDay {
  date: string;
  tmax: number;
  tmin: number;
  precip: number;
}

export interface WeatherDayData {
  min: number;
  max: number;
  desc: string;
  wind: number;       // km/h max
  precip: number;     // mm
  uv: number;
}

export interface WeatherBriefing {
  currentTemp: number;
  currentDesc: string;
  todayRainHour: number | null;  // first hour with rain, or null
  days: [WeatherDayData, WeatherDayData, WeatherDayData]; // heute, morgen, übermorgen
  pressureHpa: number;     // current pressure_msl
  pressureTrend: '↑ steigend' | '↓ fallend' | '→ stabil';
  // legacy compat
  todayMin: number; todayMax: number;
  tomorrowMin: number; tomorrowMax: number; tomorrowDesc: string;
}

export interface TripParseResult {
  destination: string;
  start: string; // YYYY-MM-DD (Europe/Berlin)
  end: string;   // YYYY-MM-DD (Europe/Berlin)
}
