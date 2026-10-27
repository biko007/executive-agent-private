/**
 * sekretariat — Neuheiten verstehen und zu Vorgängen verknüpfen.
 *
 * Spec Neuheiten-Sekretariat v1 (Owner-Freigabe 27.10.2026, 12:11), Bau
 * Stufe 1: Verstehen (KI mit Kontext), Verknüpfen (Vorgänge), Statuskette,
 * zweites Netz, Nicht-relevant-Ablage, Kostenprotokoll. Vorbereiten und
 * Nachhalten (Ausführung der Schritte, Dashboard, Eskalation, Lernschleife)
 * sind Stufe 2.
 */
export { ARTEN, VORSCHLAEGE, VORSCHLAG_TEXT, pruefeBewertung, SCHEMA_TEXT } from './schema.js';
export type { Bewertung, Art, Vorschlag } from './schema.js';
export { vorfilter, zweitesNetz, gesundheitImText } from './element.js';
export type { Element, NetzTreffer } from './element.js';
export { anthropicClient, bewerteMitKi, systemPrompt, nutzerPrompt, kostenUsd } from './ki.js';
export type { Kontext, KiClient, KiAntwort } from './ki.js';
export { ladeKontext, OWNER_VORGABEN } from './kontext.js';
export {
  verarbeite, ladeSpeicher, vorgangsListe, vorgangPerThread, aufrufeLetzteStunde, vorgangKennung, vorschlagKurz,
} from './lauf.js';
export type { ElementStand, Vorgang, LaufErgebnis, Zaehler, SekretariatDeps } from './lauf.js';
export { stundenReportSekretariat, telegramZeilen, vorgangsZeilen, vorgangsTabelle, einzelTabelle, elementKurz } from './bericht.js';
