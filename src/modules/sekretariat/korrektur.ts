/**
 * sekretariat/korrektur — Korrekturen des Owners (Lernschleife, Stufe 1).
 *
 * Jede Korrektur aus dem Chat-Review wird in `korrekturen.jsonl` festgehalten:
 * Bezug (Vorgang/Element), Befund, und — wenn daraus eine allgemeine Regel
 * folgt — diese Regel in einem Satz. Die Regeln gehen bei jeder Bewertung als
 * Owner-Vorgaben mit ans Modell; bestätigte Beispiele ebenso, damit gute
 * Bündelungen wiederholt werden. Änderungen am Vorgang (Status, Vorschlag,
 * nächster Schritt, Verweis) werden direkt im Speicher angewendet.
 */

import fs from 'node:fs';
import path from 'node:path';
import type { Vorschlag } from './schema.js';
import { eindeutigeKurz, kurzGeglaettet, vergleichsSchluessel } from './kurz.js';

export interface Korrektur {
  zeit: string;
  /** z. B. „Chat-Review Nachlauf 27.10.2026" */
  quelle: string;
  art: 'fehler' | 'bestaetigt';
  bezug: string[];
  befund: string;
  /** Allgemeine Regel für die KI (ein Satz) — nur, wenn es über den Einzelfall hinausgeht. */
  regel?: string;
  aenderung?: {
    vorgang: string;
    status?: 'offen' | 'wartet' | 'erledigt';
    /** Kurzbezeichnung umbenennen (Owner-Wunsch); Eindeutigkeit prüft das Korrekturskript. */
    kurz?: string;
    wartetAuf?: string;
    verweis?: string;
    vorschlag?: Vorschlag;
    naechsterSchritt?: string;
    begruendung?: string;
    /** Fristen ohne Objekt (z. B. Steuer, ELSTER), die das Abendbriefing ab ihrem Vorlauf zeigt. */
    /** `angelegt` (ISO) setzt wendeAn, falls es fehlt — der Fristen-Abgleich prüft nur ab dort. */
    fristen?: Array<{ termin: string; was: string; vorlaufTage?: number; an?: string[]; angelegt?: string }>;
  };
}

const datei = (zustand: string) => path.join(zustand, 'korrekturen.jsonl');

export function ladeKorrekturen(zustand: string): Korrektur[] {
  try {
    return fs.readFileSync(datei(zustand), 'utf-8').split('\n').filter(Boolean)
      .map((z) => { try { return JSON.parse(z) as Korrektur; } catch { return null; } })
      .filter((k): k is Korrektur => !!k);
  } catch { return []; }
}

export function speichereKorrektur(zustand: string, k: Korrektur): void {
  fs.mkdirSync(zustand, { recursive: true });
  fs.appendFileSync(datei(zustand), JSON.stringify(k) + '\n');
}

/** Zeilen für die Owner-Vorgaben im System-Prompt: Regeln und bestätigte Beispiele (je höchstens 40). */
export function korrekturZeilen(alle: Korrektur[]): string[] {
  const regeln = [...new Set(alle.filter((k) => k.regel).map((k) => k.regel!))].slice(-40);
  const beispiele = alle.filter((k) => k.art === 'bestaetigt').slice(-40).map((k) => `Richtig bewertet (Beispiel): ${k.befund}`);
  return [...regeln.map((r) => `Korrektur des Owners: ${r}`), ...beispiele];
}

/** Änderung am Vorgang anwenden; liefert false, wenn der Vorgang fehlt. */
export function wendeAn(vorgaenge: Array<Record<string, any>>, k: Korrektur, zeit: string): boolean {
  if (!k.aenderung) return true;
  /* Vorgang per Kennung oder Kurzbezeichnung (tolerant wie die Freigabe). */
  const ziel = k.aenderung.vorgang;
  const v = vorgaenge.find((x) => x.kennung === ziel)
    ?? vorgaenge.find((x) => x.kurz && vergleichsSchluessel(x.kurz) === vergleichsSchluessel(ziel));
  if (!v) return false;
  const { vorgang: _v, ...felder } = k.aenderung;
  if (felder.kurz !== undefined) {
    const g = kurzGeglaettet(felder.kurz);
    if (g) felder.kurz = eindeutigeKurz(g, vorgaenge.filter((x) => x !== v).map((x) => x.kurz).filter(Boolean));
    else delete felder.kurz;
  }
  for (const [feld, wert] of Object.entries(felder)) if (wert !== undefined) v[feld] = wert;
  if (Array.isArray(v.fristen)) for (const f of v.fristen) if (f && !f.angelegt) f.angelegt = zeit;
  if (k.aenderung.status && k.aenderung.status !== 'wartet') delete v.wartetAuf;
  v.aktualisiert = zeit;
  return true;
}
