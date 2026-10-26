/**
 * briefing/store — Ablage der Morgen- und Abendbriefings (Tabelle `briefings`).
 *
 * Eine Zeile je Art und Berliner Kalendertag. Der Taktgeber liest daraus, ob
 * ein Briefing heute schon zugestellt ist — das überlebt einen Neustart des
 * Gateways, die frühere Variable `lastBriefingDate` tat das nicht.
 */
import { query as dbQuery } from '../../shared/db/index.js';

export type BriefingArt = 'morgen' | 'abend';
export type BriefingStatus = 'erzeugt' | 'gesendet' | 'fehler';

export interface BriefingEintrag {
  art: BriefingArt;
  /** YYYY-MM-DD, Berliner Kalendertag */
  datum: string;
  textHtml: string;
  status: BriefingStatus;
  versuche: number;
  telegramOk: boolean;
  mailOk: boolean | null;
  fehler: string | null;
  fehlerGemeldet: boolean;
  erzeugtAt: string;
  gesendetAt: string | null;
}

function abbilden(r: any): BriefingEintrag {
  return {
    art: r.art,
    datum: r.datum,
    textHtml: r.text_html,
    status: r.status,
    versuche: Number(r.versuche),
    telegramOk: !!r.telegram_ok,
    mailOk: r.mail_ok === null ? null : !!r.mail_ok,
    fehler: r.fehler,
    fehlerGemeldet: !!r.fehler_gemeldet,
    erzeugtAt: new Date(r.erzeugt_at).toISOString(),
    gesendetAt: r.gesendet_at ? new Date(r.gesendet_at).toISOString() : null,
  };
}

const SPALTEN = `art, to_char(datum, 'YYYY-MM-DD') AS datum, text_html, status, versuche,
  telegram_ok, mail_ok, fehler, fehler_gemeldet, erzeugt_at, gesendet_at`;

export async function holeBriefing(art: BriefingArt, datum: string): Promise<BriefingEintrag | null> {
  const { rows } = await dbQuery(
    `SELECT ${SPALTEN} FROM briefings WHERE art = $1 AND datum = $2`, [art, datum]);
  return rows[0] ? abbilden(rows[0]) : null;
}

/**
 * Einen Erzeugungsversuch festhalten. Zählt `versuche` hoch; ein späterer
 * Versuch überschreibt Text und Status des früheren.
 */
export async function speichereVersuch(e: {
  art: BriefingArt; datum: string; textHtml: string; status: BriefingStatus;
  telegramOk: boolean; mailOk: boolean | null; fehler: string | null;
}): Promise<void> {
  await dbQuery(
    `INSERT INTO briefings (art, datum, text_html, status, versuche, telegram_ok, mail_ok, fehler, gesendet_at)
     VALUES ($1, $2, $3, $4, 1, $5, $6, $7, CASE WHEN $4 = 'gesendet' THEN NOW() END)
     ON CONFLICT (art, datum) DO UPDATE SET
       text_html   = CASE WHEN EXCLUDED.text_html <> '' THEN EXCLUDED.text_html ELSE briefings.text_html END,
       status      = EXCLUDED.status,
       versuche    = briefings.versuche + 1,
       telegram_ok = EXCLUDED.telegram_ok,
       -- Eine einmal zugestellte Mail bleibt zugestellt, auch wenn der
       -- Nachholversuch sie nicht noch einmal schickt.
       mail_ok     = CASE WHEN briefings.mail_ok THEN TRUE ELSE EXCLUDED.mail_ok END,
       fehler      = EXCLUDED.fehler,
       erzeugt_at  = NOW(),
       gesendet_at = CASE WHEN EXCLUDED.status = 'gesendet' THEN NOW() ELSE briefings.gesendet_at END`,
    [e.art, e.datum, e.textHtml, e.status, e.telegramOk, e.mailOk, e.fehler],
  );
}

/** Spätere Zustellung desselben Textes (Telegram-Wiederholung) nachtragen. */
export async function markiereGesendet(art: BriefingArt, datum: string): Promise<void> {
  await dbQuery(
    `UPDATE briefings SET status = 'gesendet', telegram_ok = TRUE, fehler = NULL, gesendet_at = NOW()
      WHERE art = $1 AND datum = $2`, [art, datum]);
}

export async function markiereFehlerGemeldet(art: BriefingArt, datum: string, fehler: string): Promise<void> {
  await dbQuery(
    `INSERT INTO briefings (art, datum, status, fehler, fehler_gemeldet)
     VALUES ($1, $2, 'fehler', $3, TRUE)
     ON CONFLICT (art, datum) DO UPDATE SET status = 'fehler', fehler = $3, fehler_gemeldet = TRUE`,
    [art, datum, fehler]);
}

/** Briefings der letzten `tage` Kalendertage, neueste zuerst — für das Dashboard. */
export async function listeBriefings(tage = 7): Promise<BriefingEintrag[]> {
  const n = Math.min(Math.max(Math.trunc(tage) || 7, 1), 31);
  const { rows } = await dbQuery(
    `SELECT ${SPALTEN} FROM briefings
      WHERE datum > CURRENT_DATE - $1::int
      ORDER BY datum DESC, art DESC`, [n]);
  return rows.map(abbilden);
}

/** Ist das Briefing dieser Art für den Tag zugestellt? */
export async function istZugestellt(art: BriefingArt, datum: string): Promise<boolean> {
  const e = await holeBriefing(art, datum);
  return !!e && e.status === 'gesendet';
}
