/**
 * doc-register/quellen — Dokumentenablagen nur lesend auf Aenderungen abfragen.
 *
 * Owner-Anweisung 27.10.2026, 10:45: OneDrive, Dropbox, SharePoint (und
 * iCloud) stuendlich auf Neuheiten pruefen. Jede Quelle liefert die seit dem
 * letzten Stand geaenderten Dateien und einen neuen Stand:
 *
 *   SharePoint/OneDrive  Graph `…/root/delta` — der Stand ist der deltaLink.
 *   Dropbox              `list_folder` rekursiv — der Stand ist der Cursor.
 *
 * Die Schnittstelle `DokQuelle` kennt nur Lesebefehle (Liste, Inhalt). Graph
 * wird ausschliesslich per GET angesprochen, Dropbox nur ueber
 * `listChanges` und `downloadFile`.
 */

import fs from 'node:fs';
import path from 'node:path';
import type { DropboxAdapter } from '../../adapters/dropbox.js';

export type DokQuellenName = 'sharepoint' | 'onedrive' | 'dropbox' | 'icloud';

export interface DokDatei {
  quelle: DokQuellenName;
  /** Stabile id der Ablage (Graph-Item-id, Dropbox-id). */
  id: string;
  /** Pfad in der Ablage, mit fuehrendem Schraegstrich. */
  pfad: string;
  name: string;
  groesse: number;
  geaendertIso: string;
  /** Inhalts-Hash der Ablage (quickXorHash, content_hash) oder cTag. */
  hash: string;
  /** Laufwerk bei Graph — fuer Inhalt und Pfadaufloesung. */
  laufwerk?: string;
}

export interface DokAenderungen {
  dateien: DokDatei[];
  /** Neuer Stand; erst nach erfolgreicher Verarbeitung speichern. */
  stand: string;
}

export interface DokQuelle {
  name: DokQuellenName;
  /** Aenderungen seit `stand`; ohne Stand die vollstaendige Liste. */
  aenderungen(stand: string | null): Promise<DokAenderungen>;
  /** Inhalt einer Datei (nur fuer die erste Seite eines PDF). */
  inhalt(d: DokDatei): Promise<Buffer>;
  /** Fehlende Pfade nachtragen (Graph-Delta liefert keine). */
  pfadErgaenzen?(dateien: DokDatei[]): Promise<void>;
  /**
   * Owner-Datenklasse privat: Register bleibt lokal, keine CSV nach Dropbox.
   * Ohne Stand wird trotzdem ab 18.10. registriert (der Spiegel erscheint erst,
   * wenn der Owner ihn einrichtet — dann sollen seine Neuheiten nicht fehlen).
   */
  privat?: boolean;
}

// ── Graph (SharePoint, OneDrive) ───────────────────────────────────────────

export type GraphHole = (url: string) => Promise<any>;
export type GraphHoleRoh = (url: string) => Promise<Buffer>;

const GRAPH = 'https://graph.microsoft.com/v1.0';

/** Pfad aus `parentReference.path` („/drive/root:/A/B" oder „/drives/x/root:/A"). */
export function pfadAusReferenz(parentPath: string | undefined, name: string): string {
  const roh = String(parentPath ?? '');
  const i = roh.indexOf('root:');
  const ordner = i >= 0 ? decodeURIComponent(roh.slice(i + 5)) : '';
  return `${ordner.replace(/\/+$/, '')}/${name}`.replace(/^([^/])/, '/$1');
}

/**
 * Ein Graph-Laufwerk ueber die Delta-Abfrage. `basis` ist etwa
 * `/drives/<id>` oder `/users/<upn>/drive`.
 */
export function graphQuelle(
  name: 'sharepoint' | 'onedrive', basis: string, hole: GraphHole, holeRoh: GraphHoleRoh,
): DokQuelle {
  /** Delta liefert keinen Pfad; er wird je Datei einmal nachgeschlagen. */
  async function pfadVon(laufwerk: string, id: string, name: string): Promise<string> {
    try {
      const it = await hole(`${GRAPH}/drives/${laufwerk}/items/${encodeURIComponent(id)}?$select=name,parentReference`);
      return pfadAusReferenz(it?.parentReference?.path, it?.name ?? name);
    } catch { return ''; }
  }
  return {
    name,
    async aenderungen(stand) {
      const anfang = `${GRAPH}${basis}/root/delta`
        + '?$select=id,name,size,lastModifiedDateTime,file,folder,deleted,parentReference,cTag';
      const lies = async (start: string) => {
        let url: string | null = start;
        const roh: any[] = [];
        let neuerStand = '';
        while (url) {
          const seite: any = await hole(url);
          roh.push(...(seite?.value ?? []));
          if (typeof seite?.['@odata.nextLink'] === 'string') url = seite['@odata.nextLink'];
          else { neuerStand = String(seite?.['@odata.deltaLink'] ?? ''); url = null; }
        }
        return { roh, neuerStand };
      };
      let ergebnis;
      try {
        ergebnis = await lies(stand || anfang);
      } catch (e: any) {
        /* 410 resyncRequired: Der Stand ist abgelaufen. Neu von vorn — das
           Register sortiert nach id + Hash aus, was schon gemeldet ist. */
        if (!stand || !/status=410|resync/i.test(String(e?.message ?? e))) throw e;
        ergebnis = await lies(anfang);
      }
      const { roh, neuerStand } = ergebnis;
      const dateien: DokDatei[] = [];
      for (const it of roh) {
        if (!it?.file || it?.deleted) continue;
        dateien.push({
          quelle: name, id: String(it.id), name: String(it.name ?? ''),
          pfad: it?.parentReference?.path ? pfadAusReferenz(it.parentReference.path, it.name) : '',
          groesse: Number(it.size ?? 0), geaendertIso: String(it.lastModifiedDateTime ?? ''),
          hash: String(it.file?.hashes?.quickXorHash ?? it.cTag ?? ''),
          laufwerk: String(it?.parentReference?.driveId ?? ''),
        });
      }
      return { dateien, stand: neuerStand };
    },
    async inhalt(d) {
      return holeRoh(`${GRAPH}/drives/${d.laufwerk}/items/${encodeURIComponent(d.id)}/content`);
    },
    async pfadErgaenzen(dateien) {
      for (const d of dateien) if (!d.pfad && d.laufwerk) d.pfad = await pfadVon(d.laufwerk, d.id, d.name);
    },
  };
}

// ── Dropbox ────────────────────────────────────────────────────────────────

/** Dropbox-Kontowurzel ueber den Cursor von `list_folder`. */
export function dropboxQuelle(adapter: DropboxAdapter): DokQuelle {
  if (!adapter.listChanges) throw new Error('Dropbox-Adapter ohne listChanges');
  return {
    name: 'dropbox',
    async aenderungen(stand) {
      const dateien: DokDatei[] = [];
      let seite = await adapter.listChanges!(stand ? { path: '', cursor: stand } : { path: '' });
      for (let n = 0; ; n++) {
        for (const e of seite.entries) {
          if (e.tag !== 'file') continue;
          dateien.push({
            quelle: 'dropbox', id: e.id, pfad: e.pathDisplay, name: e.name, groesse: e.size,
            geaendertIso: e.serverModified, hash: e.contentHash,
          });
        }
        if (!seite.hasMore || n > 500) break;
        seite = await adapter.listChanges!({ path: '', cursor: seite.cursor });
      }
      return { dateien, stand: seite.cursor };
    },
    inhalt: (d) => adapter.downloadFile(d.pfad),
  };
}

// ── Lokaler Spiegel (iCloud) ───────────────────────────────────────────────
//
// Owner-Entscheidung 27.10.2026, 10:46: Der iMac schiebt iCloud Drive
// stuendlich per rsync nach ~/icloud-spiegel/ (nur Push, kein --delete,
// *.icloud-Platzhalter ausgeschlossen). Der Spiegel ist Owner-Datenklasse
// privat: hier wird nur gelesen — kein Schreiben, Umbenennen, Loeschen.

/** Marker, den der rsync-Lauf mitbringt. */
export const SPIEGEL_MARKER = '.letzter-lauf';
const SPIEGEL_UEBERGEHEN = /^(\.ds_store|\.localized|icon\r)$|\.icloud$/i;

interface SpiegelDatei { rel: string; groesse: number; mtimeMs: number }

function durchlaufe(wurzel: string): SpiegelDatei[] {
  const raus: SpiegelDatei[] = [];
  const geh = (rel: string) => {
    let eintraege: fs.Dirent[];
    try { eintraege = fs.readdirSync(path.join(wurzel, rel), { withFileTypes: true }); } catch { return; }
    for (const e of eintraege) {
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isSymbolicLink()) continue;
      if (e.isDirectory()) { geh(r); continue; }
      if (!e.isFile() || SPIEGEL_UEBERGEHEN.test(e.name) || (!rel && e.name === SPIEGEL_MARKER)) continue;
      try {
        const st = fs.statSync(path.join(wurzel, r));
        raus.push({ rel: r, groesse: st.size, mtimeMs: st.mtimeMs });
      } catch { /* zwischen Liste und stat verschwunden */ }
    }
  };
  geh('');
  return raus;
}

/**
 * Lokales Verzeichnis als Quelle. Es gibt keinen Delta-Dienst; jeder Lauf
 * liest den ganzen Baum, und das Register erkennt Neues ueber id (relativer
 * Pfad) und Hash (Groesse + mtime). rsync -a erhaelt die mtime, alte Dateien
 * fallen deshalb unter die Startgrenze 18.10.2026.
 */
export function verzeichnisQuelle(name: DokQuellenName, wurzel: string): DokQuelle {
  return {
    name,
    privat: true,
    async aenderungen() {
      const dateien: DokDatei[] = durchlaufe(wurzel).map((f) => ({
        quelle: name, id: f.rel, pfad: `/${f.rel}`, name: path.basename(f.rel), groesse: f.groesse,
        geaendertIso: new Date(f.mtimeMs).toISOString(), hash: `${f.groesse}-${Math.round(f.mtimeMs)}`,
      }));
      return { dateien, stand: new Date().toISOString() };
    },
    async inhalt(d) {
      /* Nur innerhalb des Spiegels lesen — ein Pfad mit „..“ kommt nicht hinaus. */
      const ziel = path.resolve(wurzel, `.${d.pfad}`);
      if (!ziel.startsWith(path.resolve(wurzel) + path.sep)) throw new Error('Pfad außerhalb des Spiegels');
      return fs.readFileSync(ziel);
    },
  };
}

export interface SpiegelZustand {
  vorhanden: boolean;
  /** Zeitpunkt des letzten rsync-Laufs (Marker, sonst mtime des Verzeichnisses). */
  letzterIso: string | null;
  quelleZeitpunkt: 'marker' | 'verzeichnis' | null;
  groesseBytes: number;
  dateien: number;
}

export function spiegelZustand(wurzel: string): SpiegelZustand {
  let st: fs.Stats;
  try { st = fs.statSync(wurzel); } catch {
    return { vorhanden: false, letzterIso: null, quelleZeitpunkt: null, groesseBytes: 0, dateien: 0 };
  }
  if (!st.isDirectory()) return { vorhanden: false, letzterIso: null, quelleZeitpunkt: null, groesseBytes: 0, dateien: 0 };
  let letzterIso: string; let quelleZeitpunkt: 'marker' | 'verzeichnis';
  try {
    letzterIso = fs.statSync(path.join(wurzel, SPIEGEL_MARKER)).mtime.toISOString();
    quelleZeitpunkt = 'marker';
  } catch {
    letzterIso = st.mtime.toISOString();
    quelleZeitpunkt = 'verzeichnis';
  }
  const alle = durchlaufe(wurzel);
  return {
    vorhanden: true, letzterIso, quelleZeitpunkt,
    groesseBytes: alle.reduce((a, f) => a + f.groesse, 0), dateien: alle.length,
  };
}
