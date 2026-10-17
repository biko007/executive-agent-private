/**
 * nk/alerts — §556 BGB deadline tracking and alerting.
 * Sprint 5.5b — Etappe j
 *
 * Queries nk_period_obligations for approaching/expired service deadlines.
 * Logs alerts and sends Telegram notifications via /api/internal/notify.
 */
import { query as dbQuery } from '../../shared/db/index.js';

interface AlertMatch {
  obligation_id: number;
  property_code: string;
  year: number;
  service_deadline_at: string;
  days_remaining: number;
  alert_phase: string;
  status: string;
}

const ALERT_THRESHOLDS: { phase: string; days: number; severity: string }[] = [
  { phase: 'expired', days: 0, severity: 'error' },
  { phase: '1d', days: 1, severity: 'error' },
  { phase: '7d', days: 7, severity: 'warn' },
  { phase: '14d', days: 14, severity: 'warn' },
  { phase: '30d', days: 30, severity: 'info' },
];

/**
 * Check all obligations for approaching/expired deadlines.
 * Inserts alert_log entries and sends Telegram notifications.
 */
export async function handleObligationsAlert(): Promise<{
  checked: number;
  alerts_sent: number;
  errors: string[];
}> {
  const errors: string[] = [];
  let alertsSent = 0;

  // Find obligations with service_deadline_at that are approaching or expired
  const { rows: obligations } = await dbQuery<AlertMatch>(
    `SELECT
       o.id AS obligation_id,
       p.code AS property_code,
       o.year,
       o.service_deadline_at::text,
       (o.service_deadline_at - CURRENT_DATE)::int AS days_remaining,
       o.status
     FROM nk_period_obligations o
     JOIN properties p ON o.property_id = p.id
     WHERE o.service_deadline_at IS NOT NULL
       AND o.status NOT IN ('served', 'expired')
     ORDER BY o.service_deadline_at`,
  );

  for (const obl of obligations) {
    for (const threshold of ALERT_THRESHOLDS) {
      if (obl.days_remaining > threshold.days) continue;

      // Determine phase
      const phase = obl.days_remaining <= 0 ? 'expired' : threshold.phase;

      // Try to insert alert (UNIQUE constraint prevents duplicates for same day)
      try {
        const { rowCount } = await dbQuery(
          `INSERT INTO nk_alert_log (obligation_id, alert_phase, alert_date, details)
           VALUES ($1, $2, CURRENT_DATE, $3)
           ON CONFLICT (obligation_id, alert_phase, alert_date) DO NOTHING`,
          [obl.obligation_id, phase, JSON.stringify({
            property_code: obl.property_code,
            year: obl.year,
            days_remaining: obl.days_remaining,
            service_deadline_at: obl.service_deadline_at,
          })],
        );

        if (rowCount && rowCount > 0) {
          // New alert — send notification
          const message = formatAlertMessage(obl, phase);
          try {
            await sendNotification(message, threshold.severity);
            alertsSent++;
          } catch (e: any) {
            errors.push(`Notify failed for obligation ${obl.obligation_id}: ${e.message}`);
          }
        }
      } catch (e: any) {
        errors.push(`Alert insert failed for obligation ${obl.obligation_id}: ${e.message}`);
      }

      // Only match the most urgent threshold per obligation
      break;
    }

    // If expired, update obligation status
    if (obl.days_remaining <= 0 && obl.status !== 'expired') {
      await dbQuery(
        `UPDATE nk_period_obligations SET status = 'expired' WHERE id = $1`,
        [obl.obligation_id],
      ).catch(e => errors.push(`Status update failed: ${e.message}`));
    }
  }

  return { checked: obligations.length, alerts_sent: alertsSent, errors };
}

function formatAlertMessage(obl: AlertMatch, phase: string): string {
  if (phase === 'expired') {
    return `⚠️ NK-Frist ABGELAUFEN: ${obl.property_code} ${obl.year}\n` +
      `Fristende war: ${obl.service_deadline_at}\n` +
      `§556 Abs. 3 BGB: Nachforderungen sind ausgeschlossen!`;
  }

  return `📋 NK-Frist ${obl.property_code} ${obl.year}: ` +
    `noch ${obl.days_remaining} Tag${obl.days_remaining !== 1 ? 'e' : ''}\n` +
    `Fristende: ${obl.service_deadline_at}`;
}

/**
 * Gestaltete Meldung (14.10.2026): Symbol und fetter Titel wie bei allen
 * Systemmeldungen; der Fristtext steht darunter. `lage` ergibt sich aus der
 * Dringlichkeit, die der Aufrufer ohnehin kennt.
 */
async function sendNotification(message: string, severity: string): Promise<void> {
  const lage = severity === 'error' ? 'fehler' : severity === 'warn' ? 'hinweis' : 'ok';
  const resp = await fetch('http://127.0.0.1:18789/api/internal/notify', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      message, severity,
      lage, titel: 'Nebenkosten-Frist',
      zeilen: message.split('\n').map(z => z.trim()).filter(Boolean),
    }),
  });
  if (!resp.ok) {
    const text = await resp.text().catch(() => '');
    throw new Error(`Notify HTTP ${resp.status}: ${text}`);
  }
}


/* ════════════════════════════════════════════════════════════════════════
   Objektfristen — der zweite Meldeweg (Owner-Auftrag 17.10.2026)

   WARUM ES DAS GIBT. `objekt_fristen` wurde bis heute von genau einer Stelle
   gelesen: der Objektkachel des Steckbriefs. Ein Termin stand dort, meldete
   sich aber nie von selbst. Nachgewiesen am 17.10.2026 — der Tageslauf
   zaehlte 0 Verpflichtungen, obwohl zwei Fristen eingetragen waren.

   WARUM NICHT UEBER nk_period_obligations. Jene Tabelle verlangt unit_id,
   lease_id und tenant_id als Pflichtfelder; sie bildet die Abrechnungspflicht
   je MIETER ab. Eine Frist je OBJEKT passt dort nicht hinein, ohne einen
   Mieter zu erfinden.

   DEDUPE OHNE NEUE TABELLE. `nk_alert_log` hat einen Fremdschluessel auf
   nk_period_obligations und eine CHECK-Liste der NK-Phasen; es kann diese
   Meldungen nicht aufnehmen. Eine eigene Tabelle waere eine Migration und
   damit ein roter Pfad — fuer eine Handvoll Fristen unverhaeltnismaessig.
   Das Protokoll steht deshalb als Datensatz in
   `system_settings.fristen_alarm_log`:

     { "<frist_id>": { "vorlauf": "2026-11-16", "termin": "...", ... } }

   Je Frist und Phase steht dort das Datum der letzten Meldung. Daraus folgt
   die Regel „hoechstens eine Meldung je Frist und Tag" ohne weitere Logik.
   ════════════════════════════════════════════════════════════════════════ */

interface FristMatch {
  frist_id: number;
  property_code: string;
  art: string;
  bezeichnung: string;
  termin: string;
  vorlauf_tage: number;
  tage_bis: number;
  verantwortlich: string | null;
}

/** Welche Meldung ist heute faellig — oder keine. */
export function fristPhase(
  tageBis: number, vorlaufTage: number,
): 'vorlauf' | 'termin' | 'ueberfaellig' | null {
  if (tageBis < 0) return 'ueberfaellig';
  if (tageBis === 0) return 'termin';
  /* Der Vorlauf meldet GENAU am Stichtag, nicht jeden Tag danach — sonst
     stuende dieselbe Frist 45 Tage lang jeden Morgen im Chat. */
  if (vorlaufTage > 0 && tageBis === vorlaufTage) return 'vorlauf';
  return null;
}

/** Text der Meldung. Kurz: Sie steht auf einem Telefon. */
export function fristMeldung(f: FristMatch, phase: string): string {
  const termin = f.termin.split('-').reverse().join('.');
  if (phase === 'ueberfaellig') {
    return `⚠️ Frist ÜBERFÄLLIG: ${f.property_code} — ${f.bezeichnung}\n`
      + `Termin war ${termin}, seit ${Math.abs(f.tage_bis)} Tag${Math.abs(f.tage_bis) !== 1 ? 'en' : ''}.\n`
      + 'Die Meldung kommt täglich, bis die Frist als erledigt eingetragen ist.';
  }
  if (phase === 'termin') {
    return `📅 Frist HEUTE: ${f.property_code} — ${f.bezeichnung}\nTermin: ${termin}`;
  }
  return `📋 Frist in ${f.tage_bis} Tagen: ${f.property_code} — ${f.bezeichnung}\nTermin: ${termin}`;
}

/**
 * Offene Objektfristen pruefen und melden.
 *
 * Meldet am Vorlauftag, am Termin und danach taeglich, bis `erledigt_am`
 * gesetzt ist. Zustellung wie bei den NK-Fristen in den Owner-DM: Eine Frist,
 * die der Owner persoenlich einhalten muss, ist ein operativer Alarm und
 * gehoert nicht in die Dev-Gruppe.
 */
export async function handleFristenAlert(): Promise<{
  checked: number;
  alerts_sent: number;
  errors: string[];
}> {
  const errors: string[] = [];
  let alertsSent = 0;

  const { rows: fristen } = await dbQuery<FristMatch>(
    `SELECT f.id AS frist_id, p.code AS property_code, f.art, f.bezeichnung,
            to_char(f.termin,'YYYY-MM-DD') AS termin, f.vorlauf_tage,
            (f.termin - CURRENT_DATE)::int AS tage_bis, f.verantwortlich
       FROM objekt_fristen f
       JOIN properties p ON p.id = f.property_id
      WHERE f.erledigt_am IS NULL
      ORDER BY f.termin`,
  );

  const { rows: logRows } = await dbQuery<{ value: any }>(
    `SELECT value FROM system_settings WHERE key = 'fristen_alarm_log'`);
  const log: Record<string, Record<string, string>> = logRows[0]?.value || {};
  const heute = new Date().toISOString().slice(0, 10);
  let veraendert = false;

  for (const f of fristen) {
    const phase = fristPhase(f.tage_bis, f.vorlauf_tage);
    if (!phase) continue;
    const bisher = log[String(f.frist_id)]?.[phase];
    if (bisher === heute) continue;              // heute schon gemeldet
    try {
      const lage = phase === 'ueberfaellig' ? 'fehler' : phase === 'termin' ? 'hinweis' : 'ok';
      await sendeFristmeldung(fristMeldung(f, phase), lage,
        `Frist ${f.frist_id} ${f.property_code} ${phase}`);
      log[String(f.frist_id)] = { ...(log[String(f.frist_id)] || {}), [phase]: heute };
      veraendert = true;
      alertsSent++;
    } catch (e: any) {
      errors.push(`Frist ${f.frist_id} (${f.property_code}): ${e.message}`);
    }
  }

  if (veraendert) {
    await dbQuery(
      `INSERT INTO system_settings (key, value) VALUES ('fristen_alarm_log', $1::jsonb)
       ON CONFLICT (key) DO UPDATE SET value = $1::jsonb, updated_at = now()`,
      [JSON.stringify(log)],
    ).catch(e => errors.push(`Protokoll nicht gespeichert: ${e.message}`));
  }

  return { checked: fristen.length, alerts_sent: alertsSent, errors };
}

/**
 * Eine Fristmeldung zustellen — und die Zustellung protokollieren.
 *
 * Die Notify-Route schreibt nur im Fehlerfall ins Protokoll. Beim Selbsttest
 * am 17.10.2026 liess sich deshalb nicht belegen, dass eine Meldung wirklich
 * ankam: kein Fehler, aber auch keine Zeile. Diese Funktion schreibt die
 * Nachrichtennummer mit, die Telegram zurueckgibt. Ohne sie ist jede spaetere
 * Frage „kam die Erinnerung an?" nur mit einem Blick ins Telefon zu
 * beantworten.
 */
async function sendeFristmeldung(text: string, lage: string, kennung: string): Promise<void> {
  const resp = await fetch('http://127.0.0.1:18789/api/internal/notify', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      message: text,
      severity: lage === 'fehler' ? 'error' : lage === 'hinweis' ? 'warn' : 'info',
      lage, titel: 'Objektfrist',
      zeilen: text.split('\n').map(z => z.trim()).filter(Boolean),
    }),
  });
  if (!resp.ok) {
    const t = await resp.text().catch(() => '');
    throw new Error(`Notify HTTP ${resp.status}: ${t}`);
  }
  const d: any = await resp.json().catch(() => ({}));
  console.log(`[fristen-alarm] zugestellt: ${kennung}`
    + (d?.message_id ? ` (Nachricht ${d.message_id})` : ' (ohne Nachrichtennummer)'));
}
