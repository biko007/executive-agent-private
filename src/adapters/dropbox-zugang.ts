/**
 * Welcher Dropbox-Zugang gilt — alte App oder neue.
 *
 * Seit dem 16.10.2026 gibt es zwei Wege ins selbe Konto:
 *
 *   NEU  „BikosOpenClawFA", Vollzugriff, mit PKCE geholter Refresh-Token,
 *        OHNE App-Secret. Schluessel: DROPBOX_APP_KEY, DROPBOX_REFRESH_TOKEN.
 *        Die Pfade brauchen das Praefix DROPBOX_BASE, weil der bisherige
 *        App-Ordner im Konto unter /Apps/bikosoc-reports liegt.
 *
 *   ALT  „BikosOpenClaw", nur App-Ordner, mit Secret. Schluessel:
 *        EA_DROPBOX_APP_KEY, EA_DROPBOX_APP_SECRET, EA_DROPBOX_REFRESH_TOKEN.
 *        Pfade bleiben relativ zum App-Ordner, also ohne Praefix.
 *
 * Der neue Zugang hat Vorrang. Die alten Werte bleiben vorerst stehen: Erst
 * nach sieben Tagen fehlerfreiem Betrieb fragt der Agent, ob sie weg duerfen
 * (Owner-Vorgabe 16.10.2026). Bis dahin ist der Rueckweg ein Entfernen der
 * beiden neuen Zeilen aus der Env-Datei — mehr nicht.
 */
import { createDropboxAdapter, DROPBOX_BASE, type DropboxAdapter } from './dropbox.js';

export interface DropboxZugang {
  adapter: DropboxAdapter;
  /** Welche App bedient wird — fuer Protokoll und Report. */
  app: 'BikosOpenClawFA' | 'BikosOpenClaw';
  /** Praefix, das der Adapter vor jeden Pfad setzt. */
  basis: string;
}

/**
 * Ein Zugang auf die **Kontowurzel**, ohne Praefix. Damit sind Ordner
 * ausserhalb des App-Ordners erreichbar, etwa `/Austausch` — der Ordner, in
 * dem der Owner und der Chat arbeiten.
 *
 * Nur die neue App kann das. Die alte sieht ausschliesslich ihren App-Ordner;
 * dort gibt es keinen Vollzugriff und die Funktion liefert `null`.
 */
export interface DropboxVollzugang {
  adapter: DropboxAdapter;
  app: 'BikosOpenClawFA';
}

/** Ein Leser, der einen Umgebungswert liefert — oder nichts. */
export type Umgebung = (schluessel: string) => string | null | undefined;

/**
 * Den gueltigen Zugang bauen. `null`, wenn weder neue noch alte Werte da sind
 * — dann bleibt die Dropbox-Anbindung still, wie bisher.
 */
export function dropboxZugang(hole: Umgebung): DropboxZugang | null {
  const neuKey = (hole('DROPBOX_APP_KEY') || '').trim();
  const neuToken = (hole('DROPBOX_REFRESH_TOKEN') || '').trim();
  if (neuKey && neuToken) {
    return {
      app: 'BikosOpenClawFA',
      basis: DROPBOX_BASE,
      adapter: createDropboxAdapter({
        appKey: neuKey, refreshToken: neuToken, basis: DROPBOX_BASE,
      }),
    };
  }

  const altKey = (hole('EA_DROPBOX_APP_KEY') || '').trim();
  const altSecret = (hole('EA_DROPBOX_APP_SECRET') || '').trim();
  const altToken = (hole('EA_DROPBOX_REFRESH_TOKEN') || '').trim();
  if (altKey && altSecret && altToken) {
    return {
      app: 'BikosOpenClaw',
      basis: '',
      adapter: createDropboxAdapter({
        appKey: altKey, appSecret: altSecret, refreshToken: altToken,
      }),
    };
  }

  return null;
}

/**
 * Den Vollzugriff bauen — gleicher Token, aber ohne Praefix, also auf die
 * Kontowurzel. `null`, wenn nur die alte App-Ordner-Anbindung da ist.
 *
 * Bewusst eine eigene Funktion und nicht ein Schalter an `dropboxZugang`:
 * Wer die Kontowurzel will, soll das in seinem Aufruf sichtbar machen. Der
 * Normalfall bleibt der App-Ordner.
 */
export function dropboxVollzugang(hole: Umgebung): DropboxVollzugang | null {
  const key = (hole('DROPBOX_APP_KEY') || '').trim();
  const token = (hole('DROPBOX_REFRESH_TOKEN') || '').trim();
  if (!key || !token) return null;
  return {
    app: 'BikosOpenClawFA',
    adapter: createDropboxAdapter({ appKey: key, refreshToken: token, basis: '' }),
  };
}
