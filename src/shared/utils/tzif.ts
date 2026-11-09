/**
 * shared/utils/tzif — UTC-Abstand aus der Zonendatenbank des Systems
 * (/usr/share/zoneinfo, TZif v2+), ohne neue Abhängigkeit.
 *
 * ANLASS (09.11.2026): Node 22 und Bun bringen ICU-tz 2026a mit und rechnen
 * Winnipeg nach dem 01.11.2026 noch mit UTC−6. Manitoba bleibt aber dauerhaft
 * auf UTC−5; das System-tzdata (Ubuntu 2026e) kennt das. Wer einen Abstand für
 * einen Zeitpunkt braucht, fragt hier zuerst und fällt nur bei `null` auf
 * Intl zurück.
 *
 * `null` heißt: Datei fehlt/unlesbar, oder der Zeitpunkt liegt hinter dem
 * letzten Übergang und die Zone hat eine laufende Sommerzeitregel (Fußzeile
 * mit Komma) — die rechnet diese Funktion bewusst nicht nach.
 */
import fs from 'node:fs';
import path from 'node:path';

interface Zonendaten {
  uebergaenge: number[]; // Sekunden UTC, aufsteigend
  typIndex: number[];
  versatzSek: number[];
  regelImFuss: boolean;
}

const cache = new Map<string, Zonendaten | null>();
let wurzel = '/usr/share/zoneinfo';

/** Nur für Tests: anderes Verzeichnis, Cache leeren. */
export function setzeZoneinfoWurzel(dir: string): void { wurzel = dir; cache.clear(); }

function lies(zone: string): Zonendaten | null {
  if (cache.has(zone)) return cache.get(zone)!;
  let daten: Zonendaten | null = null;
  try {
    if (!/^[A-Za-z0-9_+\-]+(\/[A-Za-z0-9_+\-]+)*$/.test(zone)) throw new Error('Zonenname');
    const b = fs.readFileSync(path.join(wurzel, zone));
    if (b.toString('latin1', 0, 4) !== 'TZif' || b[4] < 0x32) throw new Error('kein TZif v2');
    const zahlen = (o: number) => [0, 1, 2, 3, 4, 5].map((i) => b.readUInt32BE(o + 20 + i * 4));
    const [isut1, isstd1, leap1, time1, type1, char1] = zahlen(0);
    let o = 44 + time1 * 4 + time1 + type1 * 6 + char1 + leap1 * 8 + isstd1 + isut1;
    const [isut, isstd, leap, time, type, char] = zahlen(o);
    o += 44;
    const uebergaenge: number[] = [];
    for (let i = 0; i < time; i++) uebergaenge.push(Number(b.readBigInt64BE(o + i * 8)));
    o += time * 8;
    const typIndex: number[] = [];
    for (let i = 0; i < time; i++) typIndex.push(b[o + i]);
    o += time;
    const versatzSek: number[] = [];
    for (let i = 0; i < type; i++) versatzSek.push(b.readInt32BE(o + i * 6));
    o += type * 6 + char + leap * 12 + isstd + isut;
    const fuss = b.toString('latin1', o).split('\n')[1] ?? '';
    daten = { uebergaenge, typIndex, versatzSek, regelImFuss: fuss.includes(',') };
  } catch { daten = null; }
  cache.set(zone, daten);
  return daten;
}

/** UTC-Abstand der Zone in Minuten zum Zeitpunkt `utcMs`, oder null. */
export function tzdataVersatzMin(zone: string, utcMs: number): number | null {
  const d = lies(zone);
  if (!d || !d.versatzSek.length) return null;
  const t = Math.floor(utcMs / 1000);
  const n = d.uebergaenge.length;
  if (n === 0) return d.regelImFuss ? null : Math.round(d.versatzSek[0] / 60);
  if (t >= d.uebergaenge[n - 1] && d.regelImFuss) return null;
  let lo = 0, hi = n - 1, treffer = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (d.uebergaenge[mid] <= t) { treffer = mid; lo = mid + 1; } else hi = mid - 1;
  }
  const typ = treffer < 0 ? 0 : d.typIndex[treffer];
  const sek = d.versatzSek[typ];
  return Number.isFinite(sek) ? Math.round(sek / 60) : null;
}
