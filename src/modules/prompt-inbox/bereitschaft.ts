/**
 * prompt-inbox/bereitschaft — Ist Claude Code aufnahmebereit?
 *
 * HINTERGRUND. Die Prompt-Inbox tippt eine Datei über `tmux send-keys` in das
 * Pane, in dem Claude Code läuft — bisher ohne zu prüfen, was dort gerade
 * passiert. Am 10./11.10.2026 sind acht Aufträge mitten in einen laufenden
 * Durchgang getippt worden.
 *
 * WAS DABEI TATSÄCHLICH PASSIERT (nachgemessen am 11.10.2026): Läuft ein
 * Durchgang, nimmt Claude Code den Text als Zwischennachricht auf und arbeitet
 * ihn im selben Durchgang ab. Es geht nichts verloren und nichts wird
 * zusammengeführt. Insofern war die Zustellung nicht kaputt.
 *
 * ZWEI RISIKEN BLEIBEN:
 *
 *   1. Steht ein Dialog offen — eine Freigabefrage oder ein Plan-Gate mit
 *      numerierten Optionen —, ist der getippte Text keine Nachricht, sondern
 *      eine ANTWORT auf den Dialog. Die erste Zeile eines Auftrags würde dann
 *      eine Option auswählen. Das ist der gefährliche Fall: Er wählt etwas aus,
 *      was niemand ausgewählt hat.
 *   2. Zwei Dateien im Abstand von zehn Sekunden erzeugen zwei Einschübe. Ob
 *      sie in der gewünschten Reihenfolge ankommen, ist nicht zugesichert.
 *
 * Deshalb liefert die Inbox ab jetzt nur noch, wenn das Pane aufnahmebereit
 * ist, und höchstens eine Datei pro Lauf. Eine zurückgestellte Datei bleibt
 * liegen und wird beim nächsten Lauf erneut geprüft — zehn Sekunden später.
 *
 * Diese Datei enthält bewusst nur reine Funktionen auf dem Pane-Text: So ist
 * die Erkennung ohne tmux testbar, auch für die Missbrauchsfälle.
 */

/** Wie viele Zeilen vom Ende des Panes betrachtet werden. */
export const ZEILEN_FENSTER = 25;

export type NichtBereitGrund =
  | 'laufender_durchgang'
  | 'dialog_offen'
  | 'pane_leer';

export interface Bereitschaft {
  bereit: boolean;
  grund?: NichtBereitGrund;
  /** Zeile, die zur Entscheidung geführt hat — für das Protokoll. */
  beleg?: string;
}

/**
 * Markierungen eines laufenden Durchgangs in der Statuszeile von Claude Code.
 *
 * `esc to interrupt` steht dort ausschließlich, solange gearbeitet wird — das
 * ist das verlässlichste Signal. Die Laufzeitanzeige in Klammern
 * („(58m 11s · ↓ 224.3k tokens)") erscheint zusammen damit und dient als
 * zweites Merkmal, falls die Statuszeile einmal anders formuliert wird.
 */
const LAEUFT = [
  /esc to interrupt/i,
  /\(\d+m \d+s\b/,
  /\(\d+s\s*·/,
];

/**
 * Ein offener Dialog mit numerierten Optionen.
 *
 * Claude Code zeigt Freigabefragen und Plan-Gates als numerierte Liste, die
 * ausgewählte Zeile mit „❯". Ein getippter Text wäre hier eine Antwort und
 * keine Nachricht.
 *
 * Absichtlich eng gefasst: Eine Zeile wie „1. Zuerst die Migration anwenden"
 * aus einem Auftragstext im Scrollback soll NICHT als Dialog gelten. Deshalb
 * wird zusätzlich ein Auswahlzeiger oder ein typischer Optionstext verlangt.
 */
const DIALOG_ZEILE = /^\s*(?:[❯>]\s*)?\d+\.\s+(?:Yes|No|Ja|Nein|Allow|Deny|Don't|Keep|Accept|Reject|Proceed)/i;
const DIALOG_ZEIGER = /^\s*[❯>]\s*\d+\.\s/;

/**
 * Prüft den Pane-Text und sagt, ob eine Übergabe jetzt sicher ist.
 *
 * Grundsatz: Bei Unklarheit NICHT zustellen. Eine Datei, die zehn Sekunden
 * später zugestellt wird, kostet nichts; eine Datei, die versehentlich eine
 * Dialogoption auswählt, kann Schaden anrichten.
 */
export function pruefeBereitschaft(paneText: string): Bereitschaft {
  const text = (paneText || '').replace(/\r/g, '');
  if (!text.trim()) {
    return { bereit: false, grund: 'pane_leer' };
  }

  const zeilen = text.split('\n');
  const fenster = zeilen.slice(-ZEILEN_FENSTER);

  for (const zeile of fenster) {
    for (const muster of LAEUFT) {
      if (muster.test(zeile)) {
        return { bereit: false, grund: 'laufender_durchgang', beleg: zeile.trim().slice(0, 120) };
      }
    }
  }

  for (const zeile of fenster) {
    if (DIALOG_ZEIGER.test(zeile) || DIALOG_ZEILE.test(zeile)) {
      return { bereit: false, grund: 'dialog_offen', beleg: zeile.trim().slice(0, 120) };
    }
  }

  return { bereit: true };
}

/** Klartext für Protokoll und Telegram. */
export function grundText(grund: NichtBereitGrund | undefined): string {
  switch (grund) {
    case 'laufender_durchgang': return 'Claude Code arbeitet gerade';
    case 'dialog_offen': return 'ein Dialog wartet auf eine Antwort';
    case 'pane_leer': return 'das tmux-Pane ist leer oder nicht erreichbar';
    default: return 'aufnahmebereit';
  }
}

/**
 * Auftragskennung aus einem Dateinamen.
 *
 * Aus `2026-10-10T21-18-20-906Z-dropbox-20261010-231720-paket3c-casameta-hybrid-20261010.txt`
 * wird `paket3c-casameta-hybrid`. Daran hängt die Frage, ob zu einem Auftrag
 * schon ein Report vorliegt: Die Berichte heißen
 * `report-<kennung>-<datum>.md`.
 *
 * Entfernt werden: der Zeitstempel des Pollers, ein `dropbox-`-Vorsatz mit
 * seinem Zeitstempel, die Endung und ein angehängtes Datum.
 */
export function auftragsKennung(dateiname: string): string | null {
  let name = dateiname.replace(/\.txt$/i, '');
  // Zeitstempel des Pollers am Anfang.
  name = name.replace(/^\d{4}-\d{2}-\d{2}T[\d-]+Z-/, '');
  // Herkunftsvorsatz der Dropbox-Inbox samt eigenem Zeitstempel.
  name = name.replace(/^dropbox-\d{8}-\d{6}-/, '');
  name = name.replace(/^dropbox-/, '');
  // Angehängtes Datum.
  name = name.replace(/-\d{8}$/, '');
  name = name.replace(/-\d{4}$/, '');
  name = name.trim().replace(/^-+|-+$/g, '');
  return name.length >= 3 ? name : null;
}

// ── Wartet cc auf eine Armierung? ──────────────────────────────────────────
//
// Ein Stups hilft hier nicht: Solange `/arm` nicht gesetzt ist, kann Claude
// Code den roten Schritt nicht ausführen, und ein „weiter mit …" würde nur
// denselben blockierten Versuch wiederholen. Gebraucht wird der Owner, und
// zwar einmal und sofort.
//
// Erkannt wird das am Protokoll des Deny-Hooks. Er schreibt bei jedem
// blockierten roten Pfad oder Befehl eine Zeile der Form
//
//   <ISO-Zeit> [BLOCK] [bikosoc] not armed (...): red command: <Muster>
//   <ISO-Zeit> [BLOCK] [bikosoc] not armed (...): red path: <Datei> matches <Muster>
//
// Das ist ein Tatsachenbeleg und keine Textdeutung — deshalb hat es Vorrang
// vor dem Durchsuchen von Berichten.

/** Zeitfenster, in dem eine Blockade als „noch aktuell" gilt. */
export const ARM_FENSTER_STUNDEN = 6;

export interface ArmWartung {
  wartet: boolean;
  /** Zeitpunkt der letzten verbrauchten Armierung, als Millisekunden. */
  letzteArmierungMs?: number;
  /** Was blockiert wurde — Pfad oder Befehl, für die Meldung. */
  gegenstand?: string;
  /** Zeitpunkt der Blockade. */
  zeitpunkt?: string;
}

/**
 * Liest das Hook-Protokoll und sagt, ob eine Armierung aussteht.
 *
 * Eine Blockade gilt nur als offen, wenn DANACH keine Armierung mehr
 * verbraucht wurde: Der Hook schreibt beim Einlösen eine `[ARMED]`-Zeile.
 * Ohne diese Prüfung würde eine längst erledigte Blockade weitergemeldet.
 */
export function erkenneArmWartung(hookProtokoll: string, jetzt: Date): ArmWartung {
  const zeilen = (hookProtokoll || '').split('\n').filter(z => z.includes('[bikosoc]'));
  const grenze = jetzt.getTime() - ARM_FENSTER_STUNDEN * 3600000;

  let letzteBlockade: { gegenstand: string; zeit: number; iso: string } | null = null;
  let letzteArmierung = 0;

  for (const zeile of zeilen) {
    const m = zeile.match(/^(\S+)\s+\[(BLOCK|ARMED)\]/);
    if (!m) continue;
    const zeit = new Date(m[1]).getTime();
    if (!Number.isFinite(zeit)) continue;

    if (m[2] === 'ARMED') {
      letzteArmierung = Math.max(letzteArmierung, zeit);
      continue;
    }
    if (!/not armed/.test(zeile)) continue;
    const g = zeile.match(/:\s*(red (?:path|command):.*)$/);
    letzteBlockade = { gegenstand: (g ? g[1] : zeile).trim(), zeit, iso: m[1] };
  }

  if (!letzteBlockade) return { wartet: false, letzteArmierungMs: letzteArmierung };
  if (letzteBlockade.zeit < grenze) return { wartet: false, letzteArmierungMs: letzteArmierung };
  // Nach der Blockade wurde armiert — dann ist sie erledigt.
  if (letzteArmierung > letzteBlockade.zeit) {
    return { wartet: false, letzteArmierungMs: letzteArmierung };
  }

  return {
    wartet: true,
    gegenstand: letzteBlockade.gegenstand,
    zeitpunkt: letzteBlockade.iso,
    letzteArmierungMs: letzteArmierung,
  };
}

/**
 * Meldungstext mit antippbarem Link.
 *
 * `t.me/share/url` öffnet im Telegram-Client ein Eingabefeld mit dem
 * vorbereiteten Text — der Owner muss nur noch den Chat wählen und senden.
 * Ein echter Befehlslink ist in Telegram nicht möglich.
 */
export function armMeldung(w: ArmWartung): string {
  return `cc wartet auf /arm für ${w.gegenstand || 'einen roten Pfad'}`
    + `${w.zeitpunkt ? ` (blockiert ${w.zeitpunkt})` : ''}. `
    + 'Antippen und senden: https://t.me/share/url?url=%2Farm%20push';
}

/* ── Erkennung über Berichtstexte: bewusst NICHT umgesetzt ────────────────
 *
 * Die Owner-Ergänzung vom 11.10.2026 nannte zwei Erkennungswege: das
 * Hook-Protokoll ODER „der letzte Report nennt `wartet auf /arm`". Der zweite
 * ist gebaut, geprüft und wieder entfernt worden.
 *
 * WARUM. In einem Markdown-Bericht ist ein ganzer Absatz EINE Zeile. Jeder
 * Bericht, der die Mechanik erklärt, enthält `/arm` und Wörter wie „wartet
 * auf" mehrfach — und weil Anfang und Ende der Datei getrennt gelesen werden,
 * entstehen zusätzlich abgeschnittene Zeilenfragmente. Drei Fassungen mit
 * immer engeren Mustern schlugen jedes Mal auf einem Prosaabsatz des
 * Teil-Q-Berichts an; die Meldung nannte dann einen Satzfetzen statt einer
 * Aufgabe. Eine Meldung, die alle zehn Sekunden Fehlalarm gibt, ist schlechter
 * als keine — sie wird ignoriert, und dann hilft sie auch im echten Fall nicht.
 *
 * WAS BLEIBT. Das Hook-Protokoll ist ein Tatsachenbeleg: Der Hook schreibt
 * genau dann eine Zeile, wenn ein roter Schritt wirklich blockiert wurde. Das
 * deckt jeden Fall ab, in dem Claude Code den Schritt versucht hat.
 *
 * DIE LÜCKE, die damit offen bleibt: Weiß Claude Code vorher, dass der Schritt
 * blockiert würde, versucht es ihn gar nicht — dann steht nichts im Protokoll.
 * Diese Lücke ließe sich über TATSACHEN schließen statt über Textdeutung:
 * „liegt in den noch nicht gepushten Commits ein roter Pfad?" und „liegt eine
 * Migrationsdatei vor, deren Version nicht in schema_version steht?". Beides
 * ist eindeutig prüfbar. Als Vorschlag im Report, nicht gebaut. */
