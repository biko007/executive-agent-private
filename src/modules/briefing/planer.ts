/**
 * briefing/planer — Wann wird erzeugt, wann nachgeholt, wann gemeldet?
 *
 * Reine Funktion ohne Uhr und ohne Datenbank, damit jeder Fall testbar ist.
 *
 * ANLASS (Analyse 26.10.2026): Drei Fälle kosteten bisher das ganze Briefing
 * des Tages ohne jede Meldung — eine Laufzeit über 45 s, ein Fehler beim Lesen
 * der Gesundheitswerte und ein Gateway-Neustart genau um 07:00. Der Taktgeber
 * prüfte nur die eine Minute; danach passte die Uhrzeit nicht mehr.
 *
 * REGEL (Owner-Auftrag 26.10.2026): Fehlt das Briefing 15 Minuten nach der
 * Sollzeit, wird es EINMAL neu erzeugt; klappt auch das nicht, geht eine kurze
 * Fehlermeldung an Telegram. Das gilt für Morgen- und Abendbriefing gleich.
 */

/** Ab dieser Verspätung wird nachgeholt (Minuten nach der Sollzeit). */
export const NACHHOL_MINUTEN = 15;
/** Bis zu dieser Verspätung darf noch nachgeholt werden — danach ist der Anlass vorbei. */
export const NACHHOL_FENSTER_MINUTEN = 60;
/** Planmäßiger Versuch + ein Nachholversuch. */
export const MAX_VERSUCHE = 2;

export type Aktion = 'erzeugen' | 'nachholen' | 'fehlermeldung' | null;

export interface Tagesstand {
  status: 'erzeugt' | 'gesendet' | 'fehler';
  versuche: number;
  fehlerGemeldet: boolean;
}

/** "HH:MM" → Minuten seit Mitternacht; ungültig → null. */
export function minutenVon(hhmm: string): number | null {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(hhmm || '').trim());
  if (!m) return null;
  const h = Number(m[1]); const min = Number(m[2]);
  if (h > 23 || min > 59) return null;
  return h * 60 + min;
}

/**
 * Was ist in dieser Minute zu tun?
 *
 * @param jetzt   aktuelle Berliner Uhrzeit "HH:MM"
 * @param sollzeit eingestellte Uhrzeit "HH:MM"
 * @param stand   Eintrag des Tages oder null, wenn noch nichts versucht wurde
 */
export function naechsteAktion(jetzt: string, sollzeit: string, stand: Tagesstand | null): Aktion {
  const j = minutenVon(jetzt);
  const s = minutenVon(sollzeit);
  if (j === null || s === null) return null;
  if (stand?.status === 'gesendet') return null;
  if (stand?.fehlerGemeldet) return null;

  const versuche = stand?.versuche ?? 0;
  const verspaetung = j - s;

  // Planmäßig: genau in der Sollminute, nur wenn heute noch nichts versucht wurde.
  if (verspaetung === 0 && versuche === 0) return 'erzeugen';

  // Nachholfenster: ab +15 Minuten bis +60 Minuten. Ein Nachholversuch je Tag;
  // war der Gateway um die Sollzeit aus (versuche = 0), ist das der erste.
  if (verspaetung >= NACHHOL_MINUTEN && verspaetung < NACHHOL_FENSTER_MINUTEN) {
    if (versuche < MAX_VERSUCHE) return 'nachholen';
    return 'fehlermeldung';
  }
  return null;
}
