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

export function getLocationSettings(): LocationSetting {
  try {
    const s = loadSettings();
    if (s.location && s.location.lat != null && s.location.lon != null) {
      return s.location;
    }
  } catch {}
  return DEFAULT_LOCATION;
}
