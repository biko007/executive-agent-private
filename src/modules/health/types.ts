/**
 * health/types — Domain types for Health, Withings + Oura modules.
 */

// ── Health Entry Types ────────────────────────────────────────────────────

export type HealthEntryType =
  | 'weight'
  | 'body_fat'
  | 'sleep'
  | 'steps'
  | 'heartrate'
  | 'activity'
  | 'symptom'
  | 'log'
  | 'hrv'
  | 'readiness'
  | 'temperature';

export interface HealthEntry {
  id: string;
  type: HealthEntryType;
  timestamp: string;        // ISO 8601
  // weight / body_fat / sleep (value + unit)
  value?: number;           // kg (weight), % (body_fat), h (sleep)
  unit?: string;
  // sleep
  quality?: number;         // 1–5 (manual) | sleep score 0–100
  deep_sleep_h?: number;
  rem_sleep_h?: number;
  light_sleep_h?: number;
  // steps / activity
  steps?: number;
  distance_m?: number;
  calories?: number;
  activity_type?: string;   // 'running', 'walking', etc.
  duration_min?: number;
  // heart rate
  hr_avg?: number;
  hr_min?: number;
  hr_max?: number;
  // hrv
  hrv_ms?: number;          // HRV in milliseconds (RMSSD)
  // readiness
  readiness_score?: number; // 0–100
  readiness_contributors?: Record<string, number>;
  // temperature
  temp_deviation?: number;  // deviation from baseline in °C
  // free text
  text?: string;
  // source
  source?: 'manual' | 'withings' | 'oura' | 'system';
}

// ── Summary ───────────────────────────────────────────────────────────────

export interface HealthSummary {
  from: string;
  to: string;
  weights: number[];
  bodyFats: number[];
  sleepHours: number[];
  deepSleepHours: number[];
  remSleepHours: number[];
  sleepScores: number[];
  stepsArr: number[];
  hrAvgs: number[];
  activities: string[];
  symptoms: string[];
  logs: string[];
}

// ── Trends + Alerts ───────────────────────────────────────────────────────

export type TrendDirection = 'up' | 'down' | 'stable';

export interface WeightTrend {
  current: number;
  min: number;
  max: number;
  avg: number;
  change: number;
  direction: TrendDirection;
  dataPoints: number;
}

export interface SleepTrend {
  avgDuration: number;
  minDuration: number;
  maxDuration: number;
  avgQuality: number;
  dataPoints: number;
}

export interface HeartrateTrend {
  current: number;
  avg: number;
  dataPoints: number;
}

export interface HrvTrend {
  current: number;
  avg: number;
  min: number;
  max: number;
  change: number;
  direction: TrendDirection;
  dataPoints: number;
}

export type AlertSeverity = 'info' | 'warning' | 'critical';

export interface HealthAlert {
  type: string;
  severity: AlertSeverity;
  message: string;
}

// ── Withings Types ────────────────────────────────────────────────────────

export interface WithingsTokens {
  access_token: string;
  refresh_token: string;
  expires_at: number;    // epoch ms
  userid: string;
  last_sync?: number;    // epoch ms
}

export interface WithingsMeasure {
  date: Date;
  weight_kg?: number;
  fat_ratio_pct?: number;
  fat_mass_kg?: number;
  fat_free_kg?: number;
  hr_bpm?: number;
}

export interface WithingsSleep {
  date: string;           // YYYY-MM-DD
  total_h: number;
  deep_h: number;
  rem_h: number;
  light_h: number;
  score?: number;         // 0–100
}

export interface WithingsActivity {
  date: string;           // YYYY-MM-DD
  steps: number;
  distance_m: number;
  calories: number;
  active_min: number;
  hr_avg?: number;
  hr_min?: number;
  hr_max?: number;
}

export interface WithingsWorkout {
  date: string;
  activity_type: string;
  duration_min: number;
  steps?: number;
  distance_m?: number;
  calories?: number;
  hr_avg?: number;
}

// ── Oura Types ────────────────────────────────────────────────────────────

export interface OuraTokens {
  access_token: string;
  refresh_token: string;
  expires_at: number;    // epoch ms
  last_sync?: number;    // epoch ms
}

export interface OuraSleepDocument {
  id: string;
  day: string;            // YYYY-MM-DD
  total_sleep_duration: number;  // seconds
  deep_sleep_duration: number;
  rem_sleep_duration: number;
  light_sleep_duration: number;
  score?: number;         // 0–100
  average_hrv?: number;   // ms
  lowest_heart_rate?: number;
  average_heart_rate?: number;
  temperature_deviation?: number; // °C
}

export interface OuraReadinessDocument {
  id: string;
  day: string;            // YYYY-MM-DD
  score?: number;         // 0–100
  contributors?: Record<string, number>;
}

export interface OuraActivityDocument {
  id: string;
  day: string;            // YYYY-MM-DD
  steps: number;
  equivalent_walking_distance: number;  // meters
  total_calories: number;
  active_calories: number;
}

export interface OuraSyncResult {
  synced_count: number;
  new_count: number;
  last_sync: string;
  status: 'ok' | 'error';
}
