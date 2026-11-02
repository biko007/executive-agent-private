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
  | 'login_abgelaufen'
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

  /* Abgelaufene Anmeldung und Bestätigungsdialoge zuerst (02.11.2026): In
     diesem Zustand nimmt Claude Code nichts an — getippter Text ginge ins
     Leere oder beantwortete den Dialog. */
  const blockade = erkenneBlockade(text);
  if (blockade) return { bereit: false, grund: blockade.grund, beleg: blockade.beleg };

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
    case 'login_abgelaufen': return 'die Anmeldung von Claude Code ist abgelaufen (/login nötig)';
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
  /* Herkunftsvorsatz des Mail-Eingangskanals (18.10.2026). Ohne diese Zeile
     hiesse die Kennung „auftrag-mail-20261018-1640-testlauf" und der Report
     muesste denselben Vorsatz tragen, damit der Waechter ihn findet. */
  name = name.replace(/^auftrag-mail-\d{8}-\d{4}-/, '');
  // Angehängtes Datum.
  name = name.replace(/-\d{8}$/, '');
  name = name.replace(/-\d{4}$/, '');
  name = name.trim().replace(/^-+|-+$/g, '');
  return name.length >= 3 ? name : null;
}

/**
 * Der Stamm einer Auftragskennung — der Teil, unter dem der Report abgelegt wird.
 *
 * WARUM (11.10.2026): Die Dateien aus der Dropbox-Inbox heißen oft
 * `prompt-<stamm>-<datum>.txt`, der zugehörige Report aber `report-<stamm>-<datum>.md`
 * — ohne das Wort `prompt`. Die Zuordnung verglich `report-prompt-<stamm>-` und fand
 * nie etwas. Zwei am 08.10. erledigte Aufträge (`golink-spacing2`,
 * `cue-agent-label`) galten deshalb am 11.10. als offen und wurden vom
 * Leerlauf-Wächter erneut angestoßen.
 *
 * Abgeschnitten wird genau dieser eine Herkunftsvorsatz. `weiter-`, `paket3-`
 * und dergleichen bleiben stehen: Sie sind Teil des Namens und stehen auch im
 * Report so.
 */
export function auftragsStamm(kennung: string): string {
  return kennung.replace(/^prompt-/, '');
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

/* ── Blockaden und Nachprüfung der Übergabe (02.11.2026) ───────────────────
 *
 * ANLASS: Der Auftrag vom 01.11.2026 21:09 wurde eingetippt, Claude Code
 * antwortete „Login expired" — die Inbox quittierte trotzdem „übergeben" und
 * verschob die Datei. Der Auftrag lag über Nacht unbearbeitet.
 *
 * Bewusst nur die UNTERSTEN Zeilen und nur Zeilen, die wie eine Ausgabe von
 * Claude Code beginnen: Ein Report oder Auftragstext im Scrollback darf
 * „Login expired" zitieren, ohne die Inbox anzuhalten (genau der Auftrag zu
 * dieser Änderung tut das).
 */

/** Wie viele Zeilen (ohne Leerzeilen am Ende) auf Blockaden geprüft werden. */
export const BLOCKADE_FENSTER = 10;

/** Zeilenanfang einer Ausgabe von Claude Code: Einrückung, optional ⎿ oder ●. */
const AUSGABE = '^\\s*(?:[⎿●]\\s*)?';

const LOGIN_MUSTER: RegExp[] = [
  new RegExp(AUSGABE + '(?:API Error:\\s*\\d*\\s*)?Login expired', 'i'),
  new RegExp(AUSGABE + '(?:API Error:.*)?OAuth token (?:has )?expired', 'i'),
  new RegExp(AUSGABE + '(?:API Error:.*)?Invalid API key', 'i'),
  /·\s*Please run \/login/i,
  new RegExp(AUSGABE + 'Please run /login', 'i'),
];

/** Dialoge ohne numerierte Ja/Nein-Optionen, die DIALOG_ZEILE nicht fängt. */
const DIALOG_MUSTER: RegExp[] = [
  /Enter to confirm\s*·\s*Esc to cancel/i,
  new RegExp(AUSGABE + '[│|]?\\s*Teach auto mode', 'i'),
];

export interface Blockade {
  grund: 'login_abgelaufen' | 'dialog_offen';
  beleg: string;
}

export function erkenneBlockade(paneText: string): Blockade | null {
  const zeilen = (paneText || '').replace(/\r/g, '').split('\n');
  // Leere Zeilen am Ende zählen nicht: tmux füllt das Pane bis unten auf.
  while (zeilen.length && !zeilen[zeilen.length - 1].trim()) zeilen.pop();
  const fenster = zeilen.slice(-BLOCKADE_FENSTER);
  /* Nur die LETZTE Login-Meldung zählt, und nur, wenn darunter nichts Neueres
     steht (Review 02.11.2026): Nach erfolgreichem /login kann die alte
     Meldung noch im Fenster stehen — dann hinge die Inbox sonst stumm. */
  let loginIndex = -1;
  fenster.forEach((zeile, i) => { if (LOGIN_MUSTER.some((m) => m.test(zeile))) loginIndex = i; });
  if (loginIndex >= 0) {
    const danach = fenster.slice(loginIndex + 1);
    const neuer = danach.some((z) => /Login successful|Logged in as/i.test(z) || /^\s*●/.test(z));
    if (!neuer) return { grund: 'login_abgelaufen', beleg: fenster[loginIndex].trim().slice(0, 120) };
  }
  for (const zeile of fenster) {
    if (DIALOG_MUSTER.some((m) => m.test(zeile))) {
      return { grund: 'dialog_offen', beleg: zeile.trim().slice(0, 120) };
    }
  }
  return null;
}

export type Annahme =
  | { angenommen: true; hinweis?: string }
  | { angenommen: false; grund: 'login_abgelaufen' | 'kein_fortschritt'; beleg?: string };

/**
 * Hat Claude Code den eingetippten Auftrag angenommen? Verglichen wird das
 * Pane vor dem Eintippen mit dem Pane 10–20 s danach.
 *
 *   Login abgelaufen               → nicht angenommen, mit Grund
 *   Dialog unten                   → ANGENOMMEN (Review 02.11.2026): Vor dem
 *                                    Eintippen war keiner offen, also hat ihn
 *                                    der Auftrag selbst ausgelöst (z. B. eine
 *                                    Freigabefrage). Ein erneutes Eintippen
 *                                    liesse den Auftrag zweimal laufen.
 *   laufender Durchgang            → angenommen
 *   Pane unverändert               → nicht angenommen („kein Fortschritt")
 *   sonst                          → angenommen (kurzer Auftrag schon fertig)
 *
 * Grenze: Bliebe der Text ungesendet in der Eingabezeile stehen, hätte sich
 * das Pane verändert und gälte als angenommen. Die Inbox sendet Enter getrennt
 * und verzögert; beobachtet wurde das bisher nicht.
 */
export function bewerteAnnahme(vorher: string, nachher: string): Annahme {
  const blockade = erkenneBlockade(nachher);
  if (blockade?.grund === 'login_abgelaufen') return { angenommen: false, grund: 'login_abgelaufen', beleg: blockade.beleg };
  if (blockade?.grund === 'dialog_offen') return { angenommen: true, hinweis: `Dialog offen: ${blockade.beleg}` };
  const fenster = (nachher || '').replace(/\r/g, '').split('\n').slice(-ZEILEN_FENSTER);
  if (fenster.some((z) => LAEUFT.some((m) => m.test(z)))) return { angenommen: true };
  const norm = (t: string) => (t || '').replace(/\r/g, '').split('\n').map((z) => z.trimEnd()).join('\n').trim();
  if (norm(vorher) === norm(nachher)) return { angenommen: false, grund: 'kein_fortschritt' };
  return { angenommen: true };
}

export function annahmeText(a: Annahme): string {
  if (a.angenommen) return 'angenommen';
  switch (a.grund) {
    case 'login_abgelaufen': return 'Anmeldung abgelaufen (Login expired, /login nötig)';
    case 'kein_fortschritt': return 'kein Fortschritt im Pane nach dem Eintippen';
  }
}
