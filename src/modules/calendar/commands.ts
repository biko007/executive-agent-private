/**
 * calendar/commands — Telegram command handlers for Calendar module.
 * Commands: /calendar, /meet, /meetf, /free
 */
import { graphGet, graphPost } from '../../shared/m365/index.js';

// ── Dependency Injection ───────────────────────────────────────────────────

export interface CalendarDeps {
  m365Enabled: boolean;
  tenantId: string;
  clientId: string;
  m365Secret: string;
  m365User: string;
}

let deps: CalendarDeps;

export function initCalendarCommands(d: CalendarDeps): void {
  deps = d;
}

function ensureM365() {
  if (!deps.m365Enabled) throw new Error('m365_disabled');
  if (!deps.tenantId || !deps.clientId || !deps.m365User) throw new Error('m365_not_configured');
  if (!deps.m365Secret) throw new Error('m365_secret_missing');
}

// ── Timezone Helpers ─────────────────────────────────────────────────────

/**
 * Format a Date as Berlin-local ISO string WITHOUT timezone suffix.
 * M365 Graph API interprets dateTime in the specified timeZone field,
 * so we must provide Berlin-local values — NOT UTC via toISOString().
 */
function toBerlinLocalIso(d: Date): string {
  const p = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Europe/Berlin',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
    hour12: false,
  }).formatToParts(d);
  const get = (t: string) => p.find(x => x.type === t)?.value || '00';
  return `${get('year')}-${get('month')}-${get('day')}T${get('hour')}:${get('minute')}:${get('second')}.000`;
}

// ── Internal Helpers ──────────────────────────────────────────────────────

async function listConflicts(startIso: string, endIso: string): Promise<any[]> {
  let url =
    `https://graph.microsoft.com/v1.0/users/${encodeURIComponent(deps.m365User)}` +
    `/calendarView?startDateTime=${encodeURIComponent(startIso)}` +
    `&endDateTime=${encodeURIComponent(endIso)}` +
    `&$select=subject,start,end`;

  const conflicts: any[] = [];
  for (let i = 0; i < 10; i++) {
    const json = await graphGet(deps.tenantId, deps.clientId, deps.m365Secret, url);
    if (Array.isArray(json?.value)) conflicts.push(...json.value);
    const next = json?.['@odata.nextLink'];
    if (!next) break;
    url = next;
  }
  return conflicts;
}

function parseMeetArgs(inputRaw: string): {
  dateStr: string;
  timeStr: string;
  durationMin: number;
  title: string;
} | null {
  const input = String(inputRaw || '').trim();
  if (!input) return null;

  const parts = input.split(/\s+/);
  if (parts.length < 2) return null;

  function fmtDDMM(d: Date) {
    const dd = String(d.getDate()).padStart(2, '0');
    const mm = String(d.getMonth() + 1).padStart(2, '0');
    return `${dd}.${mm}`;
  }

  function nextWeekday(target: number) {
    const now = new Date();
    const d = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const cur = d.getDay();
    let delta = (target - cur + 7) % 7;
    if (delta === 0) delta = 7;
    d.setDate(d.getDate() + delta);
    return d;
  }

  function parseDuration(token?: string): number | null {
    if (!token) return null;
    const t = token.toLowerCase();
    if (/^\d+(min|m)$/.test(t)) {
      const n = Number(t.replace(/(min|m)$/, ''));
      return Number.isFinite(n) && n > 0 ? n : null;
    }
    if (/^\d+(\.\d+)?h$/.test(t)) {
      const h = Number(t.replace(/h$/, ''));
      return Number.isFinite(h) && h > 0 ? Math.round(h * 60) : null;
    }
    if (/^\d+$/.test(t)) {
      const n = Number(t);
      return Number.isFinite(n) && n > 0 ? n : null;
    }
    return null;
  }

  const dateTok = parts[0].toLowerCase();
  const timeTok = parts[1];

  let dateStr = '';
  if (/^\d{1,2}\.\d{1,2}$/.test(dateTok)) {
    dateStr = parts[0];
  } else if (dateTok === 'heute') {
    dateStr = fmtDDMM(new Date());
  } else if (dateTok === 'morgen') {
    const d = new Date();
    d.setDate(d.getDate() + 1);
    dateStr = fmtDDMM(d);
  } else {
    const map: Record<string, number> = { so: 0, mo: 1, di: 2, mi: 3, do: 4, fr: 5, sa: 6 };
    if (map[dateTok] !== undefined) {
      dateStr = fmtDDMM(nextWeekday(map[dateTok]));
    } else {
      return null;
    }
  }

  if (!/^\d{1,2}:\d{2}$/.test(timeTok)) return null;
  const timeStr = timeTok;

  const dur = parseDuration(parts[2]);
  const durationMin = dur ?? 60;

  const titleStart = dur ? 3 : 2;
  let title = parts.slice(titleStart).join(' ').trim();
  if (!title) {
    title = `Meeting ${dateStr} ${timeStr}`;
  }

  return { dateStr, timeStr, durationMin, title };
}

function buildStartEnd(dateStr: string, timeStr: string, durationMin: number): { start: Date; end: Date } | null {
  const [day, month] = (dateStr || '').split('.');
  const [hour, minute] = (timeStr || '').split(':');
  if (!day || !month || !hour || !minute) return null;

  const year = new Date().getFullYear();
  const start = new Date(year, Number(month) - 1, Number(day), Number(hour), Number(minute), 0);
  if (isNaN(start.getTime())) return null;

  const end = new Date(start.getTime() + durationMin * 60000);
  return { start, end };
}

async function handleMeet(ctx: any, force: boolean) {
  ensureM365();

  const parsed = parseMeetArgs(ctx.args);
  if (!parsed) {
    return { text: 'Usage: /meet DD.MM HH:MM [durationMin] Title\nForce: /meetf DD.MM HH:MM [durationMin] Title' };
  }

  const { dateStr, timeStr, durationMin, title } = parsed;
  const se = buildStartEnd(dateStr, timeStr, durationMin);
  if (!se) return { text: 'Invalid date/time. Example: /meet 27.02 14:00 60 Strategic Call' };
  const { start, end } = se;

  const startIso = start.toISOString();
  const endIso = end.toISOString();

  // Conflict check (robust): scan wider window and compute overlaps locally
  const scanStartIso = new Date(start.getTime() - 12 * 60 * 60 * 1000).toISOString();
  const scanEndIso   = new Date(end.getTime()   + 12 * 60 * 60 * 1000).toISOString();

  const candidates = await listConflicts(scanStartIso, scanEndIso);

  const startMs = start.getTime();
  const endMs = end.getTime();

  const conflicts = candidates.filter((ev: any) => {
    const s = new Date(ev?.start?.dateTime).getTime();
    const e = new Date(ev?.end?.dateTime).getTime();
    if (!Number.isFinite(s) || !Number.isFinite(e)) return false;
    return s < endMs && e > startMs;
  });

  if (conflicts.length && !force) {
    const tz = 'Europe/Berlin';
    const fmtTime = new Intl.DateTimeFormat('de-DE', { timeZone: tz, hour: '2-digit', minute: '2-digit', hour12: false });

    const bucket = new Map<string, string[]>();
    for (const ev of conflicts) {
      const s = new Date(ev.start.dateTime);
      const e = new Date(ev.end.dateTime);
      const key = `${fmtTime.format(s)}\u2013${fmtTime.format(e)}`;
      const arr = bucket.get(key) || [];
      arr.push(ev.subject || '(ohne Titel)');
      bucket.set(key, arr);
    }

    const lines: string[] = [];
    for (const [range, subs] of Array.from(bucket.entries()).sort((a, b) => a[0].localeCompare(b[0]))) {
      lines.push(`\u2022 ${range}`);
      for (const subj of subs) lines.push(`  - ${subj}`);
    }

    return {
      text:
        '\u26a0\ufe0f Zeitraum ist belegt. Termin NICHT erstellt.\n\n' +
        lines.join('\n') +
        '\n\nErzwingen mit:\n' +
        `/meetf ${dateStr} ${timeStr} ${durationMin} ${title}`,
    };
  }

  // Create
  const payload = {
    subject: title,
    start: { dateTime: startIso, timeZone: 'Europe/Berlin' },
    end: { dateTime: endIso, timeZone: 'Europe/Berlin' },
    isOnlineMeeting: true,
    onlineMeetingProvider: 'teamsForBusiness',
  };

  const url = `https://graph.microsoft.com/v1.0/users/${encodeURIComponent(deps.m365User)}/events`;
  const created = await graphPost(deps.tenantId, deps.clientId, deps.m365Secret, url, payload);

  return {
    text:
      `\ud83d\udcc5 Termin erstellt${conflicts.length ? ' (trotz Konflikt)' : ''}:\n\n` +
      `${dateStr}, ${timeStr} (${durationMin} Min)\n` +
      `${title}\n\n` +
      (created?.webLink ? created.webLink : ''),
  };
}

// ── Direct Calendar Event Creation (for mail-scanner meeting flow) ────────

export async function createCalendarEventDirect(
  title: string,
  startDate: Date,
  endDate: Date,
  meetingLink?: string | null,
): Promise<{ created: boolean; text: string }> {
  ensureM365();

  // Berlin-local for M365 payload (M365 interprets dateTime in the specified timeZone)
  const startLocal = toBerlinLocalIso(startDate);
  const endLocal = toBerlinLocalIso(endDate);

  // UTC for conflict-check scan window (Graph calendarView accepts UTC)
  const scanStartIso = new Date(startDate.getTime() - 12 * 60 * 60 * 1000).toISOString();
  const scanEndIso   = new Date(endDate.getTime()   + 12 * 60 * 60 * 1000).toISOString();
  const candidates = await listConflicts(scanStartIso, scanEndIso);

  const startMs = startDate.getTime();
  const endMs = endDate.getTime();

  const conflicts = candidates.filter((ev: any) => {
    const s = new Date(ev?.start?.dateTime).getTime();
    const e = new Date(ev?.end?.dateTime).getTime();
    if (!Number.isFinite(s) || !Number.isFinite(e)) return false;
    return s < endMs && e > startMs;
  });

  const tz = 'Europe/Berlin';
  const fmtTime = new Intl.DateTimeFormat('de-DE', { timeZone: tz, hour: '2-digit', minute: '2-digit', hour12: false });
  const fmtDate = new Intl.DateTimeFormat('de-DE', {
    timeZone: tz, weekday: 'short', day: '2-digit', month: '2-digit', year: 'numeric',
    hour: '2-digit', minute: '2-digit',
  });

  if (conflicts.length) {
    const bucket = new Map<string, string[]>();
    for (const ev of conflicts) {
      const s = new Date(ev.start.dateTime);
      const e = new Date(ev.end.dateTime);
      const key = `${fmtTime.format(s)}\u2013${fmtTime.format(e)}`;
      const arr = bucket.get(key) || [];
      arr.push(ev.subject || '(ohne Titel)');
      bucket.set(key, arr);
    }

    const lines: string[] = [];
    for (const [range, subs] of Array.from(bucket.entries()).sort((a, b) => a[0].localeCompare(b[0]))) {
      lines.push(`\u2022 ${range}`);
      for (const subj of subs) lines.push(`  - ${subj}`);
    }

    // Build DD.MM date string in Berlin timezone for /meetf hint
    const fmtDayMonth = new Intl.DateTimeFormat('en-CA', {
      timeZone: tz, day: '2-digit', month: '2-digit',
    }).formatToParts(startDate);
    const dd = fmtDayMonth.find(x => x.type === 'day')?.value || '01';
    const mm = fmtDayMonth.find(x => x.type === 'month')?.value || '01';

    return {
      created: false,
      text:
        '\u26a0\ufe0f Zeitraum ist belegt. Termin NICHT erstellt.\n\n' +
        lines.join('\n') +
        `\n\nManuell erzwingen:\n/meetf ${dd}.${mm} ` +
        `${fmtTime.format(startDate)} ${Math.round((endMs - startMs) / 60000)} ${title}`,
    };
  }

  // Create event
  const payload: any = {
    subject: title,
    start: { dateTime: startLocal, timeZone: 'Europe/Berlin' },
    end: { dateTime: endLocal, timeZone: 'Europe/Berlin' },
  };
  if (meetingLink) {
    payload.body = { contentType: 'Text', content: `Meeting-Link: ${meetingLink}` };
  }

  const url = `https://graph.microsoft.com/v1.0/users/${encodeURIComponent(deps.m365User)}/events`;
  const created = await graphPost(deps.tenantId, deps.clientId, deps.m365Secret, url, payload);

  return {
    created: true,
    text:
      `\ud83d\udcc5 Termin erstellt:\n\n` +
      `${fmtDate.format(startDate)}\n` +
      `${title}\n\n` +
      (created?.webLink ? created.webLink : ''),
  };
}

// ── Command Registration ──────────────────────────────────────────────────

export function registerCalendarCommands(api: any): void {
  // /calendar — next 7 days
  api.registerCommand({
    name: 'calendar',
    description: 'M365 Calendar (next 7 days). Usage: /calendar',
    requireAuth: true,
    handler: async () => {
      try {
        ensureM365();

        const start = new Date();
        const end = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);

        const startIso = start.toISOString();
        const endIso = end.toISOString();

        let url =
          `https://graph.microsoft.com/v1.0/users/${encodeURIComponent(deps.m365User)}` +
          `/calendarView?startDateTime=${encodeURIComponent(startIso)}` +
          `&endDateTime=${encodeURIComponent(endIso)}` +
          `&$select=subject,start,end,isAllDay,location,organizer,onlineMeeting` +
          `&$orderby=start/dateTime`;

        const events: any[] = [];
        for (let i = 0; i < 10; i++) {
          const json = await graphGet(deps.tenantId, deps.clientId, deps.m365Secret, url);
          if (json?.value?.length) events.push(...json.value);
          const next = json?.['@odata.nextLink'];
          if (!next) break;
          url = next;
        }

        if (!events.length) return { text: '\ud83d\udcc5 Calendar: keine Termine in den n\u00e4chsten 7 Tagen.' };

        const tz = 'Europe/Berlin';
        const fmtDate = new Intl.DateTimeFormat('de-DE', {
          timeZone: tz,
          weekday: 'long',
          year: 'numeric',
          month: '2-digit',
          day: '2-digit',
        });
        const fmtTime = new Intl.DateTimeFormat('de-DE', {
          timeZone: tz,
          hour: '2-digit',
          minute: '2-digit',
          hour12: false,
        });
        const dayKey = (d: Date) =>
          new Intl.DateTimeFormat('en-CA', {
            timeZone: tz,
            year: 'numeric',
            month: '2-digit',
            day: '2-digit',
          }).format(d);

        // Group by day
        const groups = new Map<string, any[]>();
        for (const ev of events) {
          const sdt = ev?.start?.dateTime;
          if (!sdt) continue;
          const s = new Date(sdt);
          if (isNaN(s.getTime())) continue;
          const k = dayKey(s);
          if (!groups.has(k)) groups.set(k, []);
          groups.get(k)!.push(ev);
        }

        const days = Array.from(groups.keys()).sort();
        const out: string[] = [];

        for (const k of days) {
          const dayEvents = groups.get(k)!;
          dayEvents.sort((a, b) =>
            String(a?.start?.dateTime).localeCompare(String(b?.start?.dateTime))
          );

          const dayDate = new Date(dayEvents[0].start.dateTime);

          out.push(
            `\ud83d\uddd3\ufe0f ${fmtDate.format(dayDate)}`
          );

          for (const ev of dayEvents) {
            const subj = ev?.subject || '(ohne Titel)';
            const s = new Date(ev.start.dateTime);
            const e = new Date(ev.end.dateTime);
            const time = `${fmtTime.format(s)}\u2013${fmtTime.format(e)}`;

            const loc = ev?.location?.displayName
              ? ` | ${ev.location.displayName}`
              : '';

            out.push(`\u2022 ${time}  ${subj}${loc}`);
          }

          out.push('');
        }

        return { text: out.join('\n').trim() };
      } catch (e: any) {
        return { text: `\u274c /calendar failed: ${e.message}` };
      }
    },
  });

  // /meet — create meeting with conflict check
  api.registerCommand({
    name: 'meet',
    description: 'Create meeting (blocks on conflicts). Usage: /meet DD.MM HH:MM [durationMin] Title',
    acceptsArgs: true,
    requireAuth: true,
    handler: async (ctx: any) => {
      try { return await handleMeet(ctx, false); }
      catch (e: any) { return { text: `\u274c /meet failed: ${e.message}` }; }
    },
  });

  // /meetf — force create meeting (ignore conflicts)
  api.registerCommand({
    name: 'meetf',
    description: 'Force create meeting (ignores conflicts). Usage: /meetf DD.MM HH:MM [durationMin] Title',
    acceptsArgs: true,
    requireAuth: true,
    handler: async (ctx: any) => {
      try { return await handleMeet(ctx, true); }
      catch (e: any) { return { text: `\u274c /meetf failed: ${e.message}` }; }
    },
  });

  // /free — check availability
  api.registerCommand({
    name: 'free',
    description: 'Check availability. Usage: /free DD.MM HH:MM-HH:MM',
    acceptsArgs: true,
    requireAuth: true,
    handler: async (ctx: any) => {
      try {
        ensureM365();

        const input = String(ctx.args || '').trim();
        const [dateStr, range] = input.split(/\s+/);
        if (!dateStr || !range || !range.includes('-')) {
          return { text: 'Usage: /free 26.02 14:00-18:00' };
        }

        const [day, month] = dateStr.split('.');
        const [startStr, endStr] = range.split('-');
        const [sh, sm] = startStr.split(':');
        const [eh, em] = endStr.split(':');

        const year = new Date().getFullYear();
        const start = new Date(year, Number(month) - 1, Number(day), Number(sh), Number(sm), 0);
        const end = new Date(year, Number(month) - 1, Number(day), Number(eh), Number(em), 0);

        if (isNaN(start.getTime()) || isNaN(end.getTime()) || end <= start) {
          return { text: 'Invalid time range. Example: /free 26.02 14:00-18:00' };
        }

        const events = await listConflicts(start.toISOString(), end.toISOString());

        if (!events.length) {
          return { text: `\ud83d\udfe2 Frei am ${dateStr} zwischen ${startStr}-${endStr}.` };
        }

        // Build busy intervals
        const busyIntervals = events
          .map((ev: any) => ({
            s: new Date(ev.start.dateTime).getTime(),
            e: new Date(ev.end.dateTime).getTime(),
            subject: ev.subject || '(ohne Titel)',
          }))
          .filter(x => Number.isFinite(x.s) && Number.isFinite(x.e))
          .sort((a, b) => a.s - b.s);

        // Merge to compute free slots
        const free: Array<{ s: number; e: number }> = [];
        let cursor = start.getTime();

        const tz = 'Europe/Berlin';
        const fmtTime = new Intl.DateTimeFormat('de-DE', { timeZone: tz, hour: '2-digit', minute: '2-digit', hour12: false });

        for (const b of busyIntervals) {
          const bs = Math.max(b.s, start.getTime());
          const be = Math.min(b.e, end.getTime());
          if (be <= cursor) continue;

          if (bs > cursor) free.push({ s: cursor, e: bs });
          cursor = Math.max(cursor, be);
        }
        if (cursor < end.getTime()) free.push({ s: cursor, e: end.getTime() });

        const freeLines = free.length
          ? free.map(x => `\u2022 ${fmtTime.format(new Date(x.s))}\u2013${fmtTime.format(new Date(x.e))}`).join('\n')
          : '\u2022 (kein freies Zeitfenster)';

        // Group busy by identical time range
        const bucket = new Map<string, string[]>();
        for (const ev of events) {
          const s = new Date(ev.start.dateTime);
          const e = new Date(ev.end.dateTime);
          const key = `${fmtTime.format(s)}\u2013${fmtTime.format(e)}`;
          const arr = bucket.get(key) || [];
          arr.push(ev.subject || '(ohne Titel)');
          bucket.set(key, arr);
        }

        const busyLines: string[] = [];
        for (const [range2, subs] of Array.from(bucket.entries()).sort((a, b) => a[0].localeCompare(b[0]))) {
          busyLines.push(`\u2022 ${range2}`);
          for (const subj of subs) busyLines.push(`  - ${subj}`);
        }

        return {
          text:
            `\ud83d\udfe2 Frei am ${dateStr} zwischen ${startStr}-${endStr}:\n\n` +
            `${freeLines}\n\n` +
            `\ud83d\udd12 Belegt:\n\n` +
            busyLines.join('\n'),
        };
      } catch (e: any) {
        return { text: `\u274c /free failed: ${e.message}` };
      }
    },
  });
}
