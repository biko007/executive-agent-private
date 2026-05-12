/**
 * health/types — Domain types for Health + Withings modules.
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
  | 'log';

export interface HealthEntry {
  id: string;
  type: HealthEntryType;
  timestamp: string;        // ISO 8601
  // weight / body_fat
  value?: number;           // kg (weight), % (body_fat)
  unit?: string;
  // sleep
  quality?: number;         // 1–5 (manual) | Withings sleep score 0–100
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
  // free text
  text?: string;
  // source
  source?: 'manual' | 'withings';
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
