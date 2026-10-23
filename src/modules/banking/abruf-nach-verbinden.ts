/**
 * banking/abruf-nach-verbinden — Salden und Umsätze im Verbindungsdialog
 * (20.10.2026, Owner-Freigabe „bauen" 17:23).
 *
 * ANLASS: Die Volksbank lehnt jeden NEUEN Abrufdialog ab (9050/9340), den
 * Verbindungsdialog nach der SecureGo-Freigabe nimmt sie an. Und die Sparkasse
 * gibt mehr als 90 Tage Historie nur nach einer Freigabe heraus. Deshalb hält
 * der Sidecar den Dialog nach erfolgreichem „Bank verbinden" kurz offen, und
 * diese Funktion ruft darin sofort ab:
 *
 *  - alle Konten des Instituts AUSSER den ausgeblendeten (archived — darunter
 *    „Dritte – nicht auswerten"), maximal verfügbarer Zeitraum;
 *  - Übernahme wie im Wochenabgleich (uebernimmUmsaetze: v2-Schlüssel,
 *    Umschlüsseln, PDF-Verknüpfung);
 *  - Abrufprobe je Konto: Anfangssaldo des ersten Auszugs plus die GELIEFERTEN
 *    Umsätze minus Schlusssaldo des letzten Auszugs — prüft, ob die Bank
 *    lückenlos geliefert hat;
 *  - Saldenprobe je Konto: Anfangssaldo des ersten Auszugs plus alle
 *    GESPEICHERTEN Umsätze nach dessen Buchungstag minus Banksaldo — prüft
 *    den Bestand in bikosoc (Dubletten, Lücken).
 *
 *  - Liefert die Bank keine Auszugssalden (Volksbank: CAMT ohne Salden),
 *    prüft die Bezugsprobe gegen den Kontostand vom letzten Abruf (23.10.2026).
 *
 * Läuft NACH der Antwort an das Formular (fire-and-forget), hält die
 * Abgleich-Sperre und meldet das Ergebnis per Telegram. Eine weitere Freigabe
 * fordert höchstens der Sidecar an, und nur einmal je Verbinden für die volle
 * Historie (Owner-Freigabe 23.10.2026 17:04); verlangt die Bank darüber hinaus
 * eine, wird das Konto übersprungen und gemeldet.
 */
import { query as dbQuery } from '../../shared/db/index.js';
import * as audit from '../../shared/audit/index.js';
import * as sidecar from './sidecar-client.js';
import { uebernimmUmsaetze, updateAccountBalance, updateSessionState } from './store.js';
import { nimmAbgleichSperre, gibAbgleichSperreFrei } from './sync-engine.js';

export interface KontoErgebnis {
  konto: string;            // nur Endziffern
  // unbekannt: Bank liefert ein Konto, das bikosoc nicht (aktiv) führt
  status: 'ok' | 'tan_noetig' | 'fehler' | 'uebersprungen' | 'unbekannt';
  ab?: string | null;       // tatsächlicher Beginn des Abrufzeitraums
  umsaetze: number;
  neu: number;
  umgeschluesselt: number;
  pdfVerknuepft: number;
  abrufprobe?: number | null;
  saldenprobe: number | null;
  /** Tag des Kontostands, gegen den die Bezugsprobe lief — nur ohne Auszugssalden */
  saldenprobeBezug?: string | null;
}

type Saldo = { datum: string; betrag: number } | null;

const kurz = (iban: string) => '…' + String(iban).slice(-4);
const rund = (x: number) => Math.round(x * 100) / 100;

/**
 * Buchungstag einer Zeile. ACHTUNG Spaltennamen: Der Sidecar legt das
 * MT940-Buchungsdatum (entry_date) in `value_date` ab und die Valuta in
 * `booking_date` (Befund Runde 2, 20.10.2026). Fehlt das Buchungsdatum, gilt
 * die Valuta. Dieselbe Regel wie in der KSK-Saldenprobe vom 20.10. (0,00 €).
 */
const buchungstag = (tx: { value_date?: string | null; booking_date?: string | null }) => tx.value_date || tx.booking_date || '';

/** Abrufprobe: Anfangssaldo + gelieferte Umsätze bis zum Schlusssaldo − Schlusssaldo. */
export function abrufprobe(transaktionen: any[], anfang: Saldo, schluss: Saldo): number | null {
  if (!anfang || !schluss) return null;
  const summe = transaktionen
    .filter(tx => buchungstag(tx) > anfang.datum && buchungstag(tx) <= schluss.datum)
    .reduce((s, tx) => s + Number(tx.amount), 0);
  return rund(anfang.betrag + summe - schluss.betrag);
}

/** Saldenprobe: Anfangssaldo + gespeicherte Umsätze nach dessen Buchungstag − Banksaldo. */
export async function saldenprobe(accountId: number, anfang: Saldo, banksaldo: number | null): Promise<number | null> {
  if (!anfang || banksaldo == null) return null;
  const { rows } = await dbQuery<{ s: string | null }>(
    `SELECT sum(amount) AS s FROM banking_transactions
      WHERE account_id = $1 AND duplicate_of IS NULL AND coalesce(value_date, booking_date) > $2::date`,
    [accountId, anfang.datum],
  );
  return rund(anfang.betrag + Number(rows[0]?.s ?? 0) - banksaldo);
}

/**
 * Bezugsprobe für Banken ohne Auszugssalden (23.10.2026): Kontostand vom
 * letzten Abruf plus die seither übernommenen Umsätze minus neuer Banksaldo
 * (HKSAL). Gezählt werden nur Umsätze, die nach dem letzten Abruf übernommen
 * UND frühestens an dessen Tag gebucht wurden — eine nachgeholte Historie
 * steckt im alten Kontostand längst drin. Ohne alten Kontostand: keine Probe.
 */
export async function bezugsprobe(
  accountId: number,
  vorher: { saldo: number | null; zeit: string | null },
  banksaldo: number | null,
): Promise<number | null> {
  if (vorher.saldo == null || !vorher.zeit || banksaldo == null) return null;
  const { rows } = await dbQuery<{ s: string | null }>(
    `SELECT sum(amount) AS s FROM banking_transactions
      WHERE account_id = $1 AND duplicate_of IS NULL AND imported_at > $2::timestamptz
        AND coalesce(value_date, booking_date) >= ($2::timestamptz AT TIME ZONE 'Europe/Berlin')::date`,
    // value_date ist der Buchungstag — auch bei CAMT (entry_date = BookingDate), siehe buchungstag()
    [accountId, vorher.zeit],
  );
  return rund(Number(vorher.saldo) + Number(rows[0]?.s ?? 0) - banksaldo);
}

export async function rufeUmsaetzeNachVerbindenAb(sessionId: number, institutionId: number): Promise<KontoErgebnis[] | null> {
  const sperre = await nimmAbgleichSperre();
  if (!sperre) {
    // Ein Abgleich läuft gerade: den offenen Dialog sofort schliessen statt ihn
    // zwei Minuten bei der Bank stehen zu lassen.
    console.warn('[banking] Abruf nach Verbinden übersprungen — Abgleich läuft');
    await sidecar.cancelSession(sessionId);
    return null;
  }
  try {
    const ausgeblendet = (await dbQuery<{ iban: string }>(
      `SELECT iban FROM banking_accounts WHERE institution_id = $1 AND status = 'archived'`, [institutionId],
    )).rows.map(r => r.iban);

    const antwort = await sidecar.abrufImDialog({ session_id: sessionId, ausschliessen_ibans: ausgeblendet });
    if (antwort?.client_data) {
      await updateSessionState(sessionId, antwort.client_data, 'fints5', '5.0.0');
    }

    const ergebnisse: KontoErgebnis[] = [];
    for (const k of antwort?.konten ?? []) {
      // Kontostand und Zeitpunkt VOR dem Abruf — Bezug für die Bezugsprobe
      const konto = (await dbQuery<{ id: string; currency: string; current_balance: string | null; last_sync_at: Date | string | null }>(
        `SELECT id, currency, current_balance, last_sync_at FROM banking_accounts WHERE iban = $1 AND institution_id = $2 AND status = 'active'`,
        [k.iban, institutionId],
      )).rows[0];
      if (!konto) {
        ergebnisse.push({ konto: kurz(k.iban), status: 'unbekannt', umsaetze: 0, neu: 0, umgeschluesselt: 0, pdfVerknuepft: 0, saldenprobe: null });
        continue;
      }
      if (k.status !== 'ok') {
        // Saldo kommt aus einem eigenen Auftrag und kann trotz Umsatzfehler da sein
        if (k.balance != null) await updateAccountBalance(Number(konto.id), k.balance, new Date().toISOString());
        ergebnisse.push({ konto: kurz(k.iban), status: k.status, umsaetze: 0, neu: 0, umgeschluesselt: 0, pdfVerknuepft: 0, saldenprobe: null });
        continue;
      }
      const vorherSaldo = konto.current_balance == null ? null : Number(konto.current_balance);
      const vorherZeit = konto.last_sync_at == null ? null : new Date(konto.last_sync_at).toISOString();
      const befunde = await uebernimmUmsaetze(Number(konto.id), k.transactions.map((tx: any) => ({
        bank_transaction_id: tx.bank_transaction_id,
        legacy_transaction_id: tx.legacy_transaction_id,
        booking_date: tx.booking_date,
        value_date: tx.value_date,
        amount: tx.amount,
        currency: tx.currency || konto.currency,
        counterparty_name: tx.counterparty_name,
        counterparty_iban: tx.counterparty_iban,
        reference: tx.reference,
        transaction_code: tx.transaction_code,
        raw_payload: tx,
      })));
      if (k.balance != null) await updateAccountBalance(Number(konto.id), k.balance, new Date().toISOString());
      ergebnisse.push({
        konto: kurz(k.iban),
        status: 'ok',
        ab: k.ab ?? null,
        umsaetze: k.transactions.length,
        neu: befunde.filter(b => b.ergebnis === 'neu').length,
        umgeschluesselt: befunde.filter(b => b.ergebnis === 'umgeschluesselt').length,
        pdfVerknuepft: befunde.filter(b => b.pdfVerknuepft).length,
        abrufprobe: abrufprobe(k.transactions, k.statement_opening, k.statement_closing),
        ...(k.statement_opening
          ? { saldenprobe: await saldenprobe(Number(konto.id), k.statement_opening, k.balance) }
          : {
            saldenprobe: await bezugsprobe(Number(konto.id), { saldo: vorherSaldo, zeit: vorherZeit }, k.balance),
            saldenprobeBezug: vorherSaldo != null && vorherZeit && k.balance != null ? vorherZeit.slice(0, 10) : null,
          }),
      });
    }

    await audit.log({
      module: 'banking', action: 'transactions.abruf_nach_verbinden',
      entityType: 'banking_session', entityId: String(sessionId),
      after: { institution_id: institutionId, ausgeschlossen: ausgeblendet.length, konten: ergebnisse as unknown as Record<string, unknown>[] } as any,
    });
    return ergebnisse;
  } finally {
    await gibAbgleichSperreFrei(sperre);
  }
}

const euro = (x: number) => `${x.toLocaleString('de-DE', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} €`;

/** Fehlertext für Telegram: lange Ziffernfolgen (Konto-, Kundennummern) maskiert (C5). */
export function maskiereFehlertext(t: string): string {
  return String(t).replace(/[A-Z]{2}\d{2}[\d ]{8,}/g, '[IBAN]').replace(/\d{6,}/g, m => '…' + m.slice(-4)).slice(0, 160);
}

/** Telegram-Text — nur Endziffern, keine Namen (C5). */
export function abrufMeldung(institut: string, e: KontoErgebnis[] | null): string {
  if (e === null) return `ℹ️ ${institut}: Umsatzabruf nach dem Verbinden übersprungen — es lief gerade ein Abgleich.`;
  const ok = e.filter(x => x.status === 'ok');
  const zeilen = [`🏦 ${institut} verbunden — Umsätze abgerufen:`];
  for (const x of e) {
    if (x.status === 'ok') {
      const bezug = x.saldenprobeBezug ? ` (gegen Stand ${x.saldenprobeBezug.split('-').reverse().join('.')})` : '';
      const probe = x.saldenprobe === null ? 'Saldenprobe –' : x.saldenprobe === 0 ? `Saldenprobe ✓${bezug}` : `Saldenprobe ${euro(x.saldenprobe)}${bezug}`;
      const zeitraum = x.ab ? ` ab ${x.ab.split('-').reverse().join('.')}` : '';
      const luecke = x.abrufprobe ? `, Lieferung lückenhaft (${euro(x.abrufprobe)})` : '';
      zeilen.push(`${x.konto}: ${x.umsaetze} Umsätze${zeitraum}, ${x.neu} neu, ${probe}${luecke}`);
    } else if (x.status === 'tan_noetig') {
      zeilen.push(`${x.konto}: Bank verlangt weitere Freigabe — übersprungen`);
    } else if (x.status === 'uebersprungen') {
      zeilen.push(`${x.konto}: nicht angefragt (Bank verlangt Freigaben)`);
    } else if (x.status === 'fehler') {
      zeilen.push(`${x.konto}: Abruf fehlgeschlagen`);
    } else if (x.status === 'unbekannt') {
      zeilen.push(`${x.konto}: neu gemeldetes Konto — nicht übernommen, bitte zuordnen`);
    }
  }
  if (ok.length === 0) zeilen.push('Kein Konto abgerufen.');
  return zeilen.join('\n');
}
