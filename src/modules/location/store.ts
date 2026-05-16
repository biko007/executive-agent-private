/**
 * location/store — Postgres-backed location event storage (Sprint 8)
 */
import { query as dbQuery } from '../../shared/db/index.js';

export async function insertLocationEvent(params: {
  lat: number; lon: number; label: string;
  altitude?: number | null; source?: string;
}): Promise<{ id: number; recorded_at: string; lat: number; lon: number; label: string }> {
  const { rows } = await dbQuery(
    `INSERT INTO location_events (recorded_at, lat, lon, altitude_m, source, label, geocoded_at)
     VALUES (NOW(), $1, $2, $3, $4, $5, NOW())
     RETURNING id, recorded_at, lat, lon, label`,
    [params.lat, params.lon, params.altitude ?? null, params.source ?? 'ios_shortcut', params.label],
  );
  return rows[0];
}

export async function getLatestLocation(): Promise<{
  lat: number; lon: number; label: string; updatedAt: string;
} | null> {
  const { rows } = await dbQuery(
    `SELECT lat::float, lon::float, label, recorded_at AS "updatedAt"
     FROM location_events ORDER BY recorded_at DESC LIMIT 1`,
  );
  return rows[0] ?? null;
}
