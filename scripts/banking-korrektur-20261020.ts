#!/usr/bin/env bun
/**
 * Einmalige Korrektur Banking vom 20.10.2026 — Owner-Freigabe „Freigabe 1-3"
 * (C2), report-banking-sync-already-running-20261020.md Abschnitt 4.
 *
 * Schritte, einzeln aufrufbar:
 *   --sitzungen   KSK-Sitzungen ausser der gültigen ablösen (18, 19 → abgelöst)
 *   --laeufe      verwaiste Laufzeilen 4, 6, 8, 9 auf ABORTED setzen
 *   --neuabruf    alle aktiven FinTS-Konten maximal zurück neu abrufen und mit
 *                 dem neuen Schlüssel übernehmen; Saldenprobe je Konto
 *   --ab <datum>  Startdatum des Neuabrufs (Vorgabe 2015-01-01). Ohne TAN gibt
 *                 die Sparkasse nur etwa 90 Tage heraus; ein früheres Datum
 *                 löst die Freigabeanforderung aus und der Abruf bricht ab.
 *
 * Jeder Schritt sichert die betroffenen Zeilen vorher nach
 * ~/backups/banking-fixes-20261020/ und schreibt einen Audit-Eintrag.
 * Der Neuabruf hält die Abgleich-Sperre, damit kein Montags- oder Knopflauf
 * dazwischenkommt. Verlangt die Bank eine TAN, bricht er ab — keine TAN wird
 * angefordert oder abgesendet (C3).
 *
 * Ausgabe: JSON auf stdout (nur Endziffern, keine Namen).
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { query } from '../src/shared/db/index.js';
import * as audit from '../src/shared/audit/index.js';
import {
  getDecryptedSession, listAccounts, listActiveSessions, loeseAndereSitzungenAb,
  uebernimmUmsaetze, updateAccountBalance, updateSessionState,
} from '../src/modules/banking/store.js';
import { nimmAbgleichSperre, gibAbgleichSperreFrei } from '../src/modules/banking/sync-engine.js';
import * as sidecar from '../src/modules/banking/sidecar-client.js';

const SICHERUNG = path.join(homedir(), 'backups', 'banking-fixes-20261020');
mkdirSync(SICHERUNG, { recursive: true });
const stempel = new Date().toISOString().replace(/[:.]/g, '-');
const sichere = (name: string, daten: unknown) =>
  writeFileSync(path.join(SICHERUNG, `${name}-${stempel}.json`), JSON.stringify(daten, null, 1));
const kurz = (iban: string) => '…' + String(iban).slice(-4);
const aktor = 'cc-bikosoc';
const abIndex = process.argv.indexOf('--ab');
const AB = abIndex > 0 && /^\d{4}-\d{2}-\d{2}$/.test(process.argv[abIndex + 1] || '') ? process.argv[abIndex + 1] : '2015-01-01';

async function sitzungen() {
  const vorher = (await query(
    `SELECT id, institution_id, product_id, last_success_at, session_expires_at, pending_challenge_type, created_at
       FROM banking_sessions ORDER BY id`)).rows;
  sichere('banking_sessions-vorher', vorher);
  /* Behalten wird die zuletzt erfolgreich verbundene KSK-Sitzung — nicht
     einfach die höchste Nummer: maßgeblich ist, welche die Bank zuletzt
     angenommen hat. */
  const ksk = (await listActiveSessions()).filter(s => Number(s.institutionId) === 1);
  if (ksk.length === 0) throw new Error('keine aktive KSK-Sitzung');
  const behalten = ksk[0];
  const abgeloest = await loeseAndereSitzungenAb(1, Number(behalten.id));
  return { behalten: Number(behalten.id), abgeloest };
}

async function laeufe() {
  const ids = [4, 6, 8, 9];
  const vorher = (await query('SELECT * FROM banking_sync_runs WHERE id = ANY($1) ORDER BY id', [ids])).rows;
  sichere('banking_sync_runs-vorher', vorher);
  const { rows } = await query(
    `UPDATE banking_sync_runs
        SET status = 'ABORTED', finished_at = COALESCE(finished_at, now()),
            error_message = 'verwaist: paralleler Lauf ohne Abschluss (Sperre über Pool, Korrektur 20.10.2026)'
      WHERE id = ANY($1) AND status = 'RUNNING'
      RETURNING id`, [ids]);
  const geaendert = rows.map((r: any) => Number(r.id));
  await audit.log({
    module: 'banking', action: 'sync_run.abort_orphans', actor: aktor,
    entityType: 'banking_sync_run', entityId: geaendert.join(','),
    before: { ids, status: 'RUNNING' },
    after: { ids: geaendert, status: 'ABORTED', freigabe: 'Owner 20.10.2026 11:18 „Freigabe 1-3"' },
  } as any);
  return { geaendert };
}

async function neuabruf() {
  const sperre = await nimmAbgleichSperre();
  if (!sperre) throw new Error('Abgleich läuft gerade — Neuabruf nicht gestartet');
  const ergebnis: any[] = [];
  try {
    for (const session of await listActiveSessions()) {
      const inst = (await query('SELECT id, blz, fints_url FROM banking_institutions WHERE id = $1', [session.institutionId])).rows[0];
      if (!inst || !/^https?:\/\//.test(inst.fints_url || '')) continue;
      const zugang = await getDecryptedSession(Number(session.id));
      if (!zugang) { ergebnis.push({ institut: inst.id, fehler: 'Zugang nicht entschlüsselbar' }); continue; }
      const produkt = (await query('SELECT product_id FROM banking_sessions WHERE id = $1', [session.id])).rows[0]?.product_id;
      let clientData = zugang.state || undefined;

      for (const konto of await listAccounts({ institution_id: Number(inst.id), status: 'active' })) {
        const vorher = (await query(
          `SELECT count(*)::int AS n, coalesce(sum(amount), 0)::float AS summe
             FROM banking_transactions WHERE account_id = $1 AND duplicate_of IS NULL`, [konto.id])).rows[0];
        /* „Maximal zurück": ein frühes Startdatum; die Bank liefert, was sie hat. */
        const antwort: any = await sidecar.sync({
          session_id: Number(session.id), blz: inst.blz, fints_url: inst.fints_url,
          user_id: zugang.userId, pin: zugang.pin,
          product_id: produkt === 'env-default' ? undefined : produkt,
          client_data: clientData, account_iban: konto.iban, from_date: AB,
        });
        if (antwort?.needs_tan || antwort?.re_auth_required) {
          ergebnis.push({ konto: kurz(konto.iban), abbruch: 'Bank verlangt TAN — Neuabruf gestoppt, nichts angefordert' });
          return { ergebnis, abgebrochen: true };
        }
        if (antwort?.client_data_updated) {
          clientData = antwort.client_data_updated;
          await updateSessionState(Number(session.id), antwort.client_data_updated, 'fints5', '5.0.0');
        }
        const zaehler = { neu: 0, umgeschluesselt: 0, vorhanden: 0, pdfVerknuepft: 0, pdfMehrdeutig: 0 };
        const nachgeholt: { datum: string; betrag: number; art: string | null }[] = [];
        const liste = (antwort?.transactions ?? []) as any[];
        const summeAbruf = liste.reduce((s2, tx) => s2 + Number(tx.amount), 0);
        const befunde = await uebernimmUmsaetze(Number(konto.id), liste.map((tx: any) => ({
          bank_transaction_id: tx.bank_transaction_id, legacy_transaction_id: tx.legacy_transaction_id,
          booking_date: tx.booking_date, value_date: tx.value_date, amount: tx.amount,
          currency: tx.currency || 'EUR', counterparty_name: tx.counterparty_name,
          counterparty_iban: tx.counterparty_iban, reference: tx.reference,
          transaction_code: tx.transaction_code, raw_payload: tx,
        })));
        befunde.forEach((b, i) => {
          if (b.ergebnis !== 'offen') zaehler[b.ergebnis]++;
          if (b.pdfVerknuepft) zaehler.pdfVerknuepft++;
          if (b.pdfMehrdeutig) zaehler.pdfMehrdeutig++;
          if (b.ergebnis === 'neu' && !b.pdfVerknuepft) {
            nachgeholt.push({ datum: liste[i].booking_date, betrag: Number(liste[i].amount), art: liste[i].transaction_code ?? null });
          }
        });
        if (antwort?.balance !== undefined && antwort?.balance !== null) {
          await updateAccountBalance(Number(konto.id), antwort.balance, new Date().toISOString());
        }
        const nachher = (await query(
          `SELECT count(*)::int AS n, coalesce(sum(amount), 0)::float AS summe,
                  min(booking_date) AS erster
             FROM banking_transactions WHERE account_id = $1 AND duplicate_of IS NULL`, [konto.id])).rows[0];
        const sumAb = (await query(
          `SELECT coalesce(sum(amount), 0)::float AS s FROM banking_transactions
            WHERE account_id = $1 AND duplicate_of IS NULL AND booking_date >= $2`,
          [konto.id, antwort?.statement_opening?.datum ?? '1900-01-01'])).rows[0].s;
        const r2 = (x: number) => Math.round(x * 100) / 100;
        ergebnis.push({
          konto: kurz(konto.iban), id: Number(konto.id),
          umsaetze_im_abruf: (antwort?.transactions ?? []).length, ...zaehler, nachgeholt,
          vorher, nachher: { n: nachher.n, summe: r2(nachher.summe), erster: nachher.erster },
          banksaldo: antwort?.balance ?? null,
          auszug_anfang: antwort?.statement_opening ?? null, auszug_ende: antwort?.statement_closing ?? null,
          /* Probe 1: Abruf in sich — Anfangssaldo + Umsätze des Abrufs = Endsaldo */
          probe_abruf: antwort?.statement_opening && antwort?.statement_closing
            ? r2(antwort.statement_opening.betrag + summeAbruf - antwort.statement_closing.betrag) : null,
          /* Probe 2: Datenbank — Anfangssaldo + gespeicherte Umsätze ab Auszugsbeginn = Banksaldo */
          probe_db: antwort?.statement_opening && antwort?.balance != null
            ? r2(antwort.statement_opening.betrag + sumAb - antwort.balance) : null,
        });
      }
    }
    await audit.log({
      module: 'banking', action: 'transactions.neuabruf_v2', actor: aktor,
      entityType: 'banking_account', entityId: ergebnis.map(e => e.id).filter(Boolean).join(','),
      after: {
        freigabe: 'Owner 20.10.2026 11:18 „Freigabe 1-3"',
        konten: ergebnis.map(e => ({ konto: e.konto, neu: e.neu, umgeschluesselt: e.umgeschluesselt, vorhanden: e.vorhanden, pdf: e.pdfVerknuepft, probe_db: e.probe_db })),
      },
    } as any);
    return { ergebnis, abgebrochen: false };
  } finally {
    await gibAbgleichSperreFrei(sperre);
  }
}

const aus: Record<string, unknown> = {};
try {
  if (process.argv.includes('--sitzungen')) aus.sitzungen = await sitzungen();
  if (process.argv.includes('--laeufe')) aus.laeufe = await laeufe();
  if (process.argv.includes('--neuabruf')) aus.neuabruf = await neuabruf();
  process.stdout.write(JSON.stringify(aus, null, 1) + '\n');
  process.exit(0);
} catch (e: any) {
  process.stdout.write(JSON.stringify({ ...aus, fehler: String(e?.message || e) }, null, 1) + '\n');
  process.exit(1);
}
