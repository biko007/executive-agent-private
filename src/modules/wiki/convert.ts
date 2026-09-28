/**
 * wiki/convert — JSPWiki-Markup → Markdown.
 *
 * Reine Funktionen ohne Datenbank- oder Netzzugriff, damit der Konverter
 * gegen Goldfiles testbar bleibt. Der Import ruft ihn je Seite einmal auf.
 *
 * Bewusst nicht unterstützt: JSPWiki-Plugins. Sie werden entfernt und gezählt,
 * weil ihre Ausführung einen JSPWiki-Server voraussetzt. Der Report weist die
 * entfernten Plugins aus, damit nichts stillschweigend verschwindet.
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
  /** Originaler JSPWiki-Seitenname, z. B. "Haus Neuhausen". */
  pageName: string;
  /** Slug dieser Seite (für Anhang-URLs). */
  pageSlug: string;
  /** Dateinamen der Anhänge dieser Seite — entscheidet, ob [x.pdf] ein Anhang ist. */
  attachmentNames?: string[];
  /**
   * Abbildung Seitenname → Slug für interne Links. Unbekannte Ziele behalten
   * einen abgeleiteten Slug, damit Links nach einem Teilimport nicht brechen.
   */
  slugForPage?: (pageName: string) => string;
}

export interface ConvertResult {
  markdown: string;
  /** Namen der entfernten Plugins, z. B. ["TableOfContents", "Image"]. */
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

/** Lesbarer Titel aus einem JSPWiki-CamelCase-Namen. */
export function titleFromPageName(name: string): string {
  if (/\s/.test(name)) return name;
  return name.replace(/([a-z0-9])([A-ZÄÖÜ])/g, '$1 $2');
}

// ── Kategorie ───────────────────────────────────────────────────────────────

const CATEGORY_RULES: Array<{ category: WikiCategory; pattern: RegExp }> = [
  { category: 'L19', pattern: /\bL\s?19\b|l19\.de|lindenstr|\.dxf\b/i },
  { category: 'Haus Neuhausen', pattern: /neuhausen|heizung|garten|dachgeschoss|keller|sauna|grundst/i },
  { category: 'Accounts & Dienste', pattern: /\baccount|zugang|vertrag|\babo\b|provider|hoster|anbieter|kundennummer|tarif/i },
  { category: 'Technik', pattern: /\bets\b|knx|kamera|\bnas\b|router|wlan|netzwerk|server|segway|steuerung|bedienungsanleitung|firmware|switch/i },
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
 * Muster für Geheimnisse. Absichtlich breit: ein Fehlalarm verbirgt eine Seite
 * nur vor dem Agenten (im Dashboard bleibt sie sichtbar), ein verpasster Treffer
 * würde ein Geheimnis an das Sprachmodell geben. Der Fehler soll in die
 * sichere Richtung fallen.
 */
const SENSITIVE_PATTERNS: RegExp[] = [
  /passwor[dt]/i,
  /kennwort/i,
  /\bpasswd\b/i,
  /\bpw\b\s*[:=]/i,
  /\bpin\b/i,
  /\bpuk\b/i,
  /\btan\b/i,
  /wlan[\s-]*(key|schl|passw)/i,
  /wpa2?[\s-]*(key|psk)/i,
  /netzwerkschl/i,
  /\bIBAN\b/i,
  /\bBIC\b/i,
  /kontonummer/i,
  /kreditkart/i,
  /\bcvc\b|\bcvv\b/i,
  /zugangsdaten/i,
  /benutzername\s*[:=]/i,
  /\blogin\b\s*[:=]/i,
  /api[\s-]*(key|token|secret)/i,
  /secret\s*[:=]/i,
  /lizenzschl/i,
  /seriennummer/i,
];

/** True, wenn Titel oder Inhalt auf Geheimnisse hindeuten. */
export function detectSensitive(title: string, body: string): boolean {
  const haystack = `${title}\n${body}`;
  return SENSITIVE_PATTERNS.some((p) => p.test(haystack));
}

// ── Markup-Konvertierung ────────────────────────────────────────────────────

const EXTERNAL_LINK_RE = /^(https?:|ftp:|mailto:|news:|file:)/i;

/** Platzhalter für gesicherte Code-Blöcke. Enthält keine Markup-Zeichen. */
const CODE_PLACEHOLDER_PREFIX = 'zZwikicodezZ';

function escapeMarkdownLinkText(text: string): string {
  return text.replace(/([[\]])/g, '\\$1');
}

/** Tabellenzeile in Zellen zerlegen; `||` = Kopfzelle, `|` = Datenzelle. */
function splitTableRow(line: string): { cells: string[]; isHeader: boolean } {
  const isHeader = line.startsWith('||');
  // Führendes Trennzeichen entfernen, dann an | bzw. || teilen.
  const body = line.replace(/^\|\|?/, '');
  const cells = body.split(/\|\|?/).map((c) => c.trim());
  return { cells, isHeader };
}

/**
 * JSPWiki-Markup in Markdown übersetzen.
 *
 * Reihenfolge ist wesentlich: Code-Blöcke werden zuerst durch Platzhalter
 * ersetzt, damit Markup innerhalb von Code unangetastet bleibt. Danach folgen
 * Plugins, dann zeilenweise Blockstrukturen, zuletzt Inline-Auszeichnung.
 */
export function convertJspWikiToMarkdown(markup: string, opts: ConvertOptions): ConvertResult {
  const removedPlugins: string[] = [];
  const attachmentNames = new Set((opts.attachmentNames ?? []).map((n) => n.toLowerCase()));
  const slugFor = opts.slugForPage ?? slugify;

  let text = String(markup).replace(/\r\n?/g, '\n');

  // 1. Code-Blöcke {{{ ... }}} sichern
  const codeBlocks: string[] = [];
  text = text.replace(/\{\{\{([\s\S]*?)\}\}\}/g, (_m, code: string) => {
    const idx = codeBlocks.length;
    codeBlocks.push(String(code).replace(/^\n/, '').replace(/\n$/, ''));
    return `${CODE_PLACEHOLDER_PREFIX}${idx}zZ`;
  });

  // 2. Plugins [{...}] entfernen und zählen
  text = text.replace(/\[\{([\s\S]*?)\}\]/g, (_m, inner: string) => {
    const nameMatch = String(inner).trim().match(/^([A-Za-z_][A-Za-z0-9_.]*)/);
    removedPlugins.push(nameMatch ? nameMatch[1] : 'unbekannt');
    return '';
  });

  // 3. Links [Text|Ziel] und [Ziel]
  text = text.replace(/\[([^\][|]+)(?:\|([^\][]+))?\]/g, (_m, first: string, second?: string) => {
    const label = String(first).trim();
    const target = String(second ?? first).trim();

    if (EXTERNAL_LINK_RE.test(target)) {
      return `[${escapeMarkdownLinkText(label)}](${target})`;
    }

    // Anhang dieser Seite?
    const targetFile = target.split('/').pop() ?? target;
    if (attachmentNames.has(targetFile.toLowerCase())) {
      const url = `/dashboard/api/wiki/file/${opts.pageSlug}/${encodeURIComponent(targetFile)}`;
      return `[${escapeMarkdownLinkText(label)}](${url})`;
    }

    // Interner Seitenlink
    return `[${escapeMarkdownLinkText(label)}](/dashboard/wiki/${slugFor(target)})`;
  });

  // 4. Blockstrukturen zeilenweise
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
    // Markdown braucht immer eine Kopfzeile. Hat die JSPWiki-Tabelle keine,
    // wird eine leere erzeugt, damit die Tabelle überhaupt rendert.
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
    if (/^\|\|?/.test(line)) {
      tableBuffer.push(splitTableRow(line));
      continue;
    }
    flushTable();

    // Trennlinie
    if (/^----+\s*$/.test(line)) {
      outLines.push('---');
      continue;
    }

    // Überschriften: !!! = größte Ebene
    const heading = line.match(/^(!{1,3})\s*(.*)$/);
    if (heading) {
      const level = 4 - heading[1].length; // !!!→1, !!→2, !→3
      outLines.push(`${'#'.repeat(level)} ${heading[2].trim()}`);
      continue;
    }

    // Listen: * unsortiert, # sortiert, Tiefe = Zeichenanzahl
    const bullet = line.match(/^(\*+)\s+(.*)$/);
    if (bullet) {
      const indent = '  '.repeat(bullet[1].length - 1);
      outLines.push(`${indent}- ${bullet[2]}`);
      continue;
    }
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

    outLines.push(line);
  }
  flushTable();

  text = outLines.join('\n');

  // 5. Inline-Auszeichnung
  text = text
    .replace(/__([^_\n]+)__/g, '**$1**')
    .replace(/''([^'\n]+)''/g, '*$1*')
    .replace(/\{\{([^}\n]+)\}\}/g, '`$1`')
    // JSPWiki-Zeilenumbruch \\ → Markdown-Zeilenumbruch (zwei Leerzeichen)
    .replace(/\\\\[ \t]*/g, '  \n');

  // 6. Code-Blöcke zurückspielen
  const placeholderRe = new RegExp(`${CODE_PLACEHOLDER_PREFIX}(\\d+)zZ`, 'g');
  text = text.replace(placeholderRe, (_m, idx: string) => {
    const code = codeBlocks[Number(idx)] ?? '';
    if (code.includes('\n')) return `\n\`\`\`\n${code}\n\`\`\`\n`;
    return `\`${code}\``;
  });

  // 7. Mehr als eine Leerzeile zusammenfassen
  text = text.replace(/\n{3,}/g, '\n\n').trim();

  return { markdown: text, removedPlugins };
}
