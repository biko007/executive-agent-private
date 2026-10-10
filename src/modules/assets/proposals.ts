/**
 * assets/proposals — Buchungsvorschläge aus Bankumsätzen.
 *
 * Der Ablauf hat bewusst zwei getrennte Schritte:
 *
 *   1. `erzeugeVorschlaege()` liest neue Umsätze, wendet die Regeln an und legt
 *      Vorschläge mit Status `offen` an. Es wird NICHTS gebucht.
 *   2. `bestaetige()` macht aus einem Vorschlag genau eine Kostenbuchung —
 *      ausgelöst durch einen Klick des Owners, nicht durch die Automatik.
 *
 * Diese Trennung ist der Grund, warum die Automatik überhaupt verantwortbar
 * ist: Eine falsch zugeordnete Kostenart verschiebt Geld zwischen Mietern. Ein
 * Vorschlag, den niemand bestätigt, verschiebt nichts.
 */
import { query as dbQuery, getClient } from '../../shared/db/index.js';
import * as audit from '../../shared/audit/index.js';
import {
  ladeRegeln, trifft, leistungszeitraum, anteiligerBetrag,
  type AusgabenRegel, type UmsatzZeile,
} from './expense-rules.js';

export interface ErzeugungsErgebnis {
  geprueft: number;
  angelegt: number;
  /** Vorschlag existierte schon (gleicher Umsatz, gleiche Regel). */
  bereits_vorhanden: number;
  /** Offener Vorschlag an die geaenderte Regel angepasst. */
  aktualisiert: number;
  /** Offener Vorschlag zurueckgezogen, weil die Regel entfiel oder nicht mehr trifft. */
  zurueckgezogen: number;
  /** Regel traf zu, aber Objekt oder Kostenart ist im Stammdatenbestand unbekannt. */
  uebersprungen: number;
  hinweise: string[];
}

/**
 * DATE-Spalten kommen als Date-Objekt aus pg. `String(date)` ergibt
 * "Fri Nov 01 2024 …" und nie ein ISO-Datum — ein Vergleich darauf hielte jeden
 * Vorschlag für geändert und schriebe ihn bei jedem Lauf neu.
 */
function isoTag(wert: unknown): string | null {
  if (!wert) return null;
  if (wert instanceof Date) return wert.toISOString().slice(0, 10);
  return String(wert).slice(0, 10);
}

/** Begründung, die im Dashboard unter dem Vorschlag steht. */
function begruendung(regel: AusgabenRegel, u: UmsatzZeile): string {
  const teile: string[] = [`Regel ${regel.id}`];
  if (regel.match.counterparty) teile.push(`Gegenpartei passt auf "${regel.match.counterparty}"`);
  if (regel.match.reference) teile.push(`Verwendungszweck passt auf "${regel.match.reference}"`);
  if (regel.anteil !== 1) {
    teile.push(`Anteil ${(regel.anteil * 100).toFixed(4).replace(/0+$/, '').replace(/\.$/, '')} % `
      + `von ${Math.abs(u.amount).toFixed(2)} Euro`);
  }
  if (regel.hinweis) teile.push(regel.hinweis);
  return teile.join(' · ');
}

/**
 * Wendet die Regeln auf Umsätze an und legt Vorschläge an.
 *
 * `seit` grenzt auf Umsätze ab diesem Buchungsdatum ein. Ohne Angabe läuft es
 * über den gesamten Bestand — das ist unschädlich, weil der Eindeutigkeitsindex
 * auf (transaction_id, rule_id) jeden Vorschlag nur einmal entstehen lässt.
 */
export async function erzeugeVorschlaege(
  opts: { seit?: string; accountIds?: number[]; actor?: string } = {},
): Promise<ErzeugungsErgebnis> {
  const ergebnis: ErzeugungsErgebnis = {
    geprueft: 0, angelegt: 0, bereits_vorhanden: 0,
    aktualisiert: 0, zurueckgezogen: 0, uebersprungen: 0, hinweise: [],
  };

  const regeln = await ladeRegeln();
  if (regeln.length === 0) {
    ergebnis.hinweise.push('Keine Regeln hinterlegt — es entstehen keine Vorschläge.');
    return ergebnis;
  }

  // Stammdaten einmal auflösen: Objektschlüssel und Kostenartenschlüssel sind
  // in den Regeln Klartext, in der Datenbank Fremdschlüssel.
  const { rows: objekte } = await dbQuery<{ id: number; code: string }>(
    'SELECT id, code FROM properties WHERE active = true');
  const { rows: arten } = await dbQuery<{ id: number; code: string }>(
    'SELECT id, code FROM cost_categories WHERE active = true');
  const objektId = new Map(objekte.map(o => [o.code, o.id]));
  const artId = new Map(arten.map(a => [a.code, a.id]));

  const params: unknown[] = [];
  let sql = `SELECT id, booking_date, value_date, amount, counterparty_name, reference
               FROM banking_transactions WHERE amount < 0`;
  if (opts.seit) { params.push(opts.seit); sql += ` AND booking_date >= $${params.length}`; }
  if (opts.accountIds && opts.accountIds.length > 0) {
    params.push(opts.accountIds); sql += ` AND account_id = ANY($${params.length})`;
  }
  sql += ' ORDER BY booking_date';

  const { rows } = await dbQuery<{
    id: number; booking_date: Date; value_date: Date | null;
    amount: string; counterparty_name: string | null; reference: string | null;
  }>(sql, params);

  for (const r of rows) {
    const u: UmsatzZeile = {
      id: r.id,
      booking_date: new Date(r.booking_date).toISOString().slice(0, 10),
      value_date: r.value_date ? new Date(r.value_date).toISOString().slice(0, 10) : null,
      amount: parseFloat(r.amount),
      counterparty_name: r.counterparty_name,
      reference: r.reference,
    };
    ergebnis.geprueft++;

    for (const regel of regeln) {
      if (!trifft(regel, u)) continue;

      const pid = objektId.get(regel.property);
      const cid = artId.get(regel.cost_category);
      if (!pid || !cid) {
        ergebnis.uebersprungen++;
        const text = `Regel ${regel.id}: ${!pid ? `Objekt ${regel.property}` : `Kostenart ${regel.cost_category}`} unbekannt`;
        if (!ergebnis.hinweise.includes(text)) ergebnis.hinweise.push(text);
        continue;
      }

      const zeitraum = leistungszeitraum(regel.service_period, u);
      const { rows: angelegt } = await dbQuery<{ id: number }>(
        `INSERT INTO expense_booking_proposals
           (property_id, transaction_id, rule_id, cost_category_id, vendor_name,
            booking_date, amount_gross, anteil, service_period_start, service_period_end,
            umlagefaehig, sicherheit, begruendung, reference)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
         -- Der Eindeutigkeitsindex ist partiell (nur fuer transaction_id IS NOT
         -- NULL). Postgres erkennt ihn nur, wenn dieselbe Bedingung hier steht.
         ON CONFLICT (transaction_id, rule_id) WHERE transaction_id IS NOT NULL
           DO NOTHING
         RETURNING id`,
        [
          pid, u.id, regel.id, cid, u.counterparty_name,
          u.booking_date, anteiligerBetrag(u.amount, regel.anteil), regel.anteil,
          zeitraum.start, zeitraum.ende,
          regel.umlagefaehig, regel.sicherheit, begruendung(regel, u), u.reference,
        ],
      );

      if (angelegt.length > 0) ergebnis.angelegt++;
      else ergebnis.bereits_vorhanden++;
    }
  }

  // ── Offene Vorschlaege gegen den aktuellen Regelstand halten ─────────────
  //
  // Die Regeln sind Daten und aenderbar. Ohne diesen Schritt blieben nach einer
  // Korrektur genau die Vorschlaege stehen, die sie beheben sollte — und der
  // Eindeutigkeitsindex auf (transaction_id, rule_id) verhinderte, dass ein
  // richtiger an ihre Stelle tritt. Angefasst wird ausschliesslich Status
  // `offen`; bestaetigte und verworfene Vorschlaege sind Geschichte.
  const nachId = new Map(regeln.map(r => [r.id, r]));
  const { rows: offene } = await dbQuery<any>(
    `SELECT p.*, t.booking_date AS tx_booking_date, t.value_date AS tx_value_date,
            t.amount AS tx_amount, t.counterparty_name AS tx_counterparty,
            t.reference AS tx_reference
       FROM expense_booking_proposals p
       JOIN banking_transactions t ON t.id = p.transaction_id
      WHERE p.status = 'offen'`);

  for (const o of offene) {
    const regel = nachId.get(o.rule_id);
    const u: UmsatzZeile = {
      id: o.transaction_id,
      booking_date: new Date(o.tx_booking_date).toISOString().slice(0, 10),
      value_date: o.tx_value_date ? new Date(o.tx_value_date).toISOString().slice(0, 10) : null,
      amount: parseFloat(o.tx_amount),
      counterparty_name: o.tx_counterparty,
      reference: o.tx_reference,
    };

    if (!regel || !trifft(regel, u)) {
      await dbQuery(
        `UPDATE expense_booking_proposals
            SET status = 'verworfen', entschieden_am = now(), entschieden_von = 'system',
                notiz = $2
          WHERE id = $1 AND status = 'offen'`,
        [o.id, regel
          ? `Regel ${o.rule_id} trifft auf diesen Umsatz nicht mehr zu (Regelstand geaendert).`
          : `Regel ${o.rule_id} ist nicht mehr hinterlegt.`]);
      ergebnis.zurueckgezogen++;
      continue;
    }

    const pid = objektId.get(regel.property);
    const cid = artId.get(regel.cost_category);
    if (!pid || !cid) continue;

    const zeitraum = leistungszeitraum(regel.service_period, u);
    const betrag = anteiligerBetrag(u.amount, regel.anteil);
    const gleich =
      Number(o.property_id) === pid &&
      Number(o.cost_category_id) === cid &&
      Math.abs(parseFloat(o.amount_gross) - betrag) < 0.005 &&
      Math.abs(parseFloat(o.anteil) - regel.anteil) < 0.000005 &&
      isoTag(o.service_period_start) === zeitraum.start &&
      isoTag(o.service_period_end) === zeitraum.ende &&
      o.umlagefaehig === regel.umlagefaehig &&
      o.sicherheit === regel.sicherheit;
    if (gleich) continue;

    await dbQuery(
      `UPDATE expense_booking_proposals
          SET property_id = $2, cost_category_id = $3, amount_gross = $4, anteil = $5,
              service_period_start = $6, service_period_end = $7,
              umlagefaehig = $8, sicherheit = $9, begruendung = $10
        WHERE id = $1 AND status = 'offen'`,
      [o.id, pid, cid, betrag, regel.anteil, zeitraum.start, zeitraum.ende,
        regel.umlagefaehig, regel.sicherheit, begruendung(regel, u)]);
    ergebnis.aktualisiert++;
  }

  await audit.log({
    actor: opts.actor,
    module: 'assets', action: 'expense_proposal.generate',
    entityType: 'expense_booking_proposal',
    after: {
      geprueft: ergebnis.geprueft, angelegt: ergebnis.angelegt,
      bereits_vorhanden: ergebnis.bereits_vorhanden,
      aktualisiert: ergebnis.aktualisiert, zurueckgezogen: ergebnis.zurueckgezogen,
      uebersprungen: ergebnis.uebersprungen, regeln: regeln.length,
      seit: opts.seit ?? null,
    },
  });

  return ergebnis;
}

/** Vorschläge mit Objekt-, Kostenart- und Umsatzangaben für die Oberfläche. */
export async function listeVorschlaege(
  opts: { status?: string; property?: string; limit?: number } = {},
) {
  const params: unknown[] = [];
  let sql = `
    SELECT p.*, pr.code AS property_code, pr.name AS property_name,
           cc.code AS cost_category_code, cc.name AS cost_category_name,
           t.booking_date AS tx_booking_date, t.amount AS tx_amount
      FROM expense_booking_proposals p
      JOIN properties pr ON pr.id = p.property_id
      JOIN cost_categories cc ON cc.id = p.cost_category_id
      LEFT JOIN banking_transactions t ON t.id = p.transaction_id
     WHERE 1 = 1`;
  if (opts.status) { params.push(opts.status); sql += ` AND p.status = $${params.length}`; }
  if (opts.property) { params.push(opts.property); sql += ` AND pr.code = $${params.length}`; }
  params.push(Math.min(opts.limit || 200, 500));
  sql += ` ORDER BY p.booking_date DESC, p.id DESC LIMIT $${params.length}`;

  const { rows } = await dbQuery(sql, params);
  return rows;
}

export interface BestaetigungsErgebnis {
  vorschlag_id: number;
  expense_booking_id: number;
  /** true, wenn der Vorschlag schon bestätigt war und keine neue Buchung entstand. */
  bereits_bestaetigt: boolean;
}

/**
 * Macht aus einem offenen Vorschlag genau eine Kostenbuchung.
 *
 * Idempotent: Ein bereits bestätigter Vorschlag liefert die vorhandene Buchung
 * zurück und legt keine zweite an. Das ist kein Luxus — ein doppelter Klick
 * oder ein wiederholter Aufruf würde sonst dieselbe Rechnung zweimal in die
 * Abrechnung geben.
 *
 * Beim Bestätigen lassen sich Kostenart und Umlagefähigkeit korrigieren; bei
 * mehreren Regeln steht ausdrücklich im Hinweis, dass das nötig sein kann.
 */
export async function bestaetige(
  id: number,
  aenderungen: { cost_category_id?: number; umlagefaehig?: boolean; notiz?: string } = {},
  actor?: string,
): Promise<BestaetigungsErgebnis | null> {
  const client = await getClient();
  try {
    await client.query('BEGIN');

    // FOR UPDATE: Zwei gleichzeitige Klicks dürfen nicht zwei Buchungen ergeben.
    const { rows: vs } = await client.query(
      'SELECT * FROM expense_booking_proposals WHERE id = $1 FOR UPDATE', [id]);
    if (vs.length === 0) { await client.query('ROLLBACK'); return null; }
    const v = vs[0];

    if (v.status === 'bestaetigt' && v.expense_booking_id) {
      await client.query('COMMIT');
      return { vorschlag_id: id, expense_booking_id: v.expense_booking_id, bereits_bestaetigt: true };
    }
    if (v.status === 'verworfen') {
      await client.query('ROLLBACK');
      throw new Error('Vorschlag ist verworfen — erst wieder öffnen, dann bestätigen');
    }

    const kostenart = aenderungen.cost_category_id ?? v.cost_category_id;
    const umlagefaehig = aenderungen.umlagefaehig ?? v.umlagefaehig;

    const notizen = [
      `Aus Buchungsvorschlag #${id} (Regel ${v.rule_id}).`,
      v.begruendung || '',
      aenderungen.notiz || '',
    ].filter(Boolean).join(' ');

    const { rows: buchung } = await client.query(
      `INSERT INTO expense_bookings
         (source_key, property_id, cost_category_id, vendor_name,
          service_period_start, service_period_end, payment_date,
          amount_gross, umlagefaehig, notes)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`,
      [
        `proposal_${id}`, v.property_id, kostenart, v.vendor_name,
        v.service_period_start, v.service_period_end, v.booking_date,
        v.amount_gross, umlagefaehig, notizen,
      ],
    );

    await client.query(
      `UPDATE expense_booking_proposals
          SET status = 'bestaetigt', expense_booking_id = $2,
              cost_category_id = $3, umlagefaehig = $4,
              entschieden_am = now(), entschieden_von = $5, notiz = $6
        WHERE id = $1`,
      [id, buchung[0].id, kostenart, umlagefaehig, actor || 'owner', aenderungen.notiz || null],
    );

    await client.query('COMMIT');

    await audit.log({
      actor,
      module: 'assets', action: 'expense_proposal.confirm',
      entityType: 'expense_booking_proposal', entityId: String(id),
      before: { status: v.status, cost_category_id: v.cost_category_id, umlagefaehig: v.umlagefaehig },
      after: {
        status: 'bestaetigt', expense_booking_id: buchung[0].id,
        cost_category_id: kostenart, umlagefaehig,
        amount_gross: v.amount_gross, rule_id: v.rule_id,
      },
    });

    return { vorschlag_id: id, expense_booking_id: buchung[0].id, bereits_bestaetigt: false };
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}

/** Verwirft einen Vorschlag. Es entsteht keine Buchung. */
export async function verwirf(
  id: number, grund?: string, actor?: string,
): Promise<{ vorschlag_id: number; status: string } | null> {
  const { rows: vorher } = await dbQuery(
    'SELECT status, rule_id FROM expense_booking_proposals WHERE id = $1', [id]);
  if (vorher.length === 0) return null;
  if (vorher[0].status === 'bestaetigt') {
    throw new Error('Vorschlag ist bestätigt und hat eine Buchung erzeugt — diese zuerst aufheben');
  }

  await dbQuery(
    `UPDATE expense_booking_proposals
        SET status = 'verworfen', entschieden_am = now(), entschieden_von = $2, notiz = $3
      WHERE id = $1`,
    [id, actor || 'owner', grund || null]);

  await audit.log({
    actor,
    module: 'assets', action: 'expense_proposal.reject',
    entityType: 'expense_booking_proposal', entityId: String(id),
    before: { status: vorher[0].status },
    after: { status: 'verworfen', grund: grund || null, rule_id: vorher[0].rule_id },
  });

  return { vorschlag_id: id, status: 'verworfen' };
}
