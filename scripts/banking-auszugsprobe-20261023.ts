/**
 * banking-auszugsprobe-20261023.ts — Probe je MT940-Auszug für ausgewählte
 * Konten (Owner-Freigabe 23.10.2026 21:40 „Freigabe Paket Abend", Punkt 4).
 *
 * Holt die Umsätze der letzten 89 Tage OHNE TAN über eine aktive Sitzung,
 * so wie der Wochenabgleich (kein Freigabe-Segment). Verlangt die Bank eine
 * TAN, bricht das Skript sofort ab — es fordert keine Freigabe an und fragt
 * kein weiteres Konto an.
 *
 * Schreibt NUR die Auszugssalden (banking_statement_balances, Quelle
 * 'pruefung') und den erneuerten Dialogzustand der Sitzung, wie jeder
 * Abgleich. Umsätze werden NICHT übernommen; das macht der Wochenabgleich.
 *
 *   bun scripts/banking-auszugsprobe-20261023.ts <sitzung> <konto-id> [<konto-id> …]
 *
 * Ausgabe nur mit Endziffern, ohne Zugangsdaten.
 */
import { query } from '../src/shared/db/index.js';
import * as sidecar from '../src/modules/banking/sidecar-client.js';
import { getDecryptedSession, updateSessionState, speichereAuszuege } from '../src/modules/banking/store.js';
import { nimmAbgleichSperre, gibAbgleichSperreFrei } from '../src/modules/banking/sync-engine.js';

const [sitzungArg, ...kontoArgs] = process.argv.slice(2);
const sitzungId = Number(sitzungArg);
if (!sitzungId || kontoArgs.length === 0) throw new Error('Aufruf: <sitzung> <konto-id> …');

const { rows: [sitzung] } = await query(
  `SELECT s.id, s.institution_id, s.product_id, i.blz, i.fints_url
     FROM banking_sessions s JOIN banking_institutions i ON i.id = s.institution_id
    WHERE s.id = $1 AND s.institution_id IS NOT NULL`, [sitzungId]);
if (!sitzung) throw new Error(`Sitzung ${sitzungId} nicht aktiv`);

// Dieselbe Sperre wie Abgleich und Abruf nach dem Verbinden: nie zwei Dialoge zugleich
const sperre = await nimmAbgleichSperre();
if (!sperre) throw new Error('Ein Abgleich läuft gerade — später erneut');

const von = new Date(Date.now() - 89 * 86_400_000).toISOString().slice(0, 10);
const ergebnis: any[] = [];
for (const kontoId of kontoArgs.map(Number)) {
  const { rows: [konto] } = await query(
    `SELECT id, iban FROM banking_accounts WHERE id = $1 AND institution_id = $2 AND status = 'active'`,
    [kontoId, sitzung.institution_id]);
  if (!konto) { ergebnis.push({ konto: kontoId, status: 'nicht aktiv' }); continue; }
  const zugang = await getDecryptedSession(sitzungId);
  if (!zugang) throw new Error('Sitzung ohne Zugang');
  const r: any = await sidecar.sync({
    session_id: sitzungId, blz: sitzung.blz, fints_url: sitzung.fints_url,
    user_id: zugang.userId, pin: zugang.pin,
    product_id: sitzung.product_id === 'env-default' ? undefined : sitzung.product_id,
    client_data: zugang.state || undefined, account_iban: konto.iban, from_date: von,
  });
  const endziffern = '…' + String(konto.iban).slice(-4);
  if (r?.needs_tan || r?.re_auth_required) {
    ergebnis.push({ konto: endziffern, status: 'TAN verlangt — abgebrochen, nichts weiter angefragt' });
    break;
  }
  if (r?.client_data_updated) await updateSessionState(sitzungId, r.client_data_updated, 'fints5', '5.0.0');
  const gespeichert = await speichereAuszuege(Number(konto.id), r?.auszuege, 'pruefung');
  const auszuege = r?.auszuege ?? [];
  ergebnis.push({
    konto: endziffern, ab: von, umsaetze: (r?.transactions ?? []).length,
    auszuege: auszuege.length, gespeichert,
    abweichend: auszuege.filter((a: any) => a.probe !== 0),
    anfang: r?.statement_opening ?? null, schluss: r?.statement_closing ?? null,
    gesamtprobe: r?.statement_opening && r?.statement_closing
      ? Math.round((r.statement_opening.betrag + auszuege.reduce((s: number, a: any) => s + a.summe, 0) - r.statement_closing.betrag) * 100) / 100
      : null,
    banksaldo: r?.balance ?? null,
  });
}
await gibAbgleichSperreFrei(sperre);
console.log(JSON.stringify({ sitzung: sitzungId, von, ergebnis }, null, 1));
process.exit(0);
