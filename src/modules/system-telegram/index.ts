/**
 * Einheitliche Gestaltung der Systemmeldungen an den Owner.
 *
 * ANLASS (Owner, 14.10.2026): „die Nachrichten sind auch noch recht haesslich".
 * Im Chat standen sichtbare Sternchen, ASCII-Trennlinien aus Bindestrichen,
 * Umschriften wie „naechste" statt „nächste", englische Brocken und roher
 * Technikjargon samt Pfadmustern.
 *
 * REGELN, die dieses Modul durchsetzt:
 *   1. Telegram-HTML (<b>, <i>) statt Markdown. Jeder eingesetzte Wert wird
 *      maskiert — ein Dateiname mit „<" darf die Nachricht nicht zerreissen.
 *   2. Erste Zeile: Symbol und kurzer Titel, fett. Dieselbe Symbolik wie bei
 *      den Report-Meldungen.
 *   3. Deutsch mit echten Umlauten. Keine Umschrift, kein Englisch.
 *   4. Klartext statt Technik: Pfade, Hashes und Glob-Muster nur dann, wenn
 *      der Owner sie zum Handeln braucht. Sonst stehen sie im Log.
 *   5. Wo eine Frist laeuft, steht die Uhrzeit, zu der sie ablaeuft.
 *
 * Die Textbausteine liegen BEWUSST hier und nicht an den Aufrufstellen: Die
 * Hooks sind Shell-Skripte: Dort HTML zu bauen und zu maskieren waere fragil.
 * Sie liefern Symbol, Titel und Zeilen als blanken Text; das Formatieren
 * passiert an dieser einen, geprueften Stelle.
 */

export type SystemLage = 'ok' | 'aktion' | 'hinweis' | 'fehler' | 'wartet' | 'freigabe';

/** Gleiche Symbolik wie die Report-Meldungen, ergaenzt um die Freigabe. */
export const SYSTEM_SYMBOLE: Record<SystemLage, string> = {
  ok: '✅',
  aktion: '👉',
  hinweis: '⚠️',
  fehler: '❌',
  wartet: '⏸',
  freigabe: '🔓',
};

export function systemSymbol(lage: SystemLage): string {
  return SYSTEM_SYMBOLE[lage] ?? SYSTEM_SYMBOLE.hinweis;
}

/** Telegram-HTML vertraegt nur &, < und > maskiert. Mehr nicht — und nicht weniger. */
export function htmlEscape(roh: unknown): string {
  return String(roh ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

export interface SystemMeldung {
  lage: SystemLage;
  /** Kurz, zwei bis vier Woerter. Steht fett in der ersten Zeile. */
  titel: string;
  /** Je ein Gedanke. Werden mit „ · " zu einer zweiten Zeile verbunden. */
  zeilen?: string[];
  /** Zusatzzeilen, die eigenstaendig stehen (etwa die Freigabezeile). */
  fuss?: string[];
}

/**
 * Baut die fertige HTML-Nachricht.
 *
 * Aufbau:
 *   <b>✅ Übertragen</b>
 *   Schutzhook geändert · Freigabe genutzt nach 39 s
 *   🔓 Freigabe aktiv bis 13:59 (einmalig)
 */
export function systemNachricht(m: SystemMeldung): string {
  const zeilen: string[] = [`<b>${systemSymbol(m.lage)} ${htmlEscape(m.titel)}</b>`];
  const punkte = (m.zeilen ?? []).map(z => String(z ?? '').trim()).filter(Boolean);
  if (punkte.length > 0) zeilen.push(punkte.map(htmlEscape).join(' · '));
  for (const f of m.fuss ?? []) {
    const t = String(f ?? '').trim();
    if (t) zeilen.push(htmlEscape(t));
  }
  return zeilen.join('\n');
}

/* ── Uhrzeiten und Fristen ────────────────────────────────────────────────── */

/** Uhrzeit in Europe/Berlin, immer zweistellig. */
export function uhrzeit(zeitpunkt: Date | number): string {
  const d = typeof zeitpunkt === 'number' ? new Date(zeitpunkt) : zeitpunkt;
  return new Intl.DateTimeFormat('de-DE', {
    timeZone: 'Europe/Berlin', hour: '2-digit', minute: '2-digit', hour12: false,
  }).format(d);
}

/**
 * Die Zeile zur laufenden Freigabe.
 *
 * Der Owner soll nicht rechnen muessen. Statt „Freigabe 39s alt" bei einer
 * Grenze von 900 Sekunden steht die Uhrzeit, zu der sie verfaellt.
 */
export function freigabeZeile(ablauf: Date | number): string {
  return `🔓 Freigabe aktiv bis ${uhrzeit(ablauf)} (einmalig)`;
}

/** „nach 39 s" bzw. „nach 3 Min." — fuer die Angabe, wie frisch eine Freigabe war. */
export function alterText(sekunden: number): string {
  const s = Math.max(0, Math.round(Number(sekunden) || 0));
  if (s < 90) return `nach ${s} s`;
  return `nach ${Math.round(s / 60)} Min.`;
}

/* ── Technik zu Klartext ──────────────────────────────────────────────────── */

/**
 * Uebersetzt den Grund, den die Rote Zone meldet, in einen Satz fuer den Owner.
 *
 * Eingabe ist, was im Hook-Protokoll steht, etwa
 *   `red path (Submodul): .openclaw/extensions/executive-agent/hooks/deny-destructive.sh matches hooks/**`
 *   `red command: migrate.*--apply`
 *
 * Ausgabe ist das, was der Owner wissen muss: WAS beruehrt wurde. Das genaue
 * Muster und der Pfad bleiben im Protokoll; sie helfen ihm bei der Entscheidung
 * nicht und verstellen den Blick.
 */
export function roteZoneKlartext(grund: string): string {
  const g = String(grund || '').trim();
  if (!g) return 'roter Pfad berührt';

  const pfadRegeln: Array<[RegExp, string]> = [
    [/hooks\//i, 'Schutzhook geändert'],
    [/settings(\.local)?\.json/i, 'Agenten-Einstellungen geändert'],
    [/migrations\/.*\.sql/i, 'Datenbankstruktur geändert'],
    [/migrate-/i, 'Migrationsskript geändert'],
    [/rollback-/i, 'Rücknahmeskript geändert'],
    [/telegram-binding/i, 'Owner-Zuordnung geändert'],
    [/\.github\/workflows/i, 'Auslieferung geändert'],
    [/(^|\/|\s)\.env|secrets|credentials/i, 'Zugangsdatei berührt'],
  ];
  const befehlRegeln: Array<[RegExp, string]> = [
    [/migrate.*apply/i, 'Datenbank-Migration ausführen'],
    [/psql.*openclaw_core/i, 'Zugriff auf die Produktiv-Datenbank'],
    [/npm\s*\\?s\+?publish|npm publish/i, 'Veröffentlichung im Paketverzeichnis'],
    [/docker.*push/i, 'Container-Auslieferung'],
    [/delete|drop|trunc/i, 'Löschbefehl gegen die Datenbank'],
  ];

  const istSubmodul = /\(Submodul\)/i.test(g);
  if (/^red path/i.test(g)) {
    for (const [muster, text] of pfadRegeln) {
      if (muster.test(g)) return istSubmodul ? `${text} (im Untermodul)` : text;
    }
    return istSubmodul ? 'geschützte Datei geändert (im Untermodul)' : 'geschützte Datei geändert';
  }
  if (/^red command/i.test(g)) {
    for (const [muster, text] of befehlRegeln) {
      if (muster.test(g)) return text;
    }
    return 'geschützter Befehl';
  }
  for (const [muster, text] of [...pfadRegeln, ...befehlRegeln]) {
    if (muster.test(g)) return text;
  }
  return 'roter Pfad berührt';
}

/* ── Fertige Meldungen der Roten Zone ─────────────────────────────────────── */

/** Die Uebertragung lief, die Freigabe wurde dabei verbraucht. */
export function uebertragenMeldung(grund: string, alterSekunden: number): string {
  return systemNachricht({
    lage: 'ok',
    titel: 'Übertragen',
    zeilen: [roteZoneKlartext(grund), `Freigabe genutzt ${alterText(alterSekunden)}`],
  });
}

/** Ein roter Schritt wartet auf die Freigabe des Owners. */
export function wartetMeldung(grund: string, blockiertUm?: Date | number): string {
  const zeilen = [roteZoneKlartext(grund)];
  if (blockiertUm) zeilen.push(`gestoppt ${uhrzeit(blockiertUm)}`);
  return systemNachricht({
    lage: 'wartet',
    titel: 'Wartet auf Ihre Freigabe',
    zeilen,
    fuss: ['Knopf unten antippen — die Freigabe gilt einmal und 15 Minuten.'],
  });
}

/** Die Freigabe ist gesetzt, aber noch nichts uebertragen. */
export function freigegebenMeldung(ablauf: Date | number): string {
  return systemNachricht({
    lage: 'freigabe',
    titel: 'Freigabe gesetzt',
    zeilen: ['gilt für den nächsten roten Schritt'],
    fuss: [freigabeZeile(ablauf)],
  });
}

/** Die Freigabe war abgelaufen und wurde verworfen. */
export function abgelaufenMeldung(grund: string, alterSekunden: number, grenzeSekunden: number): string {
  return systemNachricht({
    lage: 'hinweis',
    titel: 'Freigabe abgelaufen',
    zeilen: [
      roteZoneKlartext(grund),
      `war ${alterText(alterSekunden)} alt, erlaubt sind ${Math.round(grenzeSekunden / 60)} Minuten`,
    ],
    fuss: ['Bitte erneut freigeben.'],
  });
}

/* ── Antwort eines Commands, der selbst schon gesendet hat ────────────────── */

/**
 * Die Rueckgabe fuer einen Handler, der die Nachricht bereits selbst
 * verschickt hat.
 *
 * ANLASS (Owner, 16.10.2026): „Fix den Bug". Nach jedem `/arm` stand im Chat
 * zusaetzlich „No response generated. Please try again." — als waere etwas
 * schiefgegangen, obwohl die Freigabe sass.
 *
 * URSACHE, belegt im Kern: In
 * `openclaw/dist/bot-native-command-plugins-*.js` entscheidet
 *
 *     const deliverableResult = hasRenderableTelegramNativeReplyPayload(result)
 *       ? … : { text: EMPTY_RESPONSE_FALLBACK };
 *
 * Wer `{ text: '' }` zurueckgibt, hat keinen darstellbaren Inhalt — und
 * bekommt den Fallbacktext untergeschoben. Wenige Zeilen darueber steht die
 * vorgesehene Loesung:
 *
 *     if (… || result.suppressReply === true) { … return; }
 *
 * `suppressReply` sagt dem Kern: Diese Nachricht ist erledigt, sende nichts.
 * Genau das ist hier gemeint. Ein Handler, der selbst sendet, muss das
 * Merkmal setzen — sonst redet der Kern dazwischen.
 */
export interface CommandAntwort {
  text: string;
  /** Vom Kern ausgewertet: nichts mehr senden, der Handler hat es erledigt. */
  suppressReply: true;
}

/** Erledigt — der Handler hat selbst gesendet, der Kern sendet nichts dazu. */
export function stillBeantwortet(): CommandAntwort {
  return { text: '', suppressReply: true };
}
