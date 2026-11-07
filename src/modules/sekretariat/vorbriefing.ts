/**
 * sekretariat/vorbriefing — Vorlauf-Suche 15 Minuten vor jedem Briefing
 * (Vorschlag 4a, Owner-Freigabe 07.11.2026 11:53).
 *
 * Zwei Bausteine für `scripts/neuheiten-stunde.ts --vorbriefing`:
 *   - Kostendeckel je Lauf (Vorgabe 1,50 $): `VORBRIEFING_DECKEL_USD`, geprüft
 *     in `verarbeite` (`kostenDeckelUsd`) vor jedem KI-Aufruf; der Rest bleibt
 *     „wartet" und kommt im nächsten Lauf dran. Das Briefing meldet den Abbruch.
 *   - Zuordnungsfragen: Vorgänge, die in diesem Lauf neu entstanden oder ein
 *     Element bekamen und eine Freigabe brauchen, als kurze Zeilen mit
 *     Freigabewort. Die Detailauswertung macht weiter der Chat anhand der
 *     Stundenreports — hier nur die Erfassung.
 */
import { VORSCHLAG_TEXT } from './schema.js';
import { anzeigeName } from './kurz.js';
import type { Vorgang } from './lauf.js';

export const VORBRIEFING_DECKEL_USD = 1.5;

/** Zeilen für den Briefing-Abschnitt; nur Vorgänge, die eine Freigabe brauchen. */
export function zuordnungsFragen(vorgaenge: Vorgang[], textSicher: (t: string) => string = (t) => t) {
  return vorgaenge
    .filter((v) => v.status === 'offen' && v.vorschlag !== 'f')
    .map((v) => {
      const kurz = anzeigeName(v);
      const schritt = String(v.naechsterSchritt || '').replace(/\s+/g, ' ').trim();
      const frage = `${VORSCHLAG_TEXT[v.vorschlag] ?? v.vorschlag}${schritt ? ` – ${schritt.slice(0, 110)}${schritt.length > 110 ? '…' : ''}` : ''}`;
      return { kurz: textSicher(kurz), frage: textSicher(frage), freigabe: `Freigabe Vorgang ${kurz}` };
    });
}
