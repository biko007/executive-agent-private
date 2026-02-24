import fs from 'fs';
import path from 'path';

// ── Types ──────────────────────────────────────────────────────────────────

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

// ── Storage path ───────────────────────────────────────────────────────────

const TRAVEL_DIR = path.join(
  process.env.HOME || '/root',
  '.openclaw/workspace/artifacts/personal/travel'
);

function tripPath(id: string): string {
  return path.join(TRAVEL_DIR, `${id}.json`);
}

function slugify(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');
}

// ── CRUD ───────────────────────────────────────────────────────────────────

export function createTrip(
  name: string,
  start_date: string,
  end_date: string,
  destination: string = '',
  climate: Climate = 'temperate',
  activities: ActivityType[] = ['leisure']
): Trip {
  const id = `${slugify(name)}-${start_date.slice(0, 7)}`;
  const now = new Date().toISOString();
  const trip: Trip = {
    id, name, destination, country_code: '',
    start_date, end_date, climate, activities,
    segments: [], calendar_event_ids: [],
    created_at: now, updated_at: now
  };
  fs.writeFileSync(tripPath(id), JSON.stringify(trip, null, 2), 'utf8');
  return trip;
}

export function getTrip(id: string): Trip | null {
  const p = tripPath(id);
  if (!fs.existsSync(p)) return null;
  return JSON.parse(fs.readFileSync(p, 'utf8')) as Trip;
}

export function listTrips(): Trip[] {
  if (!fs.existsSync(TRAVEL_DIR)) return [];
  return fs.readdirSync(TRAVEL_DIR)
    .filter(f => f.endsWith('.json'))
    .map(f => JSON.parse(fs.readFileSync(path.join(TRAVEL_DIR, f), 'utf8')) as Trip)
    .sort((a, b) => a.start_date.localeCompare(b.start_date));
}

export function addSegment(tripId: string, segment: Omit<TripSegment, 'id'>): Trip | null {
  const trip = getTrip(tripId);
  if (!trip) return null;
  const seg: TripSegment = {
    ...segment,
    id: `seg-${Date.now()}`
  };
  trip.segments.push(seg);
  trip.updated_at = new Date().toISOString();
  fs.writeFileSync(tripPath(tripId), JSON.stringify(trip, null, 2), 'utf8');
  return trip;
}

export function removeSegment(tripId: string, segmentId: string): { trip: Trip; removed: TripSegment } | null {
  const trip = getTrip(tripId);
  if (!trip) return null;
  const idx = trip.segments.findIndex(s => s.id === segmentId);
  if (idx === -1) return null;
  const [removed] = trip.segments.splice(idx, 1);
  trip.updated_at = new Date().toISOString();
  fs.writeFileSync(tripPath(tripId), JSON.stringify(trip, null, 2), 'utf8');
  return { trip, removed };
}

export function updateSegment(tripId: string, segmentId: string, patch: Partial<TripSegment>): Trip | null {
  const trip = getTrip(tripId);
  if (!trip) return null;
  const seg = trip.segments.find(s => s.id === segmentId);
  if (!seg) return null;
  Object.assign(seg, patch);
  trip.updated_at = new Date().toISOString();
  fs.writeFileSync(tripPath(tripId), JSON.stringify(trip, null, 2), 'utf8');
  return trip;
}

export function updateTrip(tripId: string, patch: Partial<Trip>): Trip | null {
  const trip = getTrip(tripId);
  if (!trip) return null;
  const updated = { ...trip, ...patch, updated_at: new Date().toISOString() };
  fs.writeFileSync(tripPath(tripId), JSON.stringify(updated, null, 2), 'utf8');
  return updated;
}

// ── Packliste ──────────────────────────────────────────────────────────────

export function generatePacklist(trip: Trip): string {
  const base = [
    'Reisepass / Personalausweis', 'Kreditkarte + Bargeld',
    'Handy + Ladekabel', 'Powerbank', 'Kopfhörer',
    'Adapter (falls nötig)', 'Reiseapotheke (Schmerzmittel, Pflaster, Durchfallmittel)',
    'Zahnstocher / Hygieneartikel', 'Sonnencreme'
  ];

  const climateItems: Record<Climate, string[]> = {
    tropical: ['Leichte Kleidung (Baumwolle/Leinen)', 'Sonnenhut', 'Insektenschutz', 'Flip-Flops'],
    temperate: ['Jacke / leichter Mantel', 'Schichten-Kleidung', 'Regenschirm'],
    cold: ['Thermounterwäsche', 'Fleece-Pullover', 'Daunenjacke', 'Mütze + Handschuhe + Schal', 'Winterstiefel'],
    desert: ['Leichte Langarmhemden (Sonnenschutz)', 'Sonnenhut', 'Große Wasserflasche', 'Lippenbalsam'],
    mixed: ['Schichten-Kleidung', 'Regenjacke', 'Leichte + warme Optionen']
  };

  const activityItems: Record<ActivityType, string[]> = {
    business: ['Anzug / Businesskleidung', 'Hemden gebügelt', 'Krawatte', 'Visitenkarten', 'Laptop + Netzteil'],
    leisure: ['Freizeitkleidung', 'Bequeme Schuhe', 'Reiseführer / Offline-Karten'],
    outdoor: ['Wanderschuhe', 'Trekkingsocken', 'Regenjacke', 'Rucksack', 'Trinkflasche'],
    beach: ['Badehose / Bikini', 'Strandtuch', 'Wasserfeste Sonnencreme', 'Schnorchelausrüstung (optional)'],
    city: ['Bequeme Stadtschuhe', 'Kleiner Tagesrucksack', 'Offline-Stadtplan']
  };

  const items = [
    ...base,
    ...climateItems[trip.climate],
    ...trip.activities.flatMap(a => activityItems[a])
  ];

  // Deduplizieren
  const unique = [...new Set(items)];
  return `🧳 Packliste für ${trip.name} (${trip.climate}, ${trip.activities.join(', ')}):\n\n` +
    unique.map(i => `• ${i}`).join('\n');
}
