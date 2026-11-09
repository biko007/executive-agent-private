/**
 * Sonnen- und Mondzeiten in Ortszeit, Ortszeit-Hinweis, Zeitzone in der
 * Briefing-API (Owner-Befund 09.11.2026, Winnipeg).
 */
import { describe, test, expect, afterEach } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { astroOrtszeit, ortszeitHinweis, zoneAusOpenMeteo, ortsMitternacht } from '../ortszeit.js';
import { mitZeitzone, speichereZeitzone, leseZeitzonen, type BriefingEintrag } from '../store.js';
import { fetchWeatherBriefing } from '../../travel/weather.js';

/* Feste Open-Meteo-Antworten (gekürzt auf die genutzten Felder). */
const OM_WINNIPEG = {
  latitude: 49.9, longitude: -97.14, timezone: 'America/Winnipeg', timezone_abbreviation: 'GMT-6', utc_offset_seconds: -21600,
  current: { temperature_2m: -3.2, weather_code: 3, pressure_msl: 1018.4 },
  hourly: {
    time: ['2026-11-08T21:00', '2026-11-08T22:00', '2026-11-08T23:00', '2026-11-09T00:00', '2026-11-09T01:00', '2026-11-09T02:00'],
    precipitation: [0, 0, 0, 0, 0.2, 0], pressure_msl: [1017, 1017.5, 1018, 1018.4, 1018.6, 1018.8],
  },
  daily: {
    time: ['2026-11-09', '2026-11-10', '2026-11-11'],
    temperature_2m_max: [1, 3, -2], temperature_2m_min: [-6, -4, -9], weather_code: [3, 71, 0],
    wind_speed_10m_max: [22, 30, 15], precipitation_sum: [0.2, 2.4, 0], uv_index_max: [1, 1, 2],
  },
};
const OM_TUTTLINGEN = { ...OM_WINNIPEG, timezone: 'Europe/Berlin', timezone_abbreviation: 'CET', utc_offset_seconds: 3600 };

/* 07:00 Berlin am 09.11.2026 = 00:00 Winnipeg. */
const JETZT = new Date('2026-11-09T06:00:00Z');
const WPG = { lat: 49.8951, lon: -97.1384 };
const TUT = { lat: 47.985, lon: 8.8233 };
const WPG6 = { zeitzone: 'America/Winnipeg', utcOffsetMin: -360 };

describe('Sonne/Mond in Ortszeit', () => {
  test('Winnipeg (UTC−6): Ortszeit statt Berliner Zeit', () => {
    const zone = zoneAusOpenMeteo(OM_WINNIPEG)!;
    expect(zone).toEqual({ zeitzone: 'America/Winnipeg', utcOffsetMin: -360 });
    const a = astroOrtszeit(JETZT, WPG.lat, WPG.lon, zone);
    expect(a.sunrise).toBe('07:32');
    expect(a.sunset).toBe('16:54');
    expect(a.moonrise).toBe('08:26');
    expect(a.moonset).toBe('16:36');
    expect(a.moonPhase).toBe('Neumond');
    expect(a.illumination).toBe(0);
  });

  test('Winnipeg bisher (Europe/Berlin) zeigte die Zeiten um 7 h verschoben', () => {
    const a = astroOrtszeit(JETZT, WPG.lat, WPG.lon, null);
    expect(a.sunrise).toBe('14:32');
    expect(a.moonrise).toBe('15:26');
  });

  test('Tuttlingen (UTC+1): unverändert Berliner Zeit', () => {
    const zone = zoneAusOpenMeteo(OM_TUTTLINGEN)!;
    expect(zone).toEqual({ zeitzone: 'Europe/Berlin', utcOffsetMin: 60 });
    const a = astroOrtszeit(JETZT, TUT.lat, TUT.lon, zone);
    expect(a.sunrise).toBe('07:22');
    expect(a.sunset).toBe('16:57');
    expect(a.moonrise).toBe('07:52');
    expect(a.moonset).toBe('16:33');
  });

  test('Tagesbezug ist der Kalendertag am Ort', () => {
    /* 05:30 UTC = 06:30 Berlin am 09.11., aber 23:30 Winnipeg am 08.11. */
    const spaet = new Date('2026-11-09T05:30:00Z');
    const z = { zeitzone: 'America/Winnipeg', utcOffsetMin: -360 };
    expect(ortsMitternacht(z, spaet).toISOString()).toBe('2026-11-08T06:00:00.000Z');
    const a = astroOrtszeit(spaet, WPG.lat, WPG.lon, z);
    const b = astroOrtszeit(new Date('2026-11-08T18:00:00Z'), WPG.lat, WPG.lon, z);
    expect(a.sunrise).toBe(b.sunrise);
  });

  test('ohne Zone → Europe/Berlin; ungültige Zone wird verworfen', () => {
    expect(astroOrtszeit(JETZT, TUT.lat, TUT.lon, null).sunrise).toBe('07:22');
    expect(zoneAusOpenMeteo({ timezone: 'Mars/Olympus' })).toBeNull();
    expect(zoneAusOpenMeteo({})).toBeNull();
  });
});

describe('Abstand aus der Datenquelle, nicht aus der Laufzeit-Zonendatenbank', () => {
  test('Winnipeg mit UTC−5 (Open-Meteo/tzdata 2026e, 09.11.2026): eine Stunde später', () => {
    const z = zoneAusOpenMeteo({ ...OM_WINNIPEG, timezone_abbreviation: 'GMT-5', utc_offset_seconds: -18000 })!;
    expect(z.utcOffsetMin).toBe(-300);
    const a = astroOrtszeit(JETZT, WPG.lat, WPG.lon, z);
    expect(a.sunrise).toBe('08:32');
    expect(a.moonrise).toBe('09:26');
    expect(ortszeitHinweis(z, JETZT)).toBe(' (Ortszeit, MEZ −6 h)');
  });
  test('Polartag/-nacht: kein Absturz', () => {
    const a = astroOrtszeit(new Date('2026-12-21T12:00:00Z'), 78.22, 15.65, { zeitzone: 'Arctic/Longyearbyen', utcOffsetMin: 60 });
    expect(a.sunrise).toBe('–');
  });
});

describe('Kopfzeile', () => {
  test('mit Ortszeit-Hinweis (Winnipeg)', () => {
    expect(`📍 Winnipeg${ortszeitHinweis(WPG6, JETZT)}`).toBe('📍 Winnipeg (Ortszeit, MEZ −7 h)');
  });
  test('Sommerzeit: MESZ', () => {
    expect(ortszeitHinweis({ zeitzone: 'America/Winnipeg', utcOffsetMin: -300 }, new Date('2026-07-01T10:00:00Z'))).toBe(' (Ortszeit, MESZ −7 h)');
  });
  test('halbe Stunden', () => {
    expect(ortszeitHinweis({ zeitzone: 'Asia/Kolkata', utcOffsetMin: 330 }, JETZT)).toBe(' (Ortszeit, MEZ +4,5 h)');
  });
  test('ohne Hinweis bei Berliner Zeit oder gleichem Abstand', () => {
    expect(ortszeitHinweis({ zeitzone: 'Europe/Berlin', utcOffsetMin: 60 }, JETZT)).toBe('');
    expect(ortszeitHinweis({ zeitzone: 'Europe/Zurich', utcOffsetMin: 60 }, JETZT)).toBe('');
    expect(ortszeitHinweis(null, JETZT)).toBe('');
  });
});

describe('Wetter in Ortszeit', () => {
  const echt = globalThis.fetch;
  afterEach(() => { globalThis.fetch = echt; });

  test('fragt timezone=auto an, liefert Zeitzone und Regenstunde in Ortszeit', async () => {
    let url = '';
    globalThis.fetch = (async (u: any) => { url = String(u); return new Response(JSON.stringify(OM_WINNIPEG), { status: 200 }); }) as any;
    const w = await fetchWeatherBriefing(WPG.lat, WPG.lon);
    expect(url).toContain('timezone=auto');
    expect(url).not.toContain('Europe%2FBerlin');
    expect(w.zeitzone).toBe('America/Winnipeg');
    expect(w.utcOffsetMin).toBe(-360);
    expect(w.todayRainHour).toBe(1);
    expect(w.days[0]).toMatchObject({ min: -6, max: 1 });
  });
});

describe('Briefing-API: zeitzone/utcOffsetMin', () => {
  const basis = (art: 'morgen' | 'abend', datum: string): BriefingEintrag => ({
    art, datum, textHtml: 'x', status: 'gesendet', versuche: 1, telegramOk: true, mailOk: null,
    fehler: null, fehlerGemeldet: false, erzeugtAt: '2026-11-09T06:00:01.000Z', gesendetAt: '2026-11-09T06:00:02.000Z',
  });
  let tmp = '';
  afterEach(() => { if (tmp) fs.rmSync(tmp, { recursive: true, force: true }); tmp = ''; });

  test('Feld vorhanden mit Eintrag, fehlt ohne Eintrag', () => {
    const [mit, ohne] = mitZeitzone([basis('morgen', '2026-11-09'), basis('morgen', '2026-11-08')],
      { 'morgen|2026-11-09': { zeitzone: 'America/Winnipeg', utcOffsetMin: -360 } });
    expect(mit.zeitzone).toBe('America/Winnipeg');
    expect(mit.utcOffsetMin).toBe(-360);
    expect('zeitzone' in ohne).toBe(false);
    expect('utcOffsetMin' in ohne).toBe(false);
    expect(JSON.parse(JSON.stringify(ohne)).zeitzone).toBeUndefined();
  });

  test('Datei schreiben und lesen', () => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bz-'));
    const datei = path.join(tmp, 'sub', 'zeitzonen.json');
    expect(leseZeitzonen(datei)).toEqual({});
    speichereZeitzone('morgen', '2026-11-09', { zeitzone: 'America/Winnipeg', utcOffsetMin: -360 }, datei);
    speichereZeitzone('morgen', '2026-11-10', { zeitzone: 'America/Vancouver', utcOffsetMin: -480 }, datei);
    expect(leseZeitzonen(datei)).toEqual({
      'morgen|2026-11-09': { zeitzone: 'America/Winnipeg', utcOffsetMin: -360 },
      'morgen|2026-11-10': { zeitzone: 'America/Vancouver', utcOffsetMin: -480 },
    });
  });
});
