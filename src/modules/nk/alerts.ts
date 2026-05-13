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

async function sendNotification(message: string, severity: string): Promise<void> {
  const resp = await fetch('http://127.0.0.1:18789/api/internal/notify', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ message, severity }),
  });
  if (!resp.ok) {
    const text = await resp.text().catch(() => '');
    throw new Error(`Notify HTTP ${resp.status}: ${text}`);
  }
}
