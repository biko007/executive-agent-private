/**
 * wiki/convert — Wiki-Markup → Markdown.
 *
 * Reine Funktionen ohne Datenbank- oder Netzzugriff, damit der Konverter
 * gegen Goldfiles testbar bleibt. Der Import ruft ihn je Seite einmal auf.
 *
 * **Dialekt: Creole.** Das Quellwiki (JSPWiki 2.8.4 bei Nuveon) ist mit dem
 * Creole-Parser konfiguriert. Erhoben am 2026-10-03 über das Rohmarkup aller
 * 81 Seiten mit Inhalt:
 *
 *   Creole-Links  [[Ziel|Text]] / [[Ziel]]   298 Treffer
 *   klassisch     [Text|Ziel] / [Ziel]        40 Treffer (davon die Mehrzahl
 *                                             Textklammern wie "[1]", keine Links)
 *   Creole fett   **x**                        67 Treffer
 *   klassisch     __x__                         1 Treffer
 *   Creole Head   = / == / === / ====          78 Treffer
 *   klassisch     ! / !! / !!!                   1 Treffer
 *
 * Der entscheidende Unterschied: **Creole stellt das Ziel voran**
 * (`[[Ziel|Text]]`), klassisches JSPWiki den Text (`[Text|Ziel]`). Eine
 * Verwechslung dreht jeden Link um. Beide Formen werden unterstützt, Creole
 * hat Vorrang.
 *
 * Zwei Festlegungen folgen dem, was JSPWiki tatsächlich ausliefert — geprüft
 * am gerenderten HTML, nicht an der Creole-Spezifikation:
 *
 *  1. `**text` am Zeilenanfang ist **fett**, keine verschachtelte Liste.
 *     Die Creole-Spezifikation sieht `**` als Listenebene 2 vor; dieses
 *     JSPWiki rendert `<b>`. Beispiel Seite „Bedienungsanleitungen":
 *     `**Miele Hausgeräte:` → `<p><b>Miele Hausgeräte:</b></p>`.
 *     Maßgeblich ist, was der Eigentümer im Browser sah.
 *  2. Tabellen ohne `|=`-Zellen bekommen eine **leere** Markdown-Kopfzeile.
 *     JSPWiki rendert dort durchgehend `<td>`, nie `<th>`. Die erste Zeile zur
 *     Kopfzeile zu erklären wäre bequemer, wäre aber bei Beschriftungstabellen
 *     wie „Gruppenadresse | Datei.pdf" sachlich falsch. Markdown verlangt eine
 *     Kopfzeile, deshalb bleibt sie leer; das Dashboard blendet eine vollständig
 *     leere Kopfzeile aus.
 *
 * Plugins heißen in Creole `<<...>>` (nicht `[{...}]`). Sie werden entfernt und
 * gezählt, weil ihre Auswertung einen laufenden JSPWiki-Server voraussetzt.
 * Beide Formen werden erkannt.
 */

/** Kategorien laut Auftrag; im Dashboard nachträglich änderbar. */
export const WIKI_CATEGORIES = [
  'Haus Neuhausen',
  'L19',
  'Accounts & Dienste',
  'Technik',
  'Sonstiges',
] as const;

export type WikiCategory = (typeof WIKI_CATEGORIES)[number];

export interface ConvertOptions {
  /** Originaler Wiki-Seitenname, z. B. "Bedienungsanleitungen". */
  pageName: string;
  /** Slug dieser Seite (für Anhang-URLs). */
  pageSlug: string;
  /** Dateinamen der Anhänge dieser Seite — entscheidet, ob [[x.pdf]] ein Anhang ist. */
  attachmentNames?: string[];
  /**
   * Abbildung Seitenname → Slug für interne Links. Unbekannte Ziele behalten
   * einen abgeleiteten Slug, damit Links nach einem Teilimport nicht brechen.
   */
  slugForPage?: (pageName: string) => string;
  /**
   * Auflösung eines Linkziels auf eine **tatsächlich vorhandene** Seite.
   *
   * Rückgabe `null` bedeutet „diese Seite gibt es nicht" — dann entsteht kein
   * Link, sondern nur der Beschriftungstext. Das ist wichtig, weil JSPWiki
   * Seitennamen beim Auflösen normalisiert: `[[IP Adressen L19]]` und die Seite
   * `IPAdressenL19` sind für JSPWiki dasselbe Ziel. Ohne diese Auflösung
   * entstehen Links auf Slugs, die es nicht gibt — am echten Bestand waren das
   * 22 tote Links. Ebenso sollen Verweise auf bewusst nicht importierte Seiten
   * (Passwortseiten, Systemseiten, leere Seiten) nicht ins Leere führen.
   *
   * Hat Vorrang vor `slugForPage`.
   */
  resolvePage?: (pageName: string) => string | null;
}

export interface ConvertResult {
  markdown: string;
  /** Namen der entfernten Plugins, z. B. ["CurrentTimePlugin", "$applicationname"]. */
  removedPlugins: string[];
}

// ── Slug + Titel ────────────────────────────────────────────────────────────

const UMLAUT_MAP: Record<string, string> = {
  'ä': 'ae', 'ö': 'oe', 'ü': 'ue', 'Ä': 'ae', 'Ö': 'oe', 'Ü': 'ue', 'ß': 'ss',
  'á': 'a', 'à': 'a', 'â': 'a', 'é': 'e', 'è': 'e', 'ê': 'e', 'í': 'i', 'ì': 'i',
  'ó': 'o', 'ò': 'o', 'ô': 'o', 'ú': 'u', 'ù': 'u', 'û': 'u', 'ç': 'c', 'ñ': 'n',
};

/**
 * Sprechender Slug aus einem Wiki-Seitennamen.
 * "Haus Neuhausen/Heizung" → "haus-neuhausen-heizung"
 */
export function slugify(name: string): string {
  const transliterated = String(name).replace(
    /[äöüÄÖÜßáàâéèêíìóòôúùûçñ]/g,
    (c) => UMLAUT_MAP[c] ?? c,
  );
  const slug = transliterated
    .replace(/([a-z0-9])([A-Z])/g, '$1-$2') // CamelCase-Seitennamen auftrennen
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80)
    .replace(/-+$/g, '');
  return slug || 'seite';
}

/**
 * Seitennamen für den Vergleich normalisieren — so, wie JSPWiki Ziele auflöst.
 *
 * Leerzeichen, Unterstriche und Bindestriche fallen weg, Groß-/Kleinschreibung
 * wird vereinheitlicht. Damit treffen `[[IP Adressen L19]]`, `[[IPAdressenL19]]`
 * und `[[ip_adressen_l19]]` dieselbe Seite.
 */
export function normalizePageName(name: string): string {
  return String(name).toLowerCase().replace(/[\s_\-.]+/g, '');
}

/** Lesbarer Titel aus einem CamelCase-Seitennamen. */
export function titleFromPageName(name: string): string {
  if (/\s/.test(name)) return name;
  return name.replace(/([a-z0-9])([A-ZÄÖÜ])/g, '$1 $2');
}

// ── Kategorie ───────────────────────────────────────────────────────────────

const CATEGORY_RULES: Array<{ category: WikiCategory; pattern: RegExp }> = [
  { category: 'L19', pattern: /\bL\s?19\b|l19\.de|lindenstr|leutenbergstr|\.dxf\b/i },
  { category: 'Haus Neuhausen', pattern: /neuhausen|heizung|garten|dachgeschoss|keller|sauna|grundst|pergola|freibad|pflanzlist/i },
  { category: 'Accounts & Dienste', pattern: /\baccount|zugang|vertrag|\babo\b|provider|hoster|anbieter|kundennummer|tarif|paypal|amazon|ebay|booking|airbnb|trivago|facebook|google/i },
  { category: 'Technik', pattern: /\bets\b|knx|kamera|\bnas\b|router|wlan|netzwerk|\bserver\b|segway|steuerung|bedienungsanleitung|firmware|switch|videoserver|ip.?adress|gateway|qnap/i },
];

/**
 * Kategorie aus Titel und Inhalt ableiten. Der Titel wiegt schwerer als der
 * Fließtext, weil er das Thema der Seite bezeichnet.
 */
export function deriveCategory(title: string, body: string): WikiCategory {
  for (const { category, pattern } of CATEGORY_RULES) {
    if (pattern.test(title)) return category;
  }
  for (const { category, pattern } of CATEGORY_RULES) {
    if (pattern.test(body)) return category;
  }
  return 'Sonstiges';
}

// ── Sensibel-Erkennung ──────────────────────────────────────────────────────

/**
 * Muster für Geheimnisse.
 *
 * Absichtlich breit: ein Fehlalarm verbirgt eine Seite nur vor dem Agenten (im
 * Dashboard bleibt sie sichtbar und die Markierung ist dort abwählbar), ein
 * verpasster Treffer würde ein Geheimnis an das Sprachmodell geben. Der Fehler
 * soll in die sichere Richtung fallen.
 *
 * Die Gruppe „Tabellenspalten" entstand aus einem konkreten Befund am echten
 * Bestand (2026-10-03): mehrere Seiten führen Zugangsdaten in Tabellen mit der
 * Spaltenüberschrift `| PW|` bzw. `|Pw |`. Eine Erkennung, die nur `PW:` oder
 * `PW=` kannte, hätte diese Seiten als unbedenklich eingestuft und an den
 * Agenten ausgeliefert.
 */
const SENSITIVE_PATTERNS: RegExp[] = [
  // Klartextbegriffe
  /passwor[dt]/i,
  /kennwort/i,
  /\bpasswd\b/i,
  /zugangsdaten/i,
  /\bpin\b/i,
  /\bpuk\b/i,
  /\btan\b/i,
  /kontonummer/i,
  /kreditkart/i,
  /\bcvc\b|\bcvv\b/i,
  /\bIBAN\b/i,
  /\bBIC\b/i,
  /lizenzschl/i,
  /seriennummer/i,
  // Netzzugänge
  /wlan[\s-]*(key|schl|passw)/i,
  /wpa2?[\s-]*(key|psk)/i,
  /\bwep\b/i,
  /netzwerkschl/i,
  /\bssid\b/i,
  // Dienste und Schlüssel
  /api[\s-]*(key|token|secret)/i,
  /secret\s*[:=]/i,
  /\btoken\s*[:=]/i,
  // Tabellenspalten und Zuweisungen — der Befund vom 2026-10-03.
  // `\bpw\b` ohne Kontextzwang: in deutschem Fließtext kommt „PW" praktisch
  // nur als Abkürzung für Passwort vor, und ein Fehlalarm ist harmlos.
  /\bpw\b/i,
  /\bpwd\b/i,
  /\buser\s*[|:=]/i,
  /\blogin\s*[|:=]/i,
  /benutzername\s*[|:=]/i,
];

/** True, wenn Titel oder Inhalt auf Geheimnisse hindeuten. */
export function detectSensitive(title: string, body: string): boolean {
  const haystack = `${title}\n${body}`;
  return SENSITIVE_PATTERNS.some((p) => p.test(haystack));
}

// ── Markup-Konvertierung ────────────────────────────────────────────────────

const EXTERNAL_LINK_RE = /^(https?:|ftp:|mailto:|news:|file:)/i;

/**
 * Platzhalter für gesicherte Abschnitte. Enthält keine Markup-Zeichen und kommt
 * im Quellbestand nicht vor, damit nichts versehentlich ersetzt wird.
 */
const PH_CODE = 'zZwkCodezZ';
const PH_LINK = 'zZwkLinkzZ';

function escapeMarkdownLinkText(text: string): string {
  return text.replace(/([[\]])/g, '\\$1');
}

/** Zellen einer Tabellenzeile; `|=` kennzeichnet eine Kopfzelle. */
function splitTableRow(line: string): { cells: string[]; isHeader: boolean } {
  // Führendes und schließendes Trennzeichen entfernen, dann teilen.
  let body = line.replace(/^\|/, '').replace(/\|\s*$/, '');
  const isHeader = /^=/.test(body) || body.includes('|=');
  body = body.replace(/(^|\|)=/g, '$1');
  const cells = body.split('|').map((c) => c.trim());
  return { cells, isHeader };
}

/**
 * Wiki-Markup (Creole, mit klassischem JSPWiki als Rückfall) in Markdown
 * übersetzen.
 *
 * Reihenfolge ist wesentlich:
 *   1. Code-Blöcke sichern — darin darf nichts ersetzt werden.
 *   2. Plugins entfernen und zählen.
 *   3. Links ersetzen und als Platzhalter sichern — URLs enthalten `//` und
 *      würden sonst von der Kursiv-Regel zerschnitten.
 *   4. Blockstrukturen zeilenweise.
 *   5. Inline-Auszeichnung.
 *   6. Platzhalter zurückspielen.
 */
export function convertJspWikiToMarkdown(markup: string, opts: ConvertOptions): ConvertResult {
  const removedPlugins: string[] = [];
  const attachmentByLower = new Map(
    (opts.attachmentNames ?? []).map((n) => [n.toLowerCase(), n]),
  );
  const slugFor = opts.slugForPage ?? slugify;

  let text = String(markup).replace(/\r\n?/g, '\n');

  // ── 1. Code-/Nowiki-Blöcke sichern ───────────────────────────────────────
  const codeBlocks: string[] = [];
  text = text.replace(/\{\{\{([\s\S]*?)\}\}\}/g, (_m, code: string) => {
    const idx = codeBlocks.length;
    codeBlocks.push(String(code).replace(/^\n/, '').replace(/\n$/, ''));
    return `${PH_CODE}${idx}zZ`;
  });

  // ── 2. Plugins und Stilblöcke entfernen ──────────────────────────────────
  //
  // Creole: <<Name ...>> bzw. <<$variable>>. Klassisch: [{Name ...}].
  //
  // Nachlaufende Leerzeichen gehen mit: `**<<$totalpages>> Seiten**` wird sonst
  // zu `** Seiten**`, und ein `**` mit Leerzeichen dahinter ist in Markdown
  // keine öffnende Fett-Markierung — die Sterne stünden wörtlich auf der Seite.
  // Belegt an der Startseite des echten Bestands.
  text = text.replace(/<<([\s\S]*?)>>[ \t]*/g, (_m, inner: string) => {
    const name = String(inner).trim().match(/^\$?([A-Za-z_][A-Za-z0-9_.]*)/);
    removedPlugins.push(name ? name[1] : 'unbekannt');
    return '';
  });
  text = text.replace(/\[\{([\s\S]*?)\}\][ \t]*/g, (_m, inner: string) => {
    const name = String(inner).trim().match(/^([A-Za-z_][A-Za-z0-9_.]*)/);
    removedPlugins.push(name ? name[1] : 'unbekannt');
    return '';
  });

  // JSPWiki-Stilblöcke tragen nur Gestaltung (im Bestand ausschließlich
  // `%%commentbox`). Die Markierungen entfallen, der Inhalt bleibt —
  // Gestaltung übernimmt im Dashboard die Stilvorlage.
  //
  // JSPWiki kennt zwei Abschlussformen: `/%` und ein alleinstehendes `%%`.
  // Dieses Wiki benutzt die zweite — beide werden entfernt.
  text = text
    .replace(/(^|\n)%%[a-zA-Z0-9_-]+[ \t]*/g, '$1')
    .replace(/(^|\n)(?:\/%|%%)[ \t]*(?=\n|$)/g, '$1');

  // ── 3. Links ─────────────────────────────────────────────────────────────
  const links: string[] = [];
  const stashLink = (markdownLink: string): string => {
    const idx = links.length;
    links.push(markdownLink);
    return `${PH_LINK}${idx}zZ`;
  };

  /** Ein Linkziel in eine Markdown-Adresse übersetzen. */
  const resolveTarget = (target: string, label: string): string => {
    const clean = target.trim();

    if (EXTERNAL_LINK_RE.test(clean)) {
      return `[${escapeMarkdownLinkText(label)}](${clean})`;
    }

    // Anhang dieser Seite? Vergleich über den Dateinamen ohne Seitenpräfix.
    const file = clean.split('/').pop() ?? clean;
    const attachment = attachmentByLower.get(file.toLowerCase());
    if (attachment) {
      const url = `/dashboard/api/wiki/file/${opts.pageSlug}/${encodeURIComponent(attachment)}`;
      return `[${escapeMarkdownLinkText(label)}](${url})`;
    }

    // Interner Seitenlink. Ein Anker (#Abschnitt) bleibt erhalten.
    const [pagePart, anchor] = clean.split('#');
    const name = pagePart.trim();
    const suffix = anchor ? `#${anchor.trim()}` : '';

    if (opts.resolvePage) {
      const aufgeloest = opts.resolvePage(name);
      if (aufgeloest === null) {
        // Kein Link auf eine Seite, die es nicht gibt — nur der Text.
        return escapeMarkdownLinkText(label);
      }
      return `[${escapeMarkdownLinkText(label)}](/dashboard/wiki/${aufgeloest}${suffix})`;
    }

    return `[${escapeMarkdownLinkText(label)}](/dashboard/wiki/${slugFor(name)}${suffix})`;
  };

  // Creole-Bilder {{datei|alt}} — vor den Links, damit {{...}} nicht als Text bleibt.
  text = text.replace(/\{\{([^}|\n]+)(?:\|([^}\n]*))?\}\}/g, (_m, src: string, alt?: string) => {
    const clean = String(src).trim();
    const label = (alt ?? clean).toString().trim();
    const file = clean.split('/').pop() ?? clean;
    const attachment = attachmentByLower.get(file.toLowerCase());
    const url = attachment
      ? `/dashboard/api/wiki/preview/${opts.pageSlug}/${encodeURIComponent(attachment)}`
      : (EXTERNAL_LINK_RE.test(clean) ? clean : `/dashboard/wiki/${slugFor(clean)}`);
    return stashLink(`![${escapeMarkdownLinkText(label)}](${url})`);
  });

  // Creole-Links [[Ziel]] und [[Ziel|Text]] — Ziel steht VORN.
  text = text.replace(/\[\[([^\]\n]+?)\]\]/g, (_m, inner: string) => {
    const parts = String(inner).split('|');
    const target = parts[0].trim();
    const label = (parts.length > 1 ? parts.slice(1).join('|') : target).trim();
    // Bei [[Datei.pdf]] ohne eigenen Text zeigt JSPWiki den Dateinamen.
    return stashLink(resolveTarget(target, label || target));
  });

  // Klassische JSPWiki-Links [Text|Ziel] und [Ziel] — Text steht vorn.
  // Nur anwenden, wenn der Inhalt nach einem Linkziel aussieht: eine reine
  // Zahl wie "[1]" ist im Quellbestand eine Textklammer, kein Link.
  text = text.replace(/\[([^\[\]\n]+)\]/g, (whole, inner: string) => {
    const content = String(inner);
    if (/^\s*\d+\s*$/.test(content)) return whole;      // [1] — Fußnotenmarke
    if (/^\s*[.*/\\]/.test(content)) return whole;      // [.*/.*] — Regex im Hilfetext
    const parts = content.split('|');
    if (parts.length > 1) {
      const label = parts[0].trim();
      const target = parts.slice(1).join('|').trim();
      return stashLink(resolveTarget(target, label));
    }
    return stashLink(resolveTarget(content.trim(), content.trim()));
  });

  // ── 4. Blockstrukturen ───────────────────────────────────────────────────
  const outLines: string[] = [];
  const lines = text.split('\n');
  let tableBuffer: Array<{ cells: string[]; isHeader: boolean }> = [];

  const flushTable = () => {
    if (tableBuffer.length === 0) return;
    const width = Math.max(...tableBuffer.map((r) => r.cells.length));
    const pad = (cells: string[]) => {
      const copy = cells.slice();
      while (copy.length < width) copy.push('');
      return copy;
    };
    const first = tableBuffer[0];
    const hasHeader = first.isHeader;
    const header = hasHeader ? pad(first.cells) : new Array(width).fill('');
    const bodyRows = (hasHeader ? tableBuffer.slice(1) : tableBuffer).map((r) => pad(r.cells));

    outLines.push(`| ${header.join(' | ')} |`);
    outLines.push(`| ${new Array(width).fill('---').join(' | ')} |`);
    for (const row of bodyRows) outLines.push(`| ${row.join(' | ')} |`);
    outLines.push('');
    tableBuffer = [];
  };

  for (const rawLine of lines) {
    const line = rawLine.replace(/\s+$/, '');

    // Tabellenzeile
    if (/^\|/.test(line)) {
      tableBuffer.push(splitTableRow(line));
      continue;
    }
    flushTable();

    // Trennlinie
    if (/^----+\s*$/.test(line)) {
      outLines.push('---');
      continue;
    }

    // Creole-Überschriften: = H1 … ====== H6, schließende = sind optional
    const creoleHeading = line.match(/^(={1,6})\s*(.*?)\s*=*\s*$/);
    if (creoleHeading && creoleHeading[2]) {
      outLines.push(`${'#'.repeat(creoleHeading[1].length)} ${creoleHeading[2]}`);
      continue;
    }

    // Klassische JSPWiki-Überschriften: !!! = größte Ebene
    const classicHeading = line.match(/^(!{1,3})\s*(.*)$/);
    if (classicHeading) {
      const level = 4 - classicHeading[1].length; // !!!→1, !!→2, !→3
      outLines.push(`${'#'.repeat(level)} ${classicHeading[2].trim()}`);
      continue;
    }

    // Aufzählung: GENAU ein * am Zeilenanfang. Zwei oder mehr sind in diesem
    // Wiki Fettschrift (siehe Kopfkommentar), keine Listenebene.
    const bullet = line.match(/^\*(?!\*)\s*(.*)$/);
    if (bullet) {
      outLines.push(`- ${bullet[1]}`);
      continue;
    }

    // Nummerierte Liste: # je Ebene (kein Konflikt mit Fettschrift)
    const numbered = line.match(/^(#+)\s+(.*)$/);
    if (numbered) {
      const indent = '  '.repeat(numbered[1].length - 1);
      outLines.push(`${indent}1. ${numbered[2]}`);
      continue;
    }

    // Definitionszeile ;Begriff:Erklärung
    const definition = line.match(/^;\s*([^:]+):\s*(.*)$/);
    if (definition) {
      outLines.push(`**${definition[1].trim()}** — ${definition[2].trim()}`);
      continue;
    }

    // In JSPWiki schaltet `**` die Fettschrift um; eine offene Fettschrift
    // endet am Absatzende. Zwei Schritte stellen dasselbe in Markdown her:
    //
    //  a) Ein LEERES Paar (`****`) ist in JSPWiki `<b></b>` und damit wirkungs-
    //     los — der Text danach bleibt normal. Markdown kennt kein leeres
    //     Fett-Paar und würde die vier Sterne wörtlich anzeigen. Also entfernen.
    //     Belegt an der Seite „PflanzlisteNeuhausen": `****Pflanzliste:` rendert
    //     bei JSPWiki als `<p><b></b>Pflanzliste:</p>`.
    //  b) Bleibt danach eine ungerade Zahl von `**`, ist eine Fettschrift offen.
    //     Markdown braucht die schließende Markierung ausdrücklich.
    let zeile = line.replace(/\*\*(\s*)\*\*/g, '$1');

    //  c) `** Text` (Markierung, dann Leerzeichen) setzt JSPWiki fett —
    //     nachgeprüft an „Bedienungsanleitungen": `** Andere Hausgeräte`
    //     rendert als `<b> Andere Hausgeräte</b>`. Markdown verlangt dagegen,
    //     dass die öffnende Markierung unmittelbar am Wort steht; mit
    //     Leerzeichen dahinter zeigt es die Sterne wörtlich. Das Leerzeichen
    //     wandert daher vor die Markierung — optisch dasselbe Ergebnis.
    zeile = zeile.replace(/^(\s*)\*\*(\s+)/, '$1$2**');

    if ((zeile.match(/\*\*/g) ?? []).length % 2 === 1) {
      zeile = `${zeile}**`;
    }

    outLines.push(zeile);
  }
  flushTable();

  text = outLines.join('\n');

  // ── 5. Inline-Auszeichnung ───────────────────────────────────────────────
  text = text
    // Creole fett ist identisch mit Markdown — nichts zu tun.
    // Klassisch fett __x__ → **x**
    .replace(/__([^_\n]+)__/g, '**$1**')
    // Creole kursiv //x// → *x* (URLs sind als Platzhalter geschützt)
    .replace(/(^|[^:/])\/\/([^/\n]+)\/\//g, '$1*$2*')
    // Klassisch kursiv ''x'' → *x*
    .replace(/''([^'\n]+)''/g, '*$1*')
    // Zeilenumbruch \\ → Markdown-Umbruch (zwei Leerzeichen)
    .replace(/\\\\[ \t]*/g, '  \n');

  // ── 6. Platzhalter zurückspielen ─────────────────────────────────────────
  text = text.replace(new RegExp(`${PH_LINK}(\\d+)zZ`, 'g'), (_m, idx: string) =>
    links[Number(idx)] ?? '');

  text = text.replace(new RegExp(`${PH_CODE}(\\d+)zZ`, 'g'), (_m, idx: string) => {
    const code = codeBlocks[Number(idx)] ?? '';
    if (code.includes('\n')) return `\n\`\`\`\n${code}\n\`\`\`\n`;
    return `\`${code}\``;
  });

  // Creole-Escape: ~X gibt X wörtlich aus.
  text = text.replace(/~([^\s])/g, '$1');

  // Mehr als eine Leerzeile zusammenfassen
  text = text.replace(/\n{3,}/g, '\n\n').trim();

  return { markdown: text, removedPlugins };
}
