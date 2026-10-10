/**
 * banking/import — Umsätze aus einem Kontoauszug nachtragen.
 *
 * Hintergrund: Die FinTS-Synchronisierung ist die Regelquelle, sie liefert aber
 * nur, was die Bank im Abrufzeitraum vorhält. Der Bestand endete deshalb am
 * 29.06.2026, obwohl die Auszüge als PDF vorlagen. Dieses Modul trägt solche
 * Lücken nach — und zwar so, dass ein nachgetragener Umsatz
 *
 *   1. an `source = 'pdf_import'` jederzeit erkennbar und damit rücknehmbar ist,
 *   2. keinen bereits synchronisierten Umsatz doppelt in den Bestand bringt.
 *
 * Punkt 2 ist der schwierige Teil. Der vorhandene Eindeutigkeitsindex über
 * (account_id, bank_transaction_id) greift nur bei einem erneuten Lauf derselben
 * Datei — die Bank-Kennung aus FinTS lässt sich aus einem PDF nicht
 * rekonstruieren. Deshalb kommt ein zweiter, inhaltlicher Abgleich dazu.
 */
import crypto from 'node:crypto';
import { query as dbQuery } from '../../shared/db/index.js';
import * as audit from '../../shared/audit/index.js';
import { insertTransaction } from './store.js';

/** Fenster in Tagen für den inhaltlichen Abgleich. */
export const FENSTER_TAGE = 3;

export interface ImportZeile {
  booking_date: string;
  value_date?: string | null;
  amount: number;
  currency?: string;
  counterparty_name?: string | null;
  reference?: string | null;
  transaction_code?: string | null;
}

export interface ImportErgebnis {
  konto: number;
  quelle: string;
  probelauf: boolean;
  gelesen: number;
  neu: number;
  /** Gleicher Betrag, gleiches Buchungsdatum — sichere Dublette. */
  dublette_exakt: number;
  /** Gleicher Betrag, Datum im Fenster — Dublette aus verschobener Wertstellung. */
  dublette_fenster: number;
  /** Zeile unbrauchbar oder nicht gebucht. */
  uebersprungen: number;
  hinweise: string[];
}

function tage(a: string, b: string): number {
  const ms = new Date(`${a}T00:00:00Z`).getTime() - new Date(`${b}T00:00:00Z`).getTime();
  return Math.abs(ms) / 86400000;
}

/** Betrag auf zwei Stellen als Zeichenkette — Vergleichsschlüssel ohne Fließkomma-Überraschungen. */
function betragKey(n: number): string {
  return (Math.round(n * 100) / 100).toFixed(2);
}

/**
 * Kennung für einen aus dem PDF gelesenen Umsatz.
 *
 * Form: `pdf_<buchungsdatum>_<betrag>_<hash>[_<n>]`. Der Hash deckt
 * Verwendungszweck und Gegenpartei ab. Der Zähler `n` kommt nur dazu, wenn
 * derselbe Auszug dieselbe Zeile mehrfach enthält — zwei gleiche Lastschriften
 * am gleichen Tag mit gleicher Referenz sind inhaltlich nicht unterscheidbar,
 * dürfen aber nicht zu einer einzigen zusammenfallen.
 */
export function herkunftsId(z: ImportZeile, lauf = 1): string {
  const stoff = `${z.reference || ''}|${z.counterparty_name || ''}`;
  const hash = crypto.createHash('sha256').update(stoff).digest('hex').slice(0, 10);
  const basis = `pdf_${z.booking_date}_${betragKey(z.amount)}_${hash}`;
  return lauf > 1 ? `${basis}_${lauf}` : basis;
}

interface Vorhanden {
  id: number;
  booking_date: string;
  value_date: string | null;
  betrag: string;
  /** Schon einem Importkandidaten zugeordnet? Verhindert, dass zwei Zeilen auf denselben Bestandssatz zeigen. */
  belegt: boolean;
}

/**
 * Ordnet jeder Importzeile höchstens einen vorhandenen Umsatz zu.
 *
 * Zwei Durchgänge, der strengere zuerst: erst gleiches Buchungsdatum, dann das
 * Fenster von ±FENSTER_TAGE Tagen gegen Buchungs- UND Wertstellungsdatum. Der
 * zweite Durchgang fängt die Fälle, in denen FinTS die Wertstellung als
 * Buchungsdatum geführt hat.
 *
 * Die Zuordnung ist eineindeutig: Ein Bestandssatz kann nur eine Importzeile
 * erklären. Sonst würden zwei gleich hohe Zahlungen innerhalb einer Woche durch
 * einen einzigen vorhandenen Umsatz beide als Dublette gelten — und eine davon
 * fehlte danach dauerhaft im Bestand.
 */
export function ordneZu(
  zeilen: ImportZeile[], bestand: Vorhanden[],
): { exakt: Set<number>; fenster: Set<number> } {
  const nachBetrag = new Map<string, Vorhanden[]>();
  for (const v of bestand) {
    const k = betragKey(parseFloat(v.betrag));
    const liste = nachBetrag.get(k);
    if (liste) liste.push(v); else nachBetrag.set(k, [v]);
  }

  const exakt = new Set<number>();
  const fenster = new Set<number>();

  const greife = (
    z: ImportZeile, treffer: (v: Vorhanden) => boolean,
  ): boolean => {
    const kandidaten = nachBetrag.get(betragKey(z.amount));
    if (!kandidaten) return false;
    for (const v of kandidaten) {
      if (v.belegt) continue;
      if (!treffer(v)) continue;
      v.belegt = true;
      return true;
    }
    return false;
  };

  zeilen.forEach((z, i) => {
    if (greife(z, v => v.booking_date === z.booking_date)) exakt.add(i);
  });

  zeilen.forEach((z, i) => {
    if (exakt.has(i)) return;
    const imFenster = (v: Vorhanden) => {
      if (tage(v.booking_date, z.booking_date) <= FENSTER_TAGE) return true;
      if (v.value_date && tage(v.value_date, z.booking_date) <= FENSTER_TAGE) return true;
      if (z.value_date && tage(v.booking_date, z.value_date) <= FENSTER_TAGE) return true;
      return false;
    };
    if (greife(z, imFenster)) fenster.add(i);
  });

  return { exakt, fenster };
}

/** Zeile verwertbar? Ein nicht gebuchter („vorgemerkter") Umsatz gehört nicht in den Bestand. */
function pruefeZeile(z: ImportZeile, heute: string): string | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(z.booking_date || '')) return 'kein gültiges Buchungsdatum';
  if (!Number.isFinite(z.amount) || z.amount === 0) return 'kein Betrag';
  if (z.booking_date > heute) return `Buchungsdatum ${z.booking_date} liegt in der Zukunft (nicht gebucht)`;
  return null;
}

/**
 * Trägt die Zeilen eines Kontoauszugs für ein Konto nach.
 *
 * Schreibt nichts, solange `probelauf` gesetzt ist — dann liefert die Funktion
 * nur den Abgleich. Ein Lauf erzeugt genau einen Audit-Eintrag mit den Zahlen.
 */
export async function importiereUmsaetze(
  accountId: number,
  zeilen: ImportZeile[],
  opts: { quelle?: string; probelauf?: boolean; heute?: string } = {},
): Promise<ImportErgebnis> {
  const quelle = opts.quelle || 'pdf_import';
  const probelauf = opts.probelauf === true;
  const heute = opts.heute || new Date().toISOString().slice(0, 10);

  const ergebnis: ImportErgebnis = {
    konto: accountId, quelle, probelauf,
    gelesen: zeilen.length, neu: 0,
    dublette_exakt: 0, dublette_fenster: 0, uebersprungen: 0,
    hinweise: [],
  };

  const brauchbar: ImportZeile[] = [];
  for (const z of zeilen) {
    const grund = pruefeZeile(z, heute);
    if (grund) {
      ergebnis.uebersprungen++;
      if (ergebnis.hinweise.length < 20) {
        ergebnis.hinweise.push(`übersprungen (${z.booking_date} ${z.amount}): ${grund}`);
      }
      continue;
    }
    brauchbar.push(z);
  }

  const { rows } = await dbQuery<{
    id: number; booking_date: Date; value_date: Date | null; amount: string;
  }>(
    `SELECT id, booking_date, value_date, amount
       FROM banking_transactions WHERE account_id = $1`,
    [accountId],
  );
  const bestand: Vorhanden[] = rows.map(r => ({
    id: r.id,
    booking_date: new Date(r.booking_date).toISOString().slice(0, 10),
    value_date: r.value_date ? new Date(r.value_date).toISOString().slice(0, 10) : null,
    betrag: r.amount,
    belegt: false,
  }));

  const { exakt, fenster } = ordneZu(brauchbar, bestand);
  ergebnis.dublette_exakt = exakt.size;
  ergebnis.dublette_fenster = fenster.size;

  // Zähler je Kennung, damit identische Zeilen desselben Auszugs
  // unterscheidbare Kennungen bekommen.
  const belegteId = new Map<string, number>();

  for (let i = 0; i < brauchbar.length; i++) {
    if (exakt.has(i) || fenster.has(i)) continue;
    const z = brauchbar[i];
    const basis = herkunftsId(z, 1);
    const lauf = (belegteId.get(basis) || 0) + 1;
    belegteId.set(basis, lauf);

    if (probelauf) { ergebnis.neu++; continue; }

    const angelegt = await insertTransaction(accountId, {
      bank_transaction_id: herkunftsId(z, lauf),
      booking_date: z.booking_date,
      value_date: z.value_date || undefined,
      amount: z.amount,
      currency: z.currency || 'EUR',
      counterparty_name: z.counterparty_name || undefined,
      reference: z.reference || undefined,
      transaction_code: z.transaction_code || undefined,
      raw_payload: { quelle, importiert_am: new Date().toISOString() },
      source: quelle,
    });
    if (angelegt) ergebnis.neu++;
    else ergebnis.dublette_exakt++; // Eindeutigkeitsindex hat gegriffen: derselbe Auszug lief schon
  }

  await audit.log({
    module: 'banking',
    action: probelauf ? 'transaction.import_dryrun' : 'transaction.import',
    entityType: 'banking_account', entityId: String(accountId),
    after: {
      quelle, gelesen: ergebnis.gelesen, neu: ergebnis.neu,
      dublette_exakt: ergebnis.dublette_exakt,
      dublette_fenster: ergebnis.dublette_fenster,
      uebersprungen: ergebnis.uebersprungen,
    },
  });

  return ergebnis;
}
