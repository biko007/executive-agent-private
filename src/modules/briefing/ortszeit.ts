/**
 * briefing/ortszeit — Sonnen- und Mondzeiten in der Ortszeit des Briefing-Orts
 * (Owner-Befund 09.11.2026, Winnipeg: Zeiten standen in Berliner Zeit).
 *
 * Die Zeitzone kommt aus der Open-Meteo-Antwort (`timezone=auto` liefert
 * `timezone` und `utc_offset_seconds`). Berechnet wird weiter mit suncalc —
 * keine neue Abhängigkeit. Der Tagesbezug ist der Kalendertag am Ort.
 */
import SunCalc from 'suncalc';

export const BERLIN = 'Europe/Berlin';

export interface OrtsZeitzone {
  /** IANA, z. B. „America/Winnipeg“ */
  zeitzone: string;
  /** Abstand zu UTC in Minuten, z. B. −360 */
  utcOffsetMin: number;
}

export interface AstroDaten {
  sunrise: string;
  sunset: string;
  moonrise: string | null;
  moonset: string | null;
  moonIcon: string;
  moonPhase: string;
  illumination: number;
}

/** Ist die Zone eine gültige IANA-Zone? */
export function zoneGueltig(zone: string | null | undefined): zone is string {
  if (!zone) return false;
  try { new Intl.DateTimeFormat('en-US', { timeZone: zone }); return true; } catch { return false; }
}

/** Abstand der Zone zu UTC in Minuten zum Zeitpunkt `at` (ohne Abhängigkeit). */
export function zonenOffsetMin(zone: string, at: Date): number {
  const teile = new Intl.DateTimeFormat('en-US', {
    timeZone: zone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  }).formatToParts(at);
  const w = (t: string) => Number(teile.find((p) => p.type === t)?.value);
  const alsUtc = Date.UTC(w('year'), w('month') - 1, w('day'), w('hour'), w('minute'), w('second'));
  return Math.round((alsUtc - Math.floor(at.getTime() / 1000) * 1000) / 60_000);
}

/* Abstand zu UTC: maßgeblich ist `utcOffsetMin` aus der Datenquelle, nicht
   die Zonendatenbank der Laufzeit. Node 22 / Bun bringen ICU-tz 2026a mit und
   führen Winnipeg im November 2026 noch auf UTC−6; System-tzdata 2026e und
   Open-Meteo sagen UTC−5 (Befund 09.11.2026). Intl dient nur als Rückfall. */
function abstandMin(zone: OrtsZeitzone | null | undefined, at: Date): number {
  if (zone && Number.isFinite(zone.utcOffsetMin)) return Math.round(zone.utcOffsetMin);
  return zonenOffsetMin(zone && zoneGueltig(zone.zeitzone) ? zone.zeitzone : BERLIN, at);
}

/** Kalendertag am Ort, YYYY-MM-DD. */
export function ortsDatum(zone: OrtsZeitzone | null | undefined, at: Date): string {
  return new Date(at.getTime() + abstandMin(zone, at) * 60_000).toISOString().slice(0, 10);
}

/** Mitternacht des Ortskalendertags als Zeitpunkt (UTC). */
export function ortsMitternacht(zone: OrtsZeitzone | null | undefined, at: Date): Date {
  const off = abstandMin(zone, at) * 60_000;
  return new Date(Math.floor((at.getTime() + off) / 86_400_000) * 86_400_000 - off);
}

/** HH:MM in Ortszeit. */
function uhrzeit(d: Date, offMin: number): string {
  if (!(d instanceof Date) || !Number.isFinite(d.getTime())) return '–';
  return new Date(d.getTime() + offMin * 60_000).toISOString().slice(11, 16);
}

function mondphase(phase: number): { moonIcon: string; moonPhase: string } {
  if (phase < 0.03 || phase >= 0.97) return { moonIcon: '🌑', moonPhase: 'Neumond' };
  if (phase < 0.22) return { moonIcon: '🌒', moonPhase: 'Zunehmende Sichel' };
  if (phase < 0.28) return { moonIcon: '🌓', moonPhase: 'Erstes Viertel' };
  if (phase < 0.47) return { moonIcon: '🌔', moonPhase: 'Zunehmender Mond' };
  if (phase < 0.53) return { moonIcon: '🌕', moonPhase: 'Vollmond' };
  if (phase < 0.72) return { moonIcon: '🌖', moonPhase: 'Abnehmender Mond' };
  if (phase < 0.78) return { moonIcon: '🌗', moonPhase: 'Letztes Viertel' };
  return { moonIcon: '🌘', moonPhase: 'Abnehmende Sichel' };
}

/**
 * Sonne und Mond für den Ortskalendertag, formatiert in der Ortszeit.
 * Mondphase und Beleuchtung gelten wie bisher für den Zeitpunkt `jetzt`.
 */
export function astroOrtszeit(jetzt: Date, lat: number, lon: number, zone: OrtsZeitzone | null = null): AstroDaten {
  const off = abstandMin(zone, jetzt);
  const fmt = (d: Date) => uhrzeit(d, off);
  const beginn = ortsMitternacht(zone, jetzt);
  const ende = new Date(beginn.getTime() + 24 * 3600_000);

  /* Sonne: suncalc rechnet den Sonnentag um den übergebenen Zeitpunkt —
     Ortsmittag trifft sicher den Ortskalendertag. */
  const sonne = SunCalc.getTimes(new Date(beginn.getTime() + 12 * 3600_000), lat, lon);

  /* Mond: suncalc sucht 24 h ab UTC-Mitternacht. Drei UTC-Tage abfragen und
     das erste Ereignis im Ortskalendertag nehmen. */
  const im = (d: Date | undefined) => !!d && d.getTime() >= beginn.getTime() && d.getTime() < ende.getTime();
  const tag0 = Date.UTC(beginn.getUTCFullYear(), beginn.getUTCMonth(), beginn.getUTCDate());
  const aufgaenge: Date[] = [];
  const untergaenge: Date[] = [];
  for (const k of [-1, 0, 1]) {
    const mt: any = SunCalc.getMoonTimes(new Date(tag0 + k * 86_400_000), lat, lon, true);
    if (im(mt.rise)) aufgaenge.push(mt.rise);
    if (im(mt.set)) untergaenge.push(mt.set);
  }
  const erstes = (l: Date[]) => l.sort((a, b) => a.getTime() - b.getTime())[0];
  const mond = SunCalc.getMoonIllumination(jetzt);

  return {
    sunrise: fmt(sonne.sunrise),
    sunset: fmt(sonne.sunset),
    moonrise: aufgaenge.length ? fmt(erstes(aufgaenge)) : null,
    moonset: untergaenge.length ? fmt(erstes(untergaenge)) : null,
    ...mondphase(mond.phase),
    illumination: Math.round(mond.fraction * 100),
  };
}

/**
 * Zusatz hinter dem Ort, wenn die Ortszeit von Berlin abweicht:
 * „ (Ortszeit, MEZ −7 h)“. Gleicher Abstand (z. B. Zürich) → kein Zusatz.
 */
export function ortszeitHinweis(zone: OrtsZeitzone | null | undefined, at: Date): string {
  if (!zone) return '';
  const berlin = zonenOffsetMin(BERLIN, at);
  const diffMin = abstandMin(zone, at) - berlin;
  if (diffMin === 0) return '';
  const berlinKurz = berlin === 120 ? 'MESZ' : 'MEZ';
  const std = Math.abs(diffMin) / 60;
  const zahl = Number.isInteger(std) ? String(std) : std.toFixed(1).replace('.', ',');
  return ` (Ortszeit, ${berlinKurz} ${diffMin < 0 ? '−' : '+'}${zahl} h)`;
}

/** Zone aus einer Open-Meteo-Antwort; null, wenn sie fehlt oder ungültig ist. */
export function zoneAusOpenMeteo(data: any): OrtsZeitzone | null {
  const zone = data?.timezone;
  if (!zoneGueltig(zone)) return null;
  const sek = Number(data?.utc_offset_seconds);
  return { zeitzone: zone, utcOffsetMin: Number.isFinite(sek) ? Math.round(sek / 60) : zonenOffsetMin(zone, new Date()) };
}
