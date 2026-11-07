/**
 * banking/erinnerung — Montagserinnerung statt Abgleichslauf (Vorschlag 4e,
 * Owner-Freigabe 07.11.2026 13:10).
 *
 * Institute mit `abgleichNurUeberVerbinden` (Volksbank) stößt der Montagslauf
 * nicht mehr per FinTS an: Jeder neue Dialog ohne App-Freigabe endet dort mit
 * 9050/9800/9340 (Diagnose 07.11.2026). Stattdessen kommt zur selben Zeit eine
 * Erinnerung mit Link — außer der letzte Abruf über „Bank verbinden" ist
 * jünger als 3 Tage; dann nur ein Vermerk im Lauf (Wochencheck liest ihn).
 *
 * Pure Funktionen; Datenbank und Versand im Aufrufer (sync-engine.ts).
 */
import { BANK_VERBINDEN_LINK } from './meldung.js';

/** Status in banking_sync_runs (VARCHAR(40), ohne CHECK — keine Migration). */
export const STATUS_ERINNERUNG = 'REMINDER_SENT' as const;
export const STATUS_ERINNERUNG_UNTERDRUECKT = 'REMINDER_SKIPPED' as const;
export const FRISCH_TAGE = 3;

export interface AbrufStand {
  /** ISO: Ende des letzten erfolgreichen Abrufs über „Bank verbinden“; null = keiner bekannt */
  letzterAbruf: string | null;
  /** JJJJ-MM-TT: jüngster Buchungstag der aktiven Konten; null = keine Umsätze */
  buchungstagBis: string | null;
}

const datum = (iso: string) => {
  const t = new Date(iso);
  return new Intl.DateTimeFormat('de-DE', { timeZone: 'Europe/Berlin', day: '2-digit', month: '2-digit', year: 'numeric' }).format(t);
};

/** Ist der letzte Abruf frisch genug, dass die Erinnerung entfällt? */
export function abrufFrisch(stand: AbrufStand, jetzt: Date, tage = FRISCH_TAGE): boolean {
  if (!stand.letzterAbruf) return false;
  const t = Date.parse(stand.letzterAbruf);
  return Number.isFinite(t) && jetzt.getTime() - t < tage * 86_400_000;
}

/** „Letzter Abruf: 07.11.2026 (Buchungstag bis 06.11.2026)" — ohne Kontonummern. */
export function abrufText(stand: AbrufStand): string {
  const teile: string[] = [];
  teile.push(stand.letzterAbruf ? datum(stand.letzterAbruf) : 'unbekannt');
  if (stand.buchungstagBis) teile.push(`(Buchungstag bis ${datum(`${stand.buchungstagBis}T12:00:00Z`)})`);
  return `Letzter Abruf: ${teile.join(' ')}`;
}

/** Nachricht an den Owner (operativ). */
export function erinnerungText(kurzname: string, stand: AbrufStand): string {
  return `🏦 ${kurzname}: Umsätze bitte über „Bank verbinden“ abrufen (App-Freigabe nötig). ${abrufText(stand)}\n→ ${BANK_VERBINDEN_LINK}`;
}

/** Vermerk in banking_sync_runs.error_message für Wochencheck und Dashboard. */
export function erinnerungVermerk(gesendet: boolean, stand: AbrufStand): string {
  return `${gesendet ? 'Erinnerung gesendet' : `Erinnerung unterdrückt (Abruf jünger als ${FRISCH_TAGE} Tage)`} · ${abrufText(stand)}`;
}
