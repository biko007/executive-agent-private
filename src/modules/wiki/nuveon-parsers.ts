/**
 * wiki-import/parsers — reine HTML-Parser für den Nuveon-Import.
 *
 * Absichtlich ohne Netz- und Dateizugriff, damit der Import gegen gespeicherte
 * Fixture-Seiten getestet werden kann, ohne das Quellwiki anzufassen.
 *
 * Die Parser sind bewusst nachsichtig: JSPWiki 2.8 rendert Index- und
 * Anhangseiten über Plugins, deren Markup je Skin abweicht. Statt auf eine
 * Tabellenstruktur zu setzen, werden die Wiki- und Anhang-Links selbst
 * ausgewertet — das hält den Import auch bei abweichendem Skin lauffähig.
 */

/** Systemseiten, die nicht importiert werden (Auftrag §5.1). */
export const SYSTEM_PAGES = new Set([
  'AnhangIndex', 'Index', 'EditPageHelp', 'InterwikiLink', 'LeftMenu',
  'LeftMenuFooter', 'LeftMenuLogo', 'LetzteÄnderungen', 'Sandkasten',
  'Standardseite', 'Stub', 'SystemInfo', 'Textformatierungsregel',
  'UndefinierteSeite', 'UnreferenzierteSeite', 'WikiEtikette',
  'WikiInEinerMinute', 'CustomEditorial', 'Editorial', 'JuwiSkin',
  'JuwiAccessLog', 'Talk', 'PDFExport',
  // Englische Entsprechungen derselben Standardseiten
  'RecentChanges', 'SandBox', 'SystemPages', 'TextFormattingRules',
  'UndefinedPages', 'UnusedPages', 'WikiEtiquette', 'OneMinuteWiki',
  'PageIndex', 'AttachmentIndex', 'Main', 'About', 'MoreMenu',
]);

/**
 * Seiten mit Geheimnissen. Werden NICHT geladen und NICHT importiert
 * (Stop-Condition 3) — sie erscheinen nur namentlich im Report.
 */
export const PASSWORD_PAGES = new Set([
  'PW', 'Passwörter', 'PasswortÄndern',
  // Schreibvarianten derselben Seiten, damit keine durchrutscht
  'Passwoerter', 'PasswortAendern', 'Passworter', 'Passwords', 'Password',
]);

export interface AttachmentIndexEntry {
  /** Seitenname, an dem der Anhang hängt. */
  pageName: string;
  filename: string;
  /** Größe in Byte, soweit aus dem Index ableitbar. */
  size: number | null;
  /** Rohtext der Größenangabe, z. B. "12.4 kB" — für den Report. */
  sizeText: string | null;
  author: string | null;
  /** Datumsangabe als Rohtext; Formate schwanken je Locale. */
  dateText: string | null;
}

// ── HTML-Grundfunktionen ────────────────────────────────────────────────────

const ENTITIES: Record<string, string> = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ',
  auml: 'ä', ouml: 'ö', uuml: 'ü', Auml: 'Ä', Ouml: 'Ö', Uuml: 'Ü', szlig: 'ß',
  eacute: 'é', egrave: 'è', agrave: 'à', ccedil: 'ç', ndash: '–', mdash: '—',
};

/** HTML-Entities auflösen (benannte und numerische). */
export function decodeHtmlEntities(input: string): string {
  return String(input)
    .replace(/&#x([0-9a-fA-F]+);/g, (_m, hex: string) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_m, dec: string) => String.fromCodePoint(parseInt(dec, 10)))
    .replace(/&([a-zA-Z]+);/g, (m, name: string) => ENTITIES[name] ?? m);
}

/** Tags entfernen und Whitespace normalisieren. */
export function stripTags(html: string): string {
  return decodeHtmlEntities(
    String(html).replace(/<[^>]*>/g, ' '),
  ).replace(/\s+/g, ' ').trim();
}

// ── Seitenliste ─────────────────────────────────────────────────────────────

/**
 * Seitennamen aus der gerenderten Index-Seite lesen.
 *
 * Erkannt werden beide Link-Formen von JSPWiki:
 *   /biko/wiki/<Name>            (Short-URL-Konstruktor)
 *   /biko/Wiki.jsp?page=<Name>   (klassisch)
 *
 * Anhang- und Aktionslinks werden verworfen. Das Ergebnis ist dedupliziert und
 * alphabetisch sortiert, damit ein Wiederanlauf dieselbe Reihenfolge sieht.
 */
export function parsePageIndex(html: string, wikiPath = '/biko'): string[] {
  const found = new Set<string>();
  const escapedPath = wikiPath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

  const shortUrl = new RegExp(`${escapedPath}/wiki/([^"'#?\\s>]+)`, 'g');
  const classicUrl = new RegExp(`${escapedPath}/Wiki\\.jsp\\?page=([^"'&#\\s>]+)`, 'g');

  for (const re of [shortUrl, classicUrl]) {
    let match: RegExpExecArray | null;
    while ((match = re.exec(html)) !== null) {
      const raw = match[1];
      // Anhänge tragen in der Kurzform einen Schrägstrich (Seite/Datei).
      if (raw.includes('/')) continue;
      let name: string;
      try {
        name = decodeURIComponent(raw);
      } catch {
        name = raw;
      }
      name = decodeHtmlEntities(name).trim();
      if (!name) continue;
      // Aktionsseiten von JSPWiki
      if (/\.jsp$/i.test(name)) continue;
      found.add(name);
    }
  }

  return [...found].sort((a, b) => a.localeCompare(b, 'de'));
}

// ── Anhangliste ─────────────────────────────────────────────────────────────

const SIZE_RE = /(\d+(?:[.,]\d+)?)\s*(bytes?|B|kB|KB|KiB|MB|MiB|GB|GiB)\b/i;

/** Größenangabe wie "12.4 kB" in Byte umrechnen. */
export function parseSizeText(text: string): number | null {
  const match = String(text).match(SIZE_RE);
  if (!match) return null;
  const value = parseFloat(match[1].replace(',', '.'));
  if (!Number.isFinite(value)) return null;
  const unit = match[2].toLowerCase();
  const factor = unit.startsWith('k') ? 1024
    : unit.startsWith('m') ? 1024 * 1024
    : unit.startsWith('g') ? 1024 * 1024 * 1024
    : 1;
  return Math.round(value * factor);
}

const DATE_RE = /\b(\d{1,2}[.\/-]\d{1,2}[.\/-]\d{2,4}(?:[ ,]+\d{1,2}:\d{2}(?::\d{2})?)?)\b/;

/**
 * Anhangliste aus der gerenderten AnhangIndex-Seite lesen.
 *
 * Grundlage sind die Anhang-Links selbst (`/biko/attach/<Seite>/<Datei>`).
 * Größe, Autor und Datum werden aus der umgebenden Tabellenzeile gelesen,
 * soweit vorhanden — fehlen sie, bleibt das Feld null und der Größenvergleich
 * entfällt für diesen Anhang (wird im Report vermerkt).
 */
export function parseAttachmentIndex(html: string, wikiPath = '/biko'): AttachmentIndexEntry[] {
  const escapedPath = wikiPath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const attachRe = new RegExp(`${escapedPath}/attach/([^"'\\s>]+)/([^"'\\s>/]+)`, 'g');

  // Tabellenzeilen vorab indexieren, um Kontext je Anhang zu finden.
  const rows = String(html).match(/<tr[\s\S]*?<\/tr>/gi) ?? [];

  const seen = new Set<string>();
  const entries: AttachmentIndexEntry[] = [];

  let match: RegExpExecArray | null;
  while ((match = attachRe.exec(html)) !== null) {
    const pageRaw = match[1];
    const fileRaw = match[2];

    let pageName: string;
    let filename: string;
    try {
      pageName = decodeURIComponent(pageRaw);
      filename = decodeURIComponent(fileRaw);
    } catch {
      pageName = pageRaw;
      filename = fileRaw;
    }
    pageName = decodeHtmlEntities(pageName).trim();
    filename = decodeHtmlEntities(filename).trim();
    if (!pageName || !filename) continue;

    const key = `${pageName}/${filename}`;
    if (seen.has(key)) continue;
    seen.add(key);

    // Zugehörige Tabellenzeile suchen (die, die diesen Anhang-Link enthält).
    const row = rows.find((r) => r.includes(`${wikiPath}/attach/${pageRaw}/${fileRaw}`));
    let size: number | null = null;
    let sizeText: string | null = null;
    let author: string | null = null;
    let dateText: string | null = null;

    if (row) {
      const cells = (row.match(/<t[dh][\s\S]*?<\/t[dh]>/gi) ?? []).map(stripTags);
      for (const cell of cells) {
        if (sizeText === null && SIZE_RE.test(cell)) {
          sizeText = cell;
          size = parseSizeText(cell);
          continue;
        }
        if (dateText === null && DATE_RE.test(cell)) {
          dateText = (cell.match(DATE_RE) as RegExpMatchArray)[1];
          continue;
        }
      }
      // Autor: Zelle, die weder Dateiname, Größe noch Datum ist.
      const candidate = cells.find((c) => c
        && c !== filename
        && c !== sizeText
        && c !== dateText
        && !c.includes(filename)
        && !SIZE_RE.test(c)
        && !DATE_RE.test(c)
        && c.length <= 60);
      author = candidate ?? null;
    }

    entries.push({ pageName, filename, size, sizeText, author, dateText });
  }

  return entries;
}

// ── Rohmarkup ───────────────────────────────────────────────────────────────

/**
 * Rohmarkup aus der Editor-Seite (EditX.jsp) lesen.
 *
 * JSPWiki 2.8 legt den Seiteninhalt in das erste <textarea> des Editors.
 * Der Inhalt ist HTML-escaped und wird hier zurückverwandelt.
 * Rückgabe null, wenn keine Textarea gefunden wurde (dann greift der
 * Fallback über das gerenderte HTML).
 */
export function extractRawMarkup(editHtml: string): string | null {
  const match = String(editHtml).match(/<textarea[^>]*>([\s\S]*?)<\/textarea>/i);
  if (!match) return null;
  return decodeHtmlEntities(match[1]).replace(/\r\n?/g, '\n');
}

/**
 * Letzte Änderung und Autor aus einer gerenderten Wiki-Seite lesen.
 *
 * JSPWiki setzt im Fuß je nach Sprache Varianten von
 * „Diese Seite wurde zuletzt geändert am <Datum> von <Autor>".
 * Beide Angaben sind optional — fehlen sie, bleibt das Feld null.
 */
export function parsePageMeta(pageHtml: string): { author: string | null; dateText: string | null } {
  const text = stripTags(pageHtml);

  let author: string | null = null;
  const authorMatch = text.match(/\b(?:von|by)\s+([A-ZÄÖÜ][\wÄÖÜäöüß.\- ]{1,40}?)(?:\s*(?:\.|$|\||Zurück|Back))/);
  if (authorMatch) author = authorMatch[1].trim();

  let dateText: string | null = null;
  const dateMatch = text.match(/(?:geändert am|last changed on|last modified on)\s*([^|]{6,40}?)(?:\s+(?:von|by)\b|\s*\.|$)/i);
  if (dateMatch) {
    dateText = dateMatch[1].trim();
  } else {
    const loose = text.match(DATE_RE);
    if (loose) dateText = loose[1];
  }

  return { author, dateText };
}

/**
 * Seiteninhalt aus gerendertem HTML als Notfall-Fallback extrahieren.
 * Nur verwendet, wenn die Editor-Seite kein Markup liefert; das Ergebnis ist
 * Text, nicht Markup, und wird im Report als solcher gekennzeichnet.
 */
export function extractRenderedContent(pageHtml: string): string {
  const match = String(pageHtml).match(
    /<div[^>]*class=["'][^"']*\b(?:pagecontent|page-content|wikitext)\b[^"']*["'][^>]*>([\s\S]*?)<\/div>/i,
  );
  const inner = match ? match[1] : pageHtml;
  return stripTags(inner);
}

/** Prüft, ob eine Antwortseite die Anmeldemaske ist (Login fehlgeschlagen). */
export function looksLikeLoginPage(html: string): boolean {
  return /name=["']j_username["']/i.test(html) || /name=["']j_password["']/i.test(html);
}

/**
 * Seite überspringen? Systemseiten, Passwortseiten und leere Seiten fallen weg.
 * Der Grund wird mitgeliefert, damit der Report ihn ausweisen kann.
 */
export function skipReason(pageName: string, markup: string | null): string | null {
  if (PASSWORD_PAGES.has(pageName)) return 'Passwortseite (Stop-Condition 3)';
  if (SYSTEM_PAGES.has(pageName)) return 'Systemseite';
  if (markup !== null && markup.trim().length === 0) return 'leer';
  if (markup !== null && markup.trim().length < 10 && !/\[/.test(markup)) return 'praktisch leer';
  return null;
}
