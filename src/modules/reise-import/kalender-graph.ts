/**
 * reise-import/kalender-graph — `KalenderApi` über Microsoft Graph
 * (Kalender juergen.bickel@, Owner-Freigabe Schreibweg 07.11.2026, Vorschlag 4c).
 *
 * Zeiten kommen ohne Prefer-Kopf zurück, also in UTC.
 */
import { graphRequest } from '../../shared/m365/index.js';
import type { KalenderApi } from './kalender.js';

export interface GraphZugang { tenantId: string; clientId: string; secret: string; user: string }

export function graphKalenderApi(z: GraphZugang): KalenderApi {
  const basis = `https://graph.microsoft.com/v1.0/users/${encodeURIComponent(z.user)}`;
  const req = (m: 'GET' | 'POST' | 'PATCH' | 'DELETE', url: string, body?: unknown) =>
    graphRequest(z.tenantId, z.clientId, z.secret, m, url, body);
  const kurz = (e: any) => ({
    id: String(e.id), text: String(e.body?.content ?? ''), betreff: e.subject,
    startUtc: e.start?.dateTime ? `${String(e.start.dateTime).slice(0, 19)}Z` : undefined,
    endeUtc: e.end?.dateTime ? `${String(e.end.dateTime).slice(0, 19)}Z` : undefined,
    ganztags: !!e.isAllDay,
  });
  const auswahl = '$select=id,subject,body,start,end,isAllDay,location';
  return {
    async imZeitraum(von, bis) {
      const raus: ReturnType<typeof kurz>[] = [];
      let url: string | null = `${basis}/calendarView?startDateTime=${encodeURIComponent(von)}&endDateTime=${encodeURIComponent(bis)}&${auswahl}&$top=200`;
      for (let seite = 0; url && seite < 10; seite++) {
        const j: any = await req('GET', url);
        for (const e of j?.value ?? []) raus.push(kurz(e));
        url = j?.['@odata.nextLink'] ?? null;
      }
      return raus;
    },
    async lies(id) {
      try { return kurz(await req('GET', `${basis}/events/${encodeURIComponent(id)}?${auswahl}`)); } catch (e: any) {
        if (/status=404/.test(String(e?.message))) return null;
        throw e;
      }
    },
    async anlegen(p) { return String((await req('POST', `${basis}/events`, p))?.id); },
    async aendern(id, p) { await req('PATCH', `${basis}/events/${encodeURIComponent(id)}`, p); },
    async loeschen(id) { await req('DELETE', `${basis}/events/${encodeURIComponent(id)}`); },
  };
}

/** Zugang aus der Umgebung; null, wenn etwas fehlt. */
export function graphZugangAusEnv(env: Record<string, string | undefined> = process.env): GraphZugang | null {
  const z = { tenantId: env.M365_TENANT_ID ?? '', clientId: env.M365_CLIENT_ID ?? '', secret: env.M365_CLIENT_SECRET ?? '', user: env.M365_USER ?? '' };
  return z.tenantId && z.clientId && z.secret && z.user ? z : null;
}
