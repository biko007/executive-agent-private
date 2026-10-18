/**
 * mail-eingang/graph — die Postfachseite des Eingangskanals ueber Microsoft Graph.
 *
 * Getrennt von `index.ts`, damit die Entscheidungslogik ohne Netz pruefbar
 * bleibt. Hier steht nur, wie gelesen, geholt und einsortiert wird.
 *
 * Berechtigungen: Lesen braucht `Mail.Read`, das Einsortieren
 * `Mail.ReadWrite`. Fehlt das Schreibrecht, meldet `einsortieren`
 * `nicht_moeglich` — nachbeantragt wird nichts (Owner-Vorgabe 18.10.2026).
 */

import { graphGet, graphPost } from '../../shared/m365/index.js';
import type { EingangsAnhang, EingangsMail, PostfachZugang } from './types.js';

/** Name des Zielordners unter dem Posteingang. */
export const ZIELORDNER = 'bikosoc';

export interface GraphZugangsdaten {
  tenantId: string;
  clientId: string;
  clientSecret: string;
  user: string;
}

/** HTML zu lesbarem Text — knapp gehalten, der Mailtext soll 1:1 erkennbar bleiben. */
export function textAusKoerper(inhalt: string, art: string): string {
  if ((art || '').toLowerCase() === 'text') return String(inhalt ?? '').trim();
  return String(inhalt ?? '')
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/?(p|div|tr|li|h[1-6])[^>]*>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/gi, ' ').replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<').replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"').replace(/&#39;/gi, "'")
    .replace(/&euro;/gi, '€')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function adressen(liste: any[]): string[] {
  return (liste ?? [])
    .map((e: any) => String(e?.emailAddress?.address ?? '').trim())
    .filter(Boolean);
}

export function erstelleGraphZugang(z: GraphZugangsdaten): PostfachZugang {
  const nutzer = encodeURIComponent(z.user);
  const basis = `https://graph.microsoft.com/v1.0/users/${nutzer}`;
  const hole = (pfad: string) => graphGet(z.tenantId, z.clientId, z.clientSecret, `${basis}${pfad}`);

  /** id des Zielordners; wird bei Bedarf angelegt. null = nicht moeglich. */
  let zielordnerId: string | null | undefined;

  async function ordnerId(): Promise<string | null> {
    if (zielordnerId !== undefined) return zielordnerId;
    try {
      const vorhanden = await hole(
        `/mailFolders/Inbox/childFolders?$select=id,displayName&$top=50`);
      const treffer = (vorhanden?.value ?? []).find(
        (o: any) => String(o?.displayName ?? '').toLowerCase() === ZIELORDNER);
      if (treffer?.id) { zielordnerId = String(treffer.id); return zielordnerId; }
      const neu = await graphPost(
        z.tenantId, z.clientId, z.clientSecret,
        `${basis}/mailFolders/Inbox/childFolders`, { displayName: ZIELORDNER });
      zielordnerId = neu?.id ? String(neu.id) : null;
    } catch {
      // Kein Schreibrecht oder Ordner nicht anlegbar — einmal merken, nicht erneut versuchen.
      zielordnerId = null;
    }
    return zielordnerId;
  }

  return {
    async neueMails(seitIso: string): Promise<EingangsMail[]> {
      /* Seitenweise lesen: Ein erster Lauf mit grossem Rueckblick kann mehr
         als eine Seite ergeben. Mehr als MAX_MAILS holt das Modul nicht — der
         Eingangskanal ist dann ohnehin ein Fall fuer die Hand. */
      const MAX_MAILS = 300;
      const roh: any[] = [];
      let pfad: string | null = `/mailFolders/Inbox/messages?$top=50`
        + `&$select=id,internetMessageId,receivedDateTime,from,toRecipients,`
        + `ccRecipients,subject,hasAttachments,body`
        + `&$filter=receivedDateTime ge ${seitIso}`
        + `&$orderby=receivedDateTime desc`;
      while (pfad && roh.length < MAX_MAILS) {
        const seite: any = pfad.startsWith('http')
          ? await graphGet(z.tenantId, z.clientId, z.clientSecret, pfad)
          : await hole(pfad);
        roh.push(...(seite?.value ?? []));
        pfad = typeof seite?.['@odata.nextLink'] === 'string' ? seite['@odata.nextLink'] : null;
      }
      return roh.slice(0, MAX_MAILS).map((m: any): EingangsMail => ({
        id: String(m.id),
        messageId: String(m.internetMessageId ?? m.id),
        empfangenIso: String(m.receivedDateTime ?? new Date().toISOString()),
        absender: String(m?.from?.emailAddress?.address ?? ''),
        to: adressen(m?.toRecipients),
        cc: adressen(m?.ccRecipients),
        betreff: String(m?.subject ?? ''),
        text: textAusKoerper(m?.body?.content ?? '', m?.body?.contentType ?? 'html'),
        hatAnhaenge: Boolean(m?.hasAttachments),
      }));
    },

    async mime(id: string): Promise<string> {
      const roh = await hole(`/messages/${encodeURIComponent(id)}/$value`);
      return typeof roh === 'string' ? roh : JSON.stringify(roh ?? '');
    },

    async anhaenge(id: string): Promise<EingangsAnhang[]> {
      const daten = await hole(`/messages/${encodeURIComponent(id)}/attachments`);
      const raus: EingangsAnhang[] = [];
      for (const a of daten?.value ?? []) {
        // Nur echte Dateianhaenge; eingebettete Nachrichten und Verweise nicht.
        if (String(a?.['@odata.type'] ?? '') !== '#microsoft.graph.fileAttachment') continue;
        if (!a?.contentBytes) continue;
        raus.push({
          name: String(a.name ?? 'anhang'),
          bytes: Buffer.from(String(a.contentBytes), 'base64'),
          contentType: a.contentType ? String(a.contentType) : undefined,
        });
      }
      return raus;
    },

    async einsortieren(id: string): Promise<'verschoben' | 'nicht_moeglich'> {
      const ziel = await ordnerId();
      if (!ziel) return 'nicht_moeglich';
      try {
        await graphPost(z.tenantId, z.clientId, z.clientSecret,
          `${basis}/messages/${encodeURIComponent(id)}/move`, { destinationId: ziel });
        return 'verschoben';
      } catch {
        return 'nicht_moeglich';
      }
    },
  };
}
