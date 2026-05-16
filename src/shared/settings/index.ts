/**
 * shared/settings — user settings persistence (settings.json).
 */
import fs from 'node:fs';
import path from 'node:path';

export interface LocationSetting {
  lat: number;
  lon: number;
  label: string;
  updatedAt?: string;
}

export interface Settings {
  briefingTime: string;
  telegramChatId?: string;
  healthReportDay?: number;
  location?: LocationSetting;
}

const SETTINGS_FILE = path.join(
  process.env.HOME || '/root',
  '.openclaw/workspace/artifacts/personal/health/settings.json',
);

export const DEFAULT_LOCATION: LocationSetting = {
  lat: 47.9838,
  lon: 8.8234,
  label: 'Tuttlingen',
};

export function loadSettings(): Settings {
  try {
    if (fs.existsSync(SETTINGS_FILE)) {
      return { briefingTime: '07:00', ...JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf-8')) };
    }
  } catch {}
  return { briefingTime: '07:00' };
}

export function saveSettings(s: Settings): void {
  fs.mkdirSync(path.dirname(SETTINGS_FILE), { recursive: true });
  fs.writeFileSync(SETTINGS_FILE, JSON.stringify(s, null, 2), 'utf-8');
}

/**
 * Get latest location from Postgres, with fallback to DEFAULT_LOCATION.
 * Async since Sprint 8 (was sync before).
 */
export async function getLocationSettings(): Promise<LocationSetting> {
  try {
    const { getLatestLocation } = await import('../../modules/location/store.js');
    const latest = await getLatestLocation();
    if (latest) return latest;
  } catch {}
  return DEFAULT_LOCATION;
}
