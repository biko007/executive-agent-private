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
  istRechnungsregel, ordneSammelueberweisungZu,
  type AusgabenRegel, type UmsatzZeile, type Rechnung,
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
  /** Vorschlag zurueckgezogen, weil fuer dieselbe Zahlung schon eine Buchung besteht. */
  bereits_gebucht: number;
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

/** Begründung für einen Treffer über den Rechnungsabgleich. */
function begruendungRechnung(
  regel: AusgabenRegel, r: Rechnung, posten: number, u: UmsatzZeile,
): string {
  const teile = [
    `Regel ${regel.id} (Rechnungsabgleich)`,
    posten > 1
      ? `Sammelüberweisung über ${Math.abs(u.amount).toFixed(2)} Euro aus ${posten} Rechnungen`
      : `Sammelüberweisung über ${Math.abs(u.amount).toFixed(2)} Euro`,
    r.nr ? `Rechnung ${r.nr} über ${r.betrag.toFixed(2)} Euro` : `Rechnung über ${r.betrag.toFixed(2)} Euro`,
  ];
  if (r.lieferdatum) teile.push(`Leistung am ${r.lieferdatum}`);
  else teile.push('Leistungsdatum unbekannt — Zahltag angesetzt');
  if (r.hinweis) teile.push(r.hinweis);
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
    aktualisiert: 0, zurueckgezogen: 0, uebersprungen: 0, bereits_gebucht: 0,
    hinweise: [],
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

  // Rechnungspool fuer den Abgleich von Sammelueberweisungen. Er geht ueber ALLE
  // Regeln, weil eine Ueberweisung Rechnungen verschiedener Lieferanten
  // zusammenfassen kann — jede erzeugt dann ihren eigenen Vorschlag.
  const rechnungsPool = regeln
    .filter(istRechnungsregel)
    .flatMap(r => (r.rechnungen || []).map(rg => ({ regelId: r.id, rechnung: rg })));
  const regelNachId = new Map(regeln.map(r => [r.id, r]));

  const params: unknown[] = [];
  let sql = `SELECT id, booking_date, value_date, amount, counterparty_name, reference,
                    transaction_code
               FROM banking_transactions WHERE amount < 0`;
  if (opts.seit) { params.push(opts.seit); sql += ` AND booking_date >= $${params.length}`; }
  if (opts.accountIds && opts.accountIds.length > 0) {
    params.push(opts.accountIds); sql += ` AND account_id = ANY($${params.length})`;
  }
  sql += ' ORDER BY booking_date';

  const { rows } = await dbQuery<{
    id: number; booking_date: Date; value_date: Date | null;
    amount: string; counterparty_name: string | null; reference: string | null;
    transaction_code: string | null;
  }>(sql, params);

  for (const r of rows) {
    const u: UmsatzZeile = {
      id: r.id,
      booking_date: new Date(r.booking_date).toISOString().slice(0, 10),
      value_date: r.value_date ? new Date(r.value_date).toISOString().slice(0, 10) : null,
      amount: parseFloat(r.amount),
      counterparty_name: r.counterparty_name,
      reference: r.reference,
      transaction_code: r.transaction_code,
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

    // ── Rechnungsabgleich fuer Sammelueberweisungen ────────────────────────
    const { treffer, mehrdeutig } = ordneSammelueberweisungZu(u, rechnungsPool);
    if (mehrdeutig) {
      const text = `Sammelüberweisung ${u.booking_date} über ${Math.abs(u.amount).toFixed(2)} Euro: `
        + 'mehrere Rechnungszusammenstellungen ergeben denselben Betrag — kein Vorschlag, '
        + 'bitte von Hand zuordnen.';
      if (!ergebnis.hinweise.includes(text)) ergebnis.hinweise.push(text);
    }

    for (const tr of treffer) {
      const regel = regelNachId.get(tr.regelId);
      if (!regel) continue;
      const pid = objektId.get(regel.property);
      const cid = artId.get(regel.cost_category);
      if (!pid || !cid) {
        ergebnis.uebersprungen++;
        const text = `Regel ${regel.id}: ${!pid ? `Objekt ${regel.property}` : `Kostenart ${regel.cost_category}`} unbekannt`;
        if (!ergebnis.hinweise.includes(text)) ergebnis.hinweise.push(text);
        continue;
      }

      // Der Leistungszeitraum richtet sich nach dem Lieferdatum der RECHNUNG,
      // nicht nach dem Zahltag — das ist der Kern des Leistungsprinzips.
      const stichtag = tr.rechnung.lieferdatum || u.booking_date;
      const zeitraum = leistungszeitraum(regel.service_period, { ...u, booking_date: stichtag });

      const { rows: angelegtR } = await dbQuery<{ id: number }>(
        `INSERT INTO expense_booking_proposals
           (property_id, transaction_id, rule_id, cost_category_id, vendor_name,
            booking_date, amount_gross, anteil, service_period_start, service_period_end,
            umlagefaehig, sicherheit, begruendung, reference)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
         ON CONFLICT (transaction_id, rule_id) WHERE transaction_id IS NOT NULL
           DO NOTHING
         RETURNING id`,
        [
          pid, u.id, regel.id, cid, null,
          u.booking_date, Math.round(tr.rechnung.betrag * 100) / 100, 1,
          zeitraum.start, zeitraum.ende,
          regel.umlagefaehig, regel.sicherheit,
          begruendungRechnung(regel, tr.rechnung, tr.posten, u),
          tr.rechnung.nr ? `Rechnung ${tr.rechnung.nr}` : 'Sammelüberweisung',
        ],
      );
      if (angelegtR.length > 0) ergebnis.angelegt++;
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
            t.reference AS tx_reference, t.transaction_code AS tx_code
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
      transaction_code: o.tx_code,
    };

    // Rechnungsregeln laufen nicht ueber trifft(). Ohne diesen Zweig wuerde die
    // Pruefung unten jeden Rechnungsvorschlag sofort wieder zurueckziehen.
    let rechnung: Rechnung | null = null;
    if (regel && istRechnungsregel(regel)) {
      const { treffer } = ordneSammelueberweisungZu(u, rechnungsPool);
      rechnung = treffer.find(x => x.regelId === regel.id)?.rechnung ?? null;
      if (rechnung) {
        const stichtag = rechnung.lieferdatum || u.booking_date;
        const z = leistungszeitraum(regel.service_period, { ...u, booking_date: stichtag });
        const pidR = objektId.get(regel.property);
        const cidR = artId.get(regel.cost_category);
        if (!pidR || !cidR) continue;
        const betragR = Math.round(rechnung.betrag * 100) / 100;
        const gleichR =
          Number(o.property_id) === pidR &&
          Number(o.cost_category_id) === cidR &&
          Math.abs(parseFloat(o.amount_gross) - betragR) < 0.005 &&
          isoTag(o.service_period_start) === z.start &&
          isoTag(o.service_period_end) === z.ende &&
          o.umlagefaehig === regel.umlagefaehig &&
          o.sicherheit === regel.sicherheit;
        if (!gleichR) {
          await dbQuery(
            `UPDATE expense_booking_proposals
                SET property_id = $2, cost_category_id = $3, amount_gross = $4, anteil = 1,
                    service_period_start = $5, service_period_end = $6,
                    umlagefaehig = $7, sicherheit = $8, begruendung = $9
              WHERE id = $1 AND status = 'offen'`,
            [o.id, pidR, cidR, betragR, z.start, z.ende,
              regel.umlagefaehig, regel.sicherheit,
              begruendungRechnung(regel, rechnung, 1, u)]);
          ergebnis.aktualisiert++;
        }
        continue;
      }
    }

    if (!regel || (istRechnungsregel(regel) ? !rechnung : !trifft(regel, u))) {
      await dbQuery(
        `UPDATE expense_booking_proposals
            SET status = 'verworfen', entschieden_am = now(), entschieden_von = 'system',
                notiz = $2
          WHERE id = $1 AND status = 'offen'`,
        [o.id, !regel
          ? `Regel ${o.rule_id} ist nicht mehr hinterlegt.`
          : istRechnungsregel(regel)
            ? `Regel ${o.rule_id}: keine Rechnung erklaert diese Zahlung mehr (Rechnungsliste geaendert).`
            : `Regel ${o.rule_id} trifft auf diesen Umsatz nicht mehr zu (Regelstand geaendert).`]);
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

  // ── Abgleich gegen bereits vorhandene Kostenbuchungen ────────────────────
  //
  // In Paket 2 sind 16 Buchungen von Hand angelegt worden. Ein Vorschlag, der
  // dieselbe Zahlung noch einmal anbietet, wuerde bei einem Klick dieselbe
  // Rechnung zweimal in die Abrechnung geben.
  //
  // Zwei Stufen, weil die Datenlage zwei Faelle kennt:
  //
  //   1. ZAHLUNGSGENAU: gleiches Objekt, gleicher Betrag, Zahltag der Buchung
  //      im Abstand von hoechstens drei Tagen zum Umsatz. Das ist eindeutig —
  //      der Vorschlag wird zurueckgezogen und nennt die Buchung.
  //   2. ZEITRAUM-UEBERSCHNEIDUNG: gleiches Objekt, gleiche Kostenart,
  //      ueberschneidender Leistungszeitraum, aber kein zahlungsgenauer
  //      Treffer. Das trifft die drei Sammelbuchungen aus Paket 2, die mehrere
  //      Zahlungen zusammenfassen (Wasserabschlaege 210,00; Allgemeinstrom
  //      1.086,60; NEW 584,00). Hier wird NICHT zurueckgezogen — die Zuordnung
  //      ist nicht eindeutig, und ein stilles Unterdruecken koennte einen
  //      echten Posten verschlucken. Stattdessen bekommt der Vorschlag eine
  //      ausdrueckliche Warnung in die Begruendung.
  //
  // Ein eigener Status "bereits gebucht" waere eine Schemaaenderung und damit
  // Rote Zone; der Nachtrag verlangt ausdruecklich keine. Stufe 1 nutzt deshalb
  // 'verworfen' mit sprechender Notiz — fuer den Owner ist es damit wie
  // gefordert nicht mehr offen, und der Grund steht dabei.
  const { rows: buchungen } = await dbQuery<any>(
    `SELECT id, property_id, cost_category_id, amount_gross, payment_date,
            service_period_start, service_period_end
       FROM expense_bookings WHERE archived_at IS NULL`);

  const { rows: nochOffen } = await dbQuery<any>(
    `SELECT id, property_id, cost_category_id, amount_gross, booking_date,
            service_period_start, service_period_end, begruendung
       FROM expense_booking_proposals WHERE status = 'offen'`);

  const tageAbstand = (a: string, b: string) =>
    Math.abs(new Date(`${a}T00:00:00Z`).getTime() - new Date(`${b}T00:00:00Z`).getTime()) / 86400000;

  for (const v of nochOffen) {
    const vTag = isoTag(v.booking_date)!;
    const vBetrag = parseFloat(v.amount_gross);

    const genau = buchungen.find(b =>
      Number(b.property_id) === Number(v.property_id) &&
      Math.abs(parseFloat(b.amount_gross) - vBetrag) < 0.005 &&
      b.payment_date && tageAbstand(isoTag(b.payment_date)!, vTag) <= 3);

    if (genau) {
      await dbQuery(
        `UPDATE expense_booking_proposals
            SET status = 'verworfen', entschieden_am = now(), entschieden_von = 'system',
                notiz = $2
          WHERE id = $1 AND status = 'offen'`,
        [v.id, `Bereits gebucht: Kostenbuchung #${genau.id} über `
          + `${parseFloat(genau.amount_gross).toFixed(2)} Euro, bezahlt am `
          + `${isoTag(genau.payment_date)}. Automatisch zurückgezogen, damit dieselbe `
          + 'Rechnung nicht zweimal in die Abrechnung geht.']);
      ergebnis.bereits_gebucht++;
      continue;
    }

    const ueberschneidung = buchungen.find(b =>
      Number(b.property_id) === Number(v.property_id) &&
      Number(b.cost_category_id) === Number(v.cost_category_id) &&
      b.service_period_start && b.service_period_end &&
      v.service_period_start && v.service_period_end &&
      isoTag(b.service_period_start)! <= isoTag(v.service_period_end)! &&
      isoTag(b.service_period_end)! >= isoTag(v.service_period_start)!);

    if (ueberschneidung) {
      const warnung = `ACHTUNG: Für dieses Objekt, diese Kostenart und diesen Zeitraum `
        + `besteht bereits die Kostenbuchung #${ueberschneidung.id} über `
        + `${parseFloat(ueberschneidung.amount_gross).toFixed(2)} Euro `
        + `(${isoTag(ueberschneidung.service_period_start)} bis `
        + `${isoTag(ueberschneidung.service_period_end)}). Vor dem Übernehmen prüfen, `
        + 'ob die Zahlung dort schon enthalten ist.';
      if (!String(v.begruendung || '').includes('ACHTUNG: Für dieses Objekt')) {
        await dbQuery(
          `UPDATE expense_booking_proposals SET begruendung = $2
            WHERE id = $1 AND status = 'offen'`,
          [v.id, `${v.begruendung || ''} · ${warnung}`]);
        ergebnis.aktualisiert++;
      }
    }
  }

  await audit.log({
    actor: opts.actor,
    module: 'assets', action: 'expense_proposal.generate',
    entityType: 'expense_booking_proposal',
    after: {
      geprueft: ergebnis.geprueft, angelegt: ergebnis.angelegt,
      bereits_vorhanden: ergebnis.bereits_vorhanden,
      aktualisiert: ergebnis.aktualisiert, zurueckgezogen: ergebnis.zurueckgezogen,
      uebersprungen: ergebnis.uebersprungen, bereits_gebucht: ergebnis.bereits_gebucht,
      regeln: regeln.length,
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
