/**
 * health/commands — Telegram command handlers for the Health + Withings module.
 *
 * Sprint 4: All store/withings calls are now async (DB-backed).
 */
import http from 'node:http';
import {
  appendEntry, readEntries, lastEntry,
  summarize, formatSummary,
  getWeightTrend, getSleepTrend, checkHealthAlerts,
  hasEntryForDate, upsertEntryForDate, appendEntryWithTimestamp,
} from './store.js';
import {
  buildAuthUrl, exchangeCode, ensureFreshToken, saveTokens, isAuthorized, loadTokens,
  fetchMeasures, fetchSleep, fetchActivity, fetchWorkouts,
  executeWithingsSync, getSyncStatus,
} from './withings.js';
import type { WithingsSyncResult, WithingsSyncStatus } from './withings.js';
import {
  loadSettings, saveSettings, setSetting,
} from '../../shared/settings/index.js';
import { berlinDate } from '../../shared/utils/index.js';
import * as audit from '../../shared/audit/index.js';

// ── Dependency injection ───────────────────────────────────────────────────

export interface HealthDeps {
  sendTelegram: (chatId: string, text: string) => Promise<any>;
}

let _deps: HealthDeps | null = null;

export function initHealthCommands(deps: HealthDeps): void {
  _deps = deps;
}

// ── Withings config (from env) ─────────────────────────────────────────────

const withingsClientId     = process.env.WITHINGS_CLIENT_ID || '';
const withingsClientSecret = process.env.WITHINGS_CLIENT_SECRET || '';
const withingsRedirectUri  = 'http://46.62.153.181:8080/withings/callback';
const withingsCallbackPort = 8080;

let withingsCallbackServer: http.Server | null = null;

// ── Briefing pre-sync (exported for briefing use) ──────────────────────────

export async function syncWithingsForBriefing(): Promise<void> {
  if (!withingsClientId || !withingsClientSecret || !(await isAuthorized())) return;
  try {
    const tokens = await ensureFreshToken(withingsClientId, withingsClientSecret);
    const sinceMs = Date.now() - 36 * 60 * 60 * 1000; // last 36h to catch morning updates

    const measures = await fetchMeasures(tokens.access_token, sinceMs).catch(() => [] as any[]);
    for (const m of measures) {
      const dateStr = m.date.toISOString().slice(0, 10);
      if (m.weight_kg != null && !(await hasEntryForDate('weight', dateStr)))
        await appendEntryWithTimestamp(m.date, { type: 'weight', value: m.weight_kg, unit: 'kg', source: 'withings' });
      if (m.fat_ratio_pct != null && !(await hasEntryForDate('body_fat', dateStr)))
        await appendEntryWithTimestamp(m.date, { type: 'body_fat', value: m.fat_ratio_pct, unit: '%', source: 'withings' });
      if (m.hr_bpm != null && !(await hasEntryForDate('heartrate', dateStr)))
        await appendEntryWithTimestamp(m.date, { type: 'heartrate', hr_avg: m.hr_bpm, source: 'withings' });
    }

    const sleeps = await fetchSleep(tokens.access_token, sinceMs).catch(() => [] as any[]);
    for (const s of sleeps) {
      const ts = new Date(`${s.date}T03:00:00.000Z`);
      await upsertEntryForDate(s.date, ts, {
        type: 'sleep', value: s.total_h, unit: 'h',
        deep_sleep_h: s.deep_h, rem_sleep_h: s.rem_h, light_sleep_h: s.light_h,
        quality: s.score, source: 'withings',
      });
    }

    await saveTokens({ ...tokens, last_sync: Date.now() });
  } catch (e: any) {
    // Logged by caller if needed — don't crash briefing
  }
}

// ── Withings sync for n8n endpoint ─────────────────────────────────────────

export async function triggerWithingsSync(): Promise<WithingsSyncResult> {
  if (!withingsClientId || !withingsClientSecret) {
    throw new Error('WITHINGS_CLIENT_ID or WITHINGS_CLIENT_SECRET not set');
  }

  const settings = loadSettings();
  const chatId = settings.telegramChatId;

  return executeWithingsSync(
    withingsClientId,
    withingsClientSecret,
    async (token, sinceMs) => {
      let total = 0;
      let newCount = 0;

      // Measures
      const measures = await fetchMeasures(token, sinceMs).catch(() => []);
      for (const m of measures) {
        total++;
        const dateStr = m.date.toISOString().slice(0, 10);
        if (m.weight_kg != null && !(await hasEntryForDate('weight', dateStr))) {
          await appendEntryWithTimestamp(m.date, { type: 'weight', value: m.weight_kg, unit: 'kg', source: 'withings' });
          newCount++;
        }
        if (m.fat_ratio_pct != null && !(await hasEntryForDate('body_fat', dateStr))) {
          await appendEntryWithTimestamp(m.date, { type: 'body_fat', value: m.fat_ratio_pct, unit: '%', source: 'withings' });
        }
        if (m.hr_bpm != null && !(await hasEntryForDate('heartrate', dateStr))) {
          await appendEntryWithTimestamp(m.date, { type: 'heartrate', hr_avg: m.hr_bpm, source: 'withings' });
        }
      }

      // Sleep
      const sleeps = await fetchSleep(token, sinceMs).catch(() => []);
      for (const s of sleeps) {
        total++;
        const ts = new Date(`${s.date}T03:00:00.000Z`);
        const result = await upsertEntryForDate(s.date, ts, {
          type: 'sleep', value: s.total_h, unit: 'h',
          deep_sleep_h: s.deep_h, rem_sleep_h: s.rem_h, light_sleep_h: s.light_h,
          quality: s.score, source: 'withings',
        });
        if (result === 'inserted') newCount++;
      }

      // Activity
      const activities = await fetchActivity(token, sinceMs).catch(() => []);
      for (const a of activities) {
        total++;
        const ts = new Date(`${a.date}T12:00:00.000Z`);
        if (a.steps > 0 && !(await hasEntryForDate('steps', a.date))) {
          await appendEntryWithTimestamp(ts, {
            type: 'steps', steps: a.steps, distance_m: a.distance_m,
            calories: a.calories, source: 'withings',
          });
          newCount++;
        }
        if (a.hr_avg && !(await hasEntryForDate('heartrate', a.date))) {
          await appendEntryWithTimestamp(ts, { type: 'heartrate', hr_avg: a.hr_avg, hr_min: a.hr_min, hr_max: a.hr_max, source: 'withings' });
        }
      }

      // Workouts
      const workouts = await fetchWorkouts(token, sinceMs).catch(() => []);
      for (const w of workouts) {
        total++;
        if (await hasEntryForDate('activity', w.date)) continue;
        const ts = new Date(`${w.date}T12:00:00.000Z`);
        await appendEntryWithTimestamp(ts, {
          type: 'activity', activity_type: w.activity_type,
          duration_min: w.duration_min, steps: w.steps,
          distance_m: w.distance_m, calories: w.calories,
          hr_avg: w.hr_avg, source: 'withings',
        });
        newCount++;
      }

      return { total, newCount };
    },
    _deps?.sendTelegram,
    chatId,
  );
}

export { getSyncStatus };

// ── Weekly Health Report ───────────────────────────────────────────────────

async function generateWeeklyHealthReport(): Promise<string> {
  const inBerlin = new Date(new Date().toLocaleString('en-US', { timeZone: 'Europe/Berlin' }));
  const kwDate = new Date(inBerlin);
  kwDate.setDate(kwDate.getDate() + 3 - ((kwDate.getDay() + 6) % 7));
  const week1 = new Date(kwDate.getFullYear(), 0, 4);
  const kw = 1 + Math.round(((kwDate.getTime() - week1.getTime()) / 86_400_000 - 3 + ((week1.getDay() + 6) % 7)) / 7);

  const parts: string[] = [`📊 Wöchentlicher Health-Report (KW ${kw})\n`];

  // Weight
  const wt7 = await getWeightTrend(7);
  const wt30 = await getWeightTrend(30);
  parts.push('⚖️ Gewicht:');
  if (wt7) {
    const weekStart = wt7.current - wt7.change;
    const sign7 = wt7.change > 0 ? '+' : '';
    parts.push(`   Aktuell: ${wt7.current} kg  |  Wochenstart: ${weekStart.toFixed(1)} kg  |  Veränderung: ${sign7}${wt7.change} kg`);
  } else {
    parts.push('   Keine Daten diese Woche');
  }
  if (wt30) {
    const arrow30 = wt30.direction === 'up' ? '📈' : wt30.direction === 'down' ? '📉' : '➡️';
    const sign30 = wt30.change > 0 ? '+' : '';
    parts.push(`   30-Tage-Trend: ${arrow30} ${sign30}${wt30.change} kg`);
  }

  parts.push('');

  // Sleep
  const st7 = await getSleepTrend(7);
  parts.push('😴 Schlaf:');
  if (st7) {
    parts.push(`   Durchschnitt: ${st7.avgDuration}h  |  Min: ${st7.minDuration}h  |  Max: ${st7.maxDuration}h`);
    if (st7.avgQuality) parts.push(`   Qualität: Durchschnitt ${st7.avgQuality}%`);
  } else {
    parts.push('   Keine Daten diese Woche');
  }

  parts.push('');

  // Alerts
  const alerts = await checkHealthAlerts();
  if (alerts.length) {
    const alertIcons: Record<string, string> = { critical: '🔴', warning: '⚠️', info: 'ℹ️' };
    parts.push('🚨 Alerts:');
    for (const a of alerts) parts.push(`   ${alertIcons[a.severity] || '•'} ${a.message}`);
  } else {
    parts.push('✅ Alerts: keine aktiven Warnungen');
  }

  return parts.join('\n');
}

// ── Command registration ───────────────────────────────────────────────────

export function registerHealthCommands(api: any): void {

  // ── weight ─────────────────────────────────────────────────────────────
  api.registerCommand({
    name: 'weight',
    acceptsArgs: true,
    description: 'Letztes Gewicht anzeigen oder manuell loggen: /weight [kg]',
    handler: async (ctx: any) => {
      const raw = String(ctx.args || '').trim();

      if (!raw) {
        const le = await lastEntry('weight');
        if (!le) return { text: '⚖️ Noch kein Gewicht gespeichert.\nManuell: /weight 78.5\nOder: /healthsync' };
        return { text: `⚖️ Letztes Gewicht: ${le.value?.toFixed(1)} kg\n🕐 ${le.timestamp.slice(0, 16).replace('T', ' ')}` };
      }

      const kg = parseFloat(raw.replace(',', '.'));
      if (isNaN(kg) || kg < 20 || kg > 300) return { text: '❌ Verwendung: /weight 78.5' };
      const e = await appendEntry({ type: 'weight', value: kg, unit: 'kg' });
      audit.log({ module: 'health', action: 'health.weight_logged', entityType: 'health_entry', entityId: e.id, after: { type: 'weight', source: 'manual' } }).catch(() => {});
      return { text: `⚖️ Gewicht gespeichert: ${kg.toFixed(1)} kg\n🕐 ${e.timestamp.slice(0, 16).replace('T', ' ')}` };
    },
  });

  // ── sleep ──────────────────────────────────────────────────────────────
  api.registerCommand({
    name: 'sleep',
    acceptsArgs: true,
    description: 'Schlaf loggen: /sleep <stunden> [qualität 1-5]',
    handler: async (ctx: any) => {
      const parts = String(ctx.args || '').trim().split(/\s+/);
      const hours = parseFloat(parts[0]?.replace(',', '.') || '');
      if (isNaN(hours) || hours < 0 || hours > 24) {
        return { text: '❌ Verwendung: /sleep 7.5 [4]' };
      }
      const quality = parts[1] ? parseInt(parts[1]) : undefined;
      if (quality !== undefined && (isNaN(quality) || quality < 1 || quality > 5)) {
        return { text: '❌ Qualität muss zwischen 1 und 5 liegen.' };
      }
      const e = await appendEntry({ type: 'sleep', value: hours, unit: 'h', quality });
      audit.log({ module: 'health', action: 'health.sleep_logged', entityType: 'health_entry', entityId: e.id, after: { type: 'sleep', source: 'manual' } }).catch(() => {});
      const qStr = quality !== undefined ? `  |  Qualität: ${quality}/5` : '';
      return { text: `😴 Schlaf gespeichert: ${hours.toFixed(1)} h${qStr}\n🕐 ${e.timestamp.slice(0, 16).replace('T', ' ')}` };
    },
  });

  // ── symptom ────────────────────────────────────────────────────────────
  api.registerCommand({
    name: 'symptom',
    acceptsArgs: true,
    description: 'Symptom loggen: /symptom <text>',
    handler: async (ctx: any) => {
      const text = String(ctx.args || '').trim();
      if (!text) return { text: '❌ Verwendung: /symptom Kopfschmerzen seit heute Mittag' };
      const e = await appendEntry({ type: 'symptom', text });
      audit.log({ module: 'health', action: 'health.symptom_added', entityType: 'health_entry', entityId: e.id, after: { type: 'symptom', source: 'manual' } }).catch(() => {});
      return { text: `🤒 Symptom gespeichert:\n„${text}"\n🕐 ${e.timestamp.slice(0, 16).replace('T', ' ')}` };
    },
  });

  // ── healthlog ──────────────────────────────────────────────────────────
  api.registerCommand({
    name: 'healthlog',
    acceptsArgs: true,
    description: 'Freitext-Gesundheitseintrag: /healthlog <text>',
    handler: async (ctx: any) => {
      const text = String(ctx.args || '').trim();
      if (!text) return { text: '❌ Verwendung: /healthlog Heute Sport gemacht, fühle mich gut.' };
      const e = await appendEntry({ type: 'log', text });
      audit.log({ module: 'health', action: 'health.log_added', entityType: 'health_entry', entityId: e.id, after: { type: 'log', source: 'manual' } }).catch(() => {});
      return { text: `📝 Health-Log gespeichert:\n„${text}"\n🕐 ${e.timestamp.slice(0, 16).replace('T', ' ')}` };
    },
  });

  // ── healthweek ─────────────────────────────────────────────────────────
  api.registerCommand({
    name: 'healthweek',
    description: 'Health-Zusammenfassung letzte 7 Tage',
    handler: async () => {
      const since = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
      const entries = await readEntries(since);
      if (!entries.length) return { text: '📭 Keine Health-Einträge in den letzten 7 Tagen.' };
      return { text: formatSummary(summarize(entries), 'Woche') };
    },
  });

  // ── healthmonth ────────────────────────────────────────────────────────
  api.registerCommand({
    name: 'healthmonth',
    description: 'Health-Zusammenfassung letzter Monat (30 Tage)',
    handler: async () => {
      const since = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
      const entries = await readEntries(since);
      if (!entries.length) return { text: '📭 Keine Health-Einträge in den letzten 30 Tagen.' };
      return { text: formatSummary(summarize(entries), 'Monat') };
    },
  });

  // ── healthtrend ────────────────────────────────────────────────────────
  api.registerCommand({
    name: 'healthtrend',
    acceptsArgs: true,
    description: 'Gewichts- und Schlaftrend: /healthtrend [7|30|90]  (Default: 30)',
    handler: async (ctx: any) => {
      const raw = String(ctx.args || '').trim();
      const days = ([7, 30, 90] as const).includes(Number(raw) as any) ? (Number(raw) as 7 | 30 | 90) : 30;

      const parts: string[] = [`📊 Health-Trend (${days} Tage)\n`];

      const wt = await getWeightTrend(days);
      if (wt) {
        const arrow = wt.direction === 'up' ? '📈' : wt.direction === 'down' ? '📉' : '➡️';
        const sign = wt.change > 0 ? '+' : '';
        parts.push(`⚖️ Gewicht:`);
        parts.push(`   Aktuell: ${wt.current} kg  ${arrow} ${sign}${wt.change} kg`);
        parts.push(`   Min: ${wt.min} kg  |  Max: ${wt.max} kg  |  Ø ${wt.avg} kg`);
        parts.push(`   Datenpunkte: ${wt.dataPoints}`);
      } else {
        parts.push('⚖️ Gewicht: keine Daten');
      }

      parts.push('');

      const st = await getSleepTrend(days);
      if (st) {
        parts.push('😴 Schlaf:');
        parts.push(`   Ø ${st.avgDuration} h  |  Min: ${st.minDuration} h  |  Max: ${st.maxDuration} h`);
        if (st.avgQuality) parts.push(`   Qualität: Ø ${st.avgQuality}%`);
        parts.push(`   Datenpunkte: ${st.dataPoints}`);
      } else {
        parts.push('😴 Schlaf: keine Daten');
      }

      return { text: parts.join('\n') };
    },
  });

  // ── healthalerts ───────────────────────────────────────────────────────
  api.registerCommand({
    name: 'healthalerts',
    description: 'Aktive Health-Alerts anzeigen',
    handler: async () => {
      const alerts = await checkHealthAlerts();
      if (!alerts.length) return { text: '✅ Keine aktiven Health-Alerts.' };

      const icons: Record<string, string> = { critical: '🔴', warning: '⚠️', info: 'ℹ️' };
      const lines = alerts.map(a => `${icons[a.severity] || '•'} ${a.message}`);
      return { text: `🚨 Health-Alerts (${alerts.length}):\n\n${lines.join('\n')}` };
    },
  });

  // ── withingsauth ───────────────────────────────────────────────────────
  api.registerCommand({
    name: 'withingsauth',
    description: 'Withings OAuth2 starten (temporärer Callback-Server): /withingsauth',
    handler: async () => {
      if (!withingsClientId || !withingsClientSecret) {
        return { text: '❌ WITHINGS_CLIENT_ID / WITHINGS_CLIENT_SECRET nicht gesetzt.' };
      }

      if (withingsCallbackServer) {
        try { withingsCallbackServer.close(); } catch {}
        withingsCallbackServer = null;
      }

      const state = Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2);
      const authUrl = buildAuthUrl(withingsClientId, withingsRedirectUri, state);

      const server = http.createServer(async (req: any, res: any) => {
        try {
          const reqUrl = new URL(req.url || '/', `http://localhost:${withingsCallbackPort}`);
          if (reqUrl.pathname !== '/withings/callback') {
            res.writeHead(404); res.end('Not found'); return;
          }

          const code  = reqUrl.searchParams.get('code')  || '';
          const err   = reqUrl.searchParams.get('error') || '';

          if (err) {
            res.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8' });
            res.end(`<html><body><h2>❌ Withings Fehler: ${err}</h2></body></html>`);
            server.close(); withingsCallbackServer = null;
            return;
          }
          if (!code) {
            res.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8' });
            res.end('<html><body><h2>❌ Kein Code empfangen.</h2></body></html>');
            return;
          }

          const tokens = await exchangeCode(withingsClientId, withingsClientSecret, code, withingsRedirectUri);
          api.logger.info(`[withings] OAuth erfolgreich, userid=${tokens.userid}`);

          res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
          res.end(`<html><body style="font-family:sans-serif;padding:2em;text-align:center">
            <h2>✅ Withings erfolgreich verbunden!</h2>
            <p>User-ID: ${tokens.userid}</p>
            <p>Du kannst dieses Fenster schließen und in Telegram <strong>/healthsync</strong> ausführen.</p>
          </body></html>`);

          server.close(); withingsCallbackServer = null;
        } catch (e: any) {
          res.writeHead(500, { 'Content-Type': 'text/html; charset=utf-8' });
          res.end(`<html><body><h2>❌ Fehler: ${e.message}</h2></body></html>`);
          server.close(); withingsCallbackServer = null;
        }
      });

      server.on('error', (e: any) => {
        api.logger.error(`[withings] Callback-Server Fehler: ${e.message}`);
        withingsCallbackServer = null;
      });

      server.listen(withingsCallbackPort, '0.0.0.0', () => {
        api.logger.info(`[withings] Callback-Server gestartet auf Port ${withingsCallbackPort}`);
      });

      withingsCallbackServer = server;

      const timer = setTimeout(() => {
        if (withingsCallbackServer === server) {
          server.close();
          withingsCallbackServer = null;
          api.logger.info('[withings] Callback-Server nach 60s automatisch gestoppt');
        }
      }, 60_000);
      server.on('close', () => clearTimeout(timer));

      const already = (await isAuthorized()) ? ' (bereits verbunden — neu autorisieren)' : '';
      return {
        text:
          `🔐 Withings OAuth2${already}\n\n` +
          `1. Öffne diesen Link im Browser:\n${authUrl}\n\n` +
          `2. Bei Withings anmelden und Zugriff bestätigen.\n\n` +
          `3. Der Browser wird automatisch zu diesem Server weitergeleitet.\n` +
          `   ✅ Seite zeigt Erfolg → direkt /healthsync ausführen.\n\n` +
          `⏱ Callback-Server läuft 60 Sekunden auf Port ${withingsCallbackPort}.`,
      };
    },
  });

  // ── withingstoken ──────────────────────────────────────────────────────
  api.registerCommand({
    name: 'withingstoken',
    acceptsArgs: true,
    description: 'Withings OAuth-Code manuell einlösen: /withingstoken <code oder URL>',
    handler: async (ctx: any) => {
      try {
        const raw = String(ctx.args || '').trim();
        if (!raw) return { text: '❌ Verwendung: /withingstoken <code>\nOder vollständige Redirect-URL einfügen.' };
        if (!withingsClientId || !withingsClientSecret) {
          return { text: '❌ WITHINGS_CLIENT_ID / WITHINGS_CLIENT_SECRET nicht gesetzt.' };
        }

        let code = raw;
        try {
          const parsed = new URL(raw);
          const extracted = parsed.searchParams.get('code');
          if (extracted) code = extracted;
        } catch { /* kein URL → raw ist bereits der Code */ }
        code = code.replace(/['"]/g, '').trim();

        if (!code) return { text: '❌ Kein Code gefunden in der Eingabe.' };

        const tokens = await exchangeCode(withingsClientId, withingsClientSecret, code, withingsRedirectUri);
        api.logger.info(`[withings] OAuth (manuell) erfolgreich, userid=${tokens.userid}`);
        return {
          text:
            `✅ Withings erfolgreich verbunden!\n` +
            `👤 User-ID: ${tokens.userid}\n\n` +
            `Jetzt: /healthsync`,
        };
      } catch (e: any) {
        return { text: `❌ /withingstoken fehlgeschlagen: ${e.message}` };
      }
    },
  });

  // ── healthsync ─────────────────────────────────────────────────────────
  api.registerCommand({
    name: 'healthsync',
    description: 'Withings-Daten importieren: /healthsync [tage]',
    acceptsArgs: true,
    handler: async (ctx: any) => {
      try {
        if (!withingsClientId || !withingsClientSecret) {
          return { text: '❌ WITHINGS_CLIENT_ID / WITHINGS_CLIENT_SECRET nicht gesetzt.' };
        }
        const tokens = await ensureFreshToken(withingsClientId, withingsClientSecret);
        const daysArg = parseInt(String(ctx.args || '').trim()) || 30;
        const days = Math.max(1, Math.min(365, daysArg));
        const sinceMs = tokens.last_sync
          ? tokens.last_sync - 24 * 60 * 60 * 1000  // 1 Tag Überlappung
          : Date.now() - days * 24 * 60 * 60 * 1000;

        const parts: string[] = [`🔄 Withings Sync (seit ${new Date(sinceMs).toISOString().slice(0, 10)})...\n`];
        let totalNew = 0;

        // ── Measures (Gewicht, Körperfett, HR) ──
        try {
          const measures = await fetchMeasures(tokens.access_token, sinceMs);
          let mNew = 0;
          for (const m of measures) {
            const dateStr = m.date.toISOString().slice(0, 10);
            if (m.weight_kg != null && !(await hasEntryForDate('weight', dateStr))) {
              await appendEntryWithTimestamp(m.date, { type: 'weight', value: m.weight_kg, unit: 'kg', source: 'withings' });
              mNew++;
            }
            if (m.fat_ratio_pct != null && !(await hasEntryForDate('body_fat', dateStr))) {
              await appendEntryWithTimestamp(m.date, { type: 'body_fat', value: m.fat_ratio_pct, unit: '%', source: 'withings' });
            }
            if (m.hr_bpm != null && !(await hasEntryForDate('heartrate', dateStr))) {
              await appendEntryWithTimestamp(m.date, { type: 'heartrate', hr_avg: m.hr_bpm, source: 'withings' });
            }
          }
          parts.push(`⚖️ Messungen: ${measures.length} (${mNew} neu)`);
          totalNew += mNew;
        } catch (e: any) { parts.push(`⚖️ Messungen: ❌ ${e.message}`); }

        // ── Schlaf (aggregiert pro Nacht, dedup) ──
        try {
          const sleeps = await fetchSleep(tokens.access_token, sinceMs);
          let sleepNew = 0, sleepUpdated = 0;
          for (const s of sleeps) {
            const ts = new Date(`${s.date}T03:00:00.000Z`);
            const result = await upsertEntryForDate(s.date, ts, {
              type: 'sleep', value: s.total_h, unit: 'h',
              deep_sleep_h: s.deep_h, rem_sleep_h: s.rem_h, light_sleep_h: s.light_h,
              quality: s.score, source: 'withings',
            });
            if (result === 'inserted') sleepNew++;
            else if (result === 'updated') sleepUpdated++;
          }
          const sleepParts = [`${sleeps.length} Nächte`];
          if (sleepNew) sleepParts.push(`${sleepNew} neu`);
          if (sleepUpdated) sleepParts.push(`${sleepUpdated} aktualisiert`);
          parts.push(`😴 Schlaf: ${sleepParts.join(', ')}`);
          totalNew += sleepNew;
        } catch (e: any) { parts.push(`😴 Schlaf: ❌ ${e.message}`); }

        // ── Aktivität (Schritte) ──
        try {
          const activities = await fetchActivity(tokens.access_token, sinceMs);
          let actNew = 0;
          for (const a of activities) {
            const ts = new Date(`${a.date}T12:00:00.000Z`);
            if (a.steps > 0 && !(await hasEntryForDate('steps', a.date))) {
              await appendEntryWithTimestamp(ts, {
                type: 'steps', steps: a.steps, distance_m: a.distance_m,
                calories: a.calories, source: 'withings',
              });
              actNew++;
            }
            if (a.hr_avg && !(await hasEntryForDate('heartrate', a.date))) {
              await appendEntryWithTimestamp(ts, { type: 'heartrate', hr_avg: a.hr_avg, hr_min: a.hr_min, hr_max: a.hr_max, source: 'withings' });
            }
          }
          const totalSteps = activities.reduce((s, a) => s + a.steps, 0);
          parts.push(`👟 Aktivität: ${activities.length} Tage (${actNew} neu), ${totalSteps.toLocaleString('de')} Schritte gesamt`);
          totalNew += actNew;
        } catch (e: any) { parts.push(`👟 Aktivität: ❌ ${e.message}`); }

        // ── Workouts ──
        try {
          const workouts = await fetchWorkouts(tokens.access_token, sinceMs);
          let wNew = 0;
          for (const w of workouts) {
            if (await hasEntryForDate('activity', w.date)) continue;
            const ts = new Date(`${w.date}T12:00:00.000Z`);
            await appendEntryWithTimestamp(ts, {
              type: 'activity', activity_type: w.activity_type,
              duration_min: w.duration_min, steps: w.steps,
              distance_m: w.distance_m, calories: w.calories,
              hr_avg: w.hr_avg, source: 'withings',
            });
            wNew++;
          }
          parts.push(`🏃 Workouts: ${workouts.length} (${wNew} neu)`);
          totalNew += wNew;
        } catch (e: any) { parts.push(`🏃 Workouts: ❌ ${e.message}`); }

        // Update last_sync
        await saveTokens({ ...tokens, last_sync: Date.now() });

        parts.push(`\n✅ ${totalNew} Einträge importiert.`);
        return { text: parts.join('\n') };
      } catch (e: any) {
        return { text: `❌ /healthsync fehlgeschlagen: ${e.message}` };
      }
    },
  });

  // ── healthreportday ────────────────────────────────────────────────────
  api.registerCommand({
    name: 'healthreportday',
    acceptsArgs: true,
    description: 'Wochentag für Health-Report: /healthreportday <Mo|Di|Mi|Do|Fr|Sa|So>',
    handler: async (ctx: any) => {
      const raw = String(ctx.args || '').trim().toLowerCase();
      const dayMap: Record<string, number> = { so: 0, mo: 1, di: 2, mi: 3, do: 4, fr: 5, sa: 6 };
      const dayNum = dayMap[raw];
      if (dayNum === undefined) return { text: '❌ Verwendung: /healthreportday Mo  (Mo|Di|Mi|Do|Fr|Sa|So)' };
      const dayNames = ['Sonntag', 'Montag', 'Dienstag', 'Mittwoch', 'Donnerstag', 'Freitag', 'Samstag'];
      await setSetting('health_report_day', dayNum);
      return { text: `📊 Wöchentlicher Health-Report auf ${dayNames[dayNum]} gesetzt.` };
    },
  });

  // ── Weekly Health Report Timer ─────────────────────────────────────────
  let lastWeeklyReportDate = '';

  setInterval(async () => {
    try {
      if (!_deps) return;
      const s = loadSettings();
      if (!s.telegramChatId) return;

      const inBerlin = new Date(new Date().toLocaleString('en-US', { timeZone: 'Europe/Berlin' }));
      const hh = String(inBerlin.getHours()).padStart(2, '0');
      const mm = String(inBerlin.getMinutes()).padStart(2, '0');
      const nowHHMM = `${hh}:${mm}`;
      const today = berlinDate(0);
      const reportDay = s.healthReportDay ?? 1; // Default: Montag

      if (inBerlin.getDay() === reportDay && nowHHMM === s.briefingTime && lastWeeklyReportDate !== today) {
        const text = await generateWeeklyHealthReport();
        await _deps.sendTelegram(s.telegramChatId, text);
        lastWeeklyReportDate = today;
        api.logger.info(`[executive-agent] Wöchentlicher Health-Report gesendet (${today})`);
      }
    } catch (e: any) {
      api.logger.error(`[executive-agent] Weekly Health-Report Fehler: ${e.message}`);
    }
  }, 60_000);
}
