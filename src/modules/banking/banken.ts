/**
 * banking/banken — die Banken, die „Bank verbinden" zulässt (20.10.2026).
 *
 * Die FinTS-Adresse kommt ausschliesslich von hier, nie aus der Anfrage: Wer
 * die Adresse frei setzen könnte, könnte Zugangsdaten an einen fremden Server
 * schicken lassen. Das Dashboard führt dieselbe Liste
 * (executive-dashboard/public/js/banking-connect.js, BANKING_BANKEN).
 */

export interface UnterstuetzteBank {
  blz: string;
  name: string;
  fintsUrl: string;
  /** Hinweis an den Sidecar, welches TAN-Verfahren zu wählen ist; undefined = Automatik */
  tanVerfahren?: 'SecureGo';
}

export const UNTERSTUETZTE_BANKEN: Record<string, UnterstuetzteBank> = {
  // Unverändert gegenüber dem erfolgreichen Verbinden vom 20.10.2026, 11:11
  '64350070': {
    blz: '64350070',
    name: 'Kreissparkasse Tuttlingen',
    fintsUrl: 'https://banking-bw1.s-fints-pt-bw.de/fints30',
  },
  // Atruvia-Rechenzentrum der Volksbanken; Adresse seit 13.03.2024
  '64390130': {
    blz: '64390130',
    name: 'Volksbank Schwarzwald-Donau-Neckar eG',
    fintsUrl: 'https://fints1.atruvia.de/cgi-bin/hbciservlet',
    tanVerfahren: 'SecureGo',
  },
};

export function unterstuetzteBank(blz: string | undefined | null): UnterstuetzteBank | null {
  return (blz && UNTERSTUETZTE_BANKEN[String(blz).trim()]) || null;
}

/**
 * Übersetzt das im Formular gewählte Verfahren (gespeichert als
 * banking_sessions.tan_medium_name) in den Hinweis für den Sidecar. Nur
 * SecureGo plus braucht eine gezielte Auswahl; bei S-pushTAN bleibt es bei
 * der Automatik, die am 20.10.2026 erfolgreich verbunden hat.
 */
export function tanVerfahrenFuerSidecar(tanMediumName: string | null | undefined): 'SecureGo' | undefined {
  return tanMediumName === 'SecureGo' ? 'SecureGo' : undefined;
}

/** Vorsilbe neuer Kontobezeichnungen — getrennt von UNTERSTUETZTE_BANKEN, deren
    Einträge die Verbindungsdaten festhalten und unverändert bleiben sollen. */
const KURZNAMEN: Record<string, string> = { '64350070': 'KSK', '64390130': 'Volksbank' };

/**
 * Bezeichnung eines neu gemeldeten Kontos (23.10.2026). Der Sidecar meldet
 * als Namen die IBAN; so standen volle IBANs als Kontoname im Dashboard und
 * im Audit. Ein Vorschlag, der eine Kontonummer enthält, wird verworfen —
 * dann „<Bank> …1234“. Vorhandene Bezeichnungen überschreibt upsertAccount nie.
 */
export function neueKontoBezeichnung(blz: string | null | undefined, institutName: string | null | undefined,
  iban: string, vorschlag?: string | null): string {
  const v = String(vorschlag ?? '').trim();
  if (v && !/\d{6,}/.test(v.replace(/\s+/g, ''))) return v;
  const bank = KURZNAMEN[String(blz ?? '').trim()]
    ?? (/kreissparkasse/i.test(String(institutName)) ? 'KSK' : String(institutName || 'Bank').trim().split(/\s+/)[0]);
  return `${bank} …${String(iban || '').replace(/\s+/g, '').slice(-4)}`;
}
