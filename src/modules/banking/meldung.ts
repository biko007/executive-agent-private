/**
 * banking/meldung — Fehlergrund und Kontokennung für Telegram und
 * `banking_sync_runs.error_message` (Vorschlag 4d, Owner-Freigabe 07.11.2026).
 *
 * ANLASS: Der Montagslauf meldete bei der Volksbank nur „IMPORT_FAILED. Der
 * Abruf ist fehlgeschlagen." — ohne Grund, ohne Weg, aber mit voller IBAN und
 * rohem Sidecar-JSON in den Einzelzeilen (C5). Jetzt: Bankcode mit Klartext,
 * Endziffern statt IBAN, bei Instituten, deren Abgleich ohne App-Freigabe
 * nachweislich nicht geht, der Hinweis auf „Bank verbinden".
 */
import { unterstuetzteBank } from './banken.js';

/** Dashboard-Seite „Bank verbinden" — derselbe Link wie bei re_auth_required. */
export const BANK_VERBINDEN_LINK = 'https://app.bikobickel.de/dashboard/?tab=banking-connect';

/** Nur Endziffern, nie die volle Kontonummer (C5). */
export function kontoKurz(iban: string | null | undefined): string {
  const ziffern = String(iban ?? '').replace(/\s+/g, '');
  return ziffern ? `…${ziffern.slice(-4)}` : '…????';
}

/** Lange Ziffernfolgen und IBANs aus freiem Text entfernen (C5). */
export function ohneKontonummern(t: string): string {
  return String(t).replace(/[A-Z]{2}\d{2}(?:\s?\d){8,}/g, '[IBAN]').replace(/\d{6,}/g, (m) => '…' + m.slice(-4));
}

const KLARTEXT: Record<string, string> = {
  '9340': 'Auftrag abgelehnt',
  '9050': 'Nachricht enthält Fehler',
  '9800': 'Dialog abgebrochen',
  '9942': 'PIN falsch',
  '9931': 'Zugang gesperrt',
  '9930': 'Zugang gesperrt',
  '9910': 'Auftrag abgelehnt (Sperre)',
};

/** Bankcodes und Klartext aus einem Sidecar-Fehler (Statuszeile + JSON). */
export function fehlerGrund(e: unknown): { codes: string[]; text: string } {
  const err = e as { message?: string; responseBody?: string } | null;
  const roh = `${err?.responseBody ?? ''} ${err?.message ?? String(e ?? '')}`;
  const codes = [...new Set(roh.match(/\b9\d{3}\b/g) ?? [])];
  if (codes.length) return { codes, text: codes.map((c) => `${c} ${KLARTEXT[c] ?? 'Bankfehler'}`).join(', ') };
  let detail = '';
  try { const j = JSON.parse(err?.responseBody ?? ''); detail = String(j?.detail ?? j?.error ?? ''); } catch { /* kein JSON */ }
  return { codes, text: ohneKontonummern(detail || String(err?.message ?? e ?? 'unbekannt')).slice(0, 140) };
}

/**
 * Institute, bei denen der Abgleich ohne Owner nachweislich nicht geht: Die
 * Volksbank (Atruvia) verlangt bei jedem neuen Dialog eine App-Freigabe (3955
 * bei jedem Verbinden, zuletzt 07.11.2026 07:17) und lehnt den Abrufdialog des
 * Montagslaufs mit 9050/9800/9340 ab (29.10. und 02.11.2026; am 26.10. kam
 * der Lauf gar nicht bis zur Bank). Für sie
 * gibt es keinen Knopf „Abgleich jetzt", nur den Weg über „Bank verbinden".
 */
export function abgleichNurUeberVerbinden(blz: string | null | undefined): boolean {
  return unterstuetzteBank(blz)?.abgleichNurUeberVerbinden === true;
}

/** Fehlergrund je Institut für `error_message` und die Meldung. */
export function abgleichFehlerText(p: { institut: string; blz: string; gruende: string[]; fehlgeschlagen: number; konten: number }): string {
  const haeufig = [...new Set(p.gruende)].slice(0, 2).join('; ') || 'unbekannt';
  const teil = `${p.institut}: ${haeufig} (${p.fehlgeschlagen} von ${p.konten} Konten)`;
  return abgleichNurUeberVerbinden(p.blz)
    ? `${teil} – die Bank verlangt für jeden neuen Abruf eine App-Freigabe; Umsätze über „Bank verbinden“ im Dashboard abrufen`
    : teil;
}
