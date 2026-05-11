/**
 * travel/weather — Open-Meteo weather fetching & WMO code translation.
 */
import { fetchWithTimeout } from '../../shared/utils/index.js';
import type { WeatherBriefing, WeatherDay, WeatherDayData } from './types.js';

// ── WMO Weather Codes ──────────────────────────────────────────────────────

const WMO_CODES: Record<number, string> = {
  0: 'sonnig ☀️', 1: 'überwiegend sonnig ☀️', 2: 'leicht bewölkt ⛅', 3: 'bewölkt ☁️',
  45: 'Nebel 🌫️', 48: 'Reifnebel 🌫️',
  51: 'leichter Niesel 🌦️', 53: 'Niesel 🌦️', 55: 'starker Niesel 🌧️',
  56: 'gefrierender Niesel 🌧️', 57: 'starker gef. Niesel 🌧️',
  61: 'leichter Regen 🌧️', 63: 'Regen 🌧️', 65: 'starker Regen 🌧️',
  66: 'gefrierender Regen 🌧️', 67: 'starker gef. Regen 🌧️',
  71: 'leichter Schneefall 🌨️', 73: 'Schneefall 🌨️', 75: 'starker Schneefall 🌨️',
  77: 'Schneegriesel 🌨️',
  80: 'Regenschauer 🌦️', 81: 'starke Schauer 🌧️', 82: 'Sturzregen 🌧️',
  85: 'Schneeschauer 🌨️', 86: 'starke Schneeschauer 🌨️',
  95: 'Gewitter ⛈️', 96: 'Gewitter mit Hagel ⛈️', 99: 'starkes Hagelgewitter ⛈️',
};

export function wmoToText(code: number): string {
  return WMO_CODES[code] ?? `Code ${code}`;
}

// ── Weather Briefing (3-day, hourly rain, pressure) ────────────────────────

export async function fetchWeatherBriefing(lat: number, lon: number): Promise<WeatherBriefing> {
  const url =
    `https://api.open-meteo.com/v1/forecast` +
    `?latitude=${lat}&longitude=${lon}` +
    `&current=temperature_2m,weather_code,pressure_msl` +
    `&hourly=precipitation,pressure_msl&forecast_hours=24&past_hours=3` +
    `&daily=temperature_2m_max,temperature_2m_min,weather_code,wind_speed_10m_max,precipitation_sum,uv_index_max` +
    `&timezone=Europe%2FBerlin&forecast_days=3`;

  const res = await fetchWithTimeout(url, { method: 'GET' }, 15000);
  if (!res.ok) throw new Error(`Open-Meteo Fehler: ${res.status}`);

  const data: any = await res.json();

  const currentTemp = Math.round(data.current?.temperature_2m ?? 0);
  const currentDesc = wmoToText(data.current?.weather_code ?? 0);

  const d = data.daily;
  const days: [WeatherDayData, WeatherDayData, WeatherDayData] = [0, 1, 2].map(i => ({
    min: Math.round(d?.temperature_2m_min?.[i] ?? 0),
    max: Math.round(d?.temperature_2m_max?.[i] ?? 0),
    desc: wmoToText(d?.weather_code?.[i] ?? 0),
    wind: Math.round(d?.wind_speed_10m_max?.[i] ?? 0),
    precip: Math.round((d?.precipitation_sum?.[i] ?? 0) * 10) / 10,
    uv: Math.round(d?.uv_index_max?.[i] ?? 0),
  })) as [WeatherDayData, WeatherDayData, WeatherDayData];

  // Pressure + trend from hourly data (last 3h)
  const pressureHpa = Math.round(data.current?.pressure_msl ?? 0);
  const hourlyPressure: number[] = data.hourly?.pressure_msl ?? [];
  let pressureTrend: WeatherBriefing['pressureTrend'] = '→ stabil';
  if (hourlyPressure.length >= 4) {
    const oldest = hourlyPressure[0];
    const newest = hourlyPressure[hourlyPressure.length - 1];
    const diff = newest - oldest;
    if (diff > 1.5) pressureTrend = '↑ steigend';
    else if (diff < -1.5) pressureTrend = '↓ fallend';
  }

  // Find first hour with precipitation > 0
  let todayRainHour: number | null = null;
  const hourlyPrecip: number[] = data.hourly?.precipitation ?? [];
  const hourlyTimes: string[] = data.hourly?.time ?? [];
  for (let i = 0; i < hourlyPrecip.length; i++) {
    if (hourlyPrecip[i] > 0) {
      const h = new Date(hourlyTimes[i]).getHours();
      todayRainHour = h;
      break;
    }
  }

  return {
    currentTemp, currentDesc, todayRainHour, days, pressureHpa, pressureTrend,
    // legacy compat
    todayMin: days[0].min, todayMax: days[0].max,
    tomorrowMin: days[1].min, tomorrowMax: days[1].max, tomorrowDesc: days[1].desc,
  };
}

// ── 7-day Forecast (for trip creation) ─────────────────────────────────────

export async function fetchWeatherForecast(lat: number, lon: number): Promise<WeatherDay[]> {
  const url =
    `https://api.open-meteo.com/v1/forecast` +
    `?latitude=${lat}&longitude=${lon}` +
    `&daily=temperature_2m_max,temperature_2m_min,precipitation_sum` +
    `&timezone=auto&forecast_days=7`;

  const res = await fetchWithTimeout(url, { method: 'GET' }, 15000);
  if (!res.ok) throw new Error(`Open-Meteo Fehler: ${res.status}`);

  const data: any = await res.json();
  const d = data?.daily;
  if (!d?.time?.length) return [];

  return (d.time as string[]).map((date: string, i: number) => ({
    date,
    tmax:   Math.round(d.temperature_2m_max[i] ?? 0),
    tmin:   Math.round(d.temperature_2m_min[i] ?? 0),
    precip: Math.round((d.precipitation_sum[i] ?? 0) * 10) / 10,
  }));
}
