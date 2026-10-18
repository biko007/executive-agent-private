/**
 * mail-register/graph — die Postfachseite der Sammelstelle ueber Microsoft Graph.
 *
 * Berechtigung: Die bikosoc-App-Registrierung arbeitet mit
 * **Anwendungsberechtigungen** (client_credentials, `idtyp: app`) und traegt
 * die Rollen `Mail.Read` und `Mail.ReadWrite`. Damit ist jedes Postfach des
 * Mandanten lesbar, auch ein Shared Mailbox ohne eigene Anmeldung. Am
 * 18.10.2026 geprueft: `/users/data@bikolino.com/mailFolders` antwortet.
 *
 * Nicht vorhanden ist `User.Read.All` — die Verzeichnisabfrage
 * `/users/data@bikolino.com` (Profil) scheitert deshalb mit 403. Fuer das
 * Register ist sie nicht noetig; die Postfachpfade arbeiten ohne sie.
 */

import { graphGet, graphPost } from '../../shared/m365/index.js';
import type { MailboxZugang, RohMail } from './types.js';

export interface MailboxZugangsdaten {
  tenantId: string;
  clientId: string;
  clientSecret: string;
  /** Postfach, etwa `data@bikolino.com`. */
  postfach: string;
}

/** Kopfzeilen in ein Verzeichnis mit Kleinschreibung als Schluessel. */
export function kopfVerzeichnis(roh: unknown): Record<string, string> {
  const raus: Record<string, string> = {};
  for (const z of (roh as Array<{ name?: string; value?: string }> | undefined) ?? []) {
    const name = String(z?.name ?? '').toLowerCase();
    if (!name) continue;
    /* Mehrfach vorkommende Kopfzeilen (Received) sammeln sich mit Zeilenumbruch,
       damit keine verloren geht. */
    raus[name] = raus[name] ? `${raus[name]}\n${String(z?.value ?? '')}` : String(z?.value ?? '');
  }
  return raus;
}

export function erstelleMailboxZugang(z: MailboxZugangsdaten): MailboxZugang {
  const basis = `https://graph.microsoft.com/v1.0/users/${encodeURIComponent(z.postfach)}`;
  const hole = (pfad: string) => graphGet(z.tenantId, z.clientId, z.clientSecret,
    pfad.startsWith('http') ? pfad : `${basis}${pfad}`);

  /** Ordnername → id, fuer das Verschieben. */
  const ordnerIds = new Map<string, string>();

  async function ordnerAnlegen(name: string): Promise<string | null> {
    try {
      const neu = await graphPost(z.tenantId, z.clientId, z.clientSecret,
        `${basis}/mailFolders`, { displayName: name });
      if (neu?.id) { ordnerIds.set(name.toLowerCase(), String(neu.id)); return String(neu.id); }
    } catch { /* kein Schreibrecht oder Name belegt */ }
    return null;
  }

  return {
    async ordner() {
      const raus: Array<{ id: string; name: string; anzahl: number }> = [];
      let pfad: string | null = '/mailFolders?$select=id,displayName,totalItemCount'
        + '&$top=100&$expand=childFolders($select=id,displayName,totalItemCount)';
      while (pfad) {
        const seite: any = await hole(pfad);
        for (const o of seite?.value ?? []) {
          const name = String(o.displayName ?? '');
          ordnerIds.set(name.toLowerCase(), String(o.id));
          raus.push({ id: String(o.id), name, anzahl: Number(o.totalItemCount ?? 0) });
          for (const k of o.childFolders ?? []) {
            const kname = `${name}/${k.displayName}`;
            ordnerIds.set(String(k.displayName ?? '').toLowerCase(), String(k.id));
            raus.push({ id: String(k.id), name: kname, anzahl: Number(k.totalItemCount ?? 0) });
          }
        }
        pfad = typeof seite?.['@odata.nextLink'] === 'string' ? seite['@odata.nextLink'] : null;
      }
      return raus;
    },

    async mails(ordnerId: string, seitIso?: string) {
      /* 25 je Seite: Mit Kopfzeilen liefert Graph grosse Antworten, und die
         Kopfzeilen sind der Grund fuer diesen Aufruf — sie belegen die
         Herkunft. */
      const raus: RohMail[] = [];
      let pfad: string | null = `/mailFolders/${encodeURIComponent(ordnerId)}/messages`
        + `?$top=25&$select=id,internetMessageId,receivedDateTime,from,subject,`
        + `hasAttachments,internetMessageHeaders`
        + `&$orderby=receivedDateTime desc`
        + (seitIso ? `&$filter=receivedDateTime ge ${seitIso}` : '');
      while (pfad) {
        const seite: any = await hole(pfad);
        for (const m of seite?.value ?? []) {
          raus.push({
            id: String(m.id),
            messageId: String(m.internetMessageId ?? m.id),
            empfangenIso: String(m.receivedDateTime ?? new Date().toISOString()),
            absender: String(m?.from?.emailAddress?.address ?? ''),
            absenderName: String(m?.from?.emailAddress?.name ?? ''),
            betreff: String(m?.subject ?? ''),
            hatAnhaenge: Boolean(m?.hasAttachments),
            kopf: kopfVerzeichnis(m?.internetMessageHeaders),
          });
        }
        pfad = typeof seite?.['@odata.nextLink'] === 'string' ? seite['@odata.nextLink'] : null;
      }
      return raus;
    },

    async anhangsnamen(id: string) {
      const daten = await hole(`/messages/${encodeURIComponent(id)}/attachments?$select=name,size`);
      return (daten?.value ?? []).map((a: any) => String(a.name ?? 'anhang'));
    },

    async verschiebe(id: string, ordnerName: string) {
      let ziel = ordnerIds.get(ordnerName.toLowerCase());
      if (!ziel) ziel = (await ordnerAnlegen(ordnerName)) ?? undefined;
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
