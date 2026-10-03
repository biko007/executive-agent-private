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
  // Am echten Bestand ergänzt (2026-10-03): reine Hilfe- und Schrottseiten.
  // 'Spickzettel' und 'TextFormattingRules' sind die deutsche und englische
  // Fassung derselben Markup-Kurzreferenz; 'FindPage' ist die Suchmaske;
  // '__PAGEHERE__' und '#$%' sind Artefakte aus Skin-Vorlagen.
  'Spickzettel', 'FindPage', '__PAGEHERE__', '#$%',
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

// Zwischen Zahl und Einheit steht in JSPWiki ein geschütztes Leerzeichen.
const SIZE_RE = /(\d+(?:[.,]\d+)?)[\s\u00a0]*(bytes?|B|kB|KB|KiB|MB|MiB|GB|GiB)\b/i;

/**
 * Größenangabe wie "1532.6 kB" in Byte umrechnen.
 *
 * **JSPWiki rechnet dezimal** (kB = 1000 Byte), nicht binär. Am echten Bestand
 * gegengeprüft (2026-10-03): `Tools.zip` meldet 1532.6 kB bei exakt 1.532.597
 * Byte Content-Length (1532597/1000 = 1532.597), `Biko-Haus-2729.tif` meldet
 * 126183.7 kB bei 126.183.728 Byte. Mit 1024 als Faktor lägen alle Vergleiche
 * um 2,4 % daneben und der Größenabgleich wäre wertlos.
 *
 * Die Binärformen (KiB/MiB/GiB) werden der Vollständigkeit halber binär
 * gerechnet, kommen in diesem Bestand aber nicht vor.
 */
export function parseSizeText(text: string): number | null {
  const match = String(text).match(SIZE_RE);
  if (!match) return null;
  const value = parseFloat(match[1].replace(',', '.'));
  if (!Number.isFinite(value)) return null;
  const unit = match[2].toLowerCase();
  const binaer = unit.endsWith('ib');
  const stufe = unit.startsWith('k') ? 1 : unit.startsWith('m') ? 2 : unit.startsWith('g') ? 3 : 0;
  const factor = Math.pow(binaer ? 1024 : 1000, stufe);
  return Math.round(value * factor);
}

export interface AttachmentInfo {
  /** Größe in Byte, aus der gerundeten Angabe der Infoseite umgerechnet. */
  size: number | null;
  /** Rohtext der Größenangabe, z. B. "1532.6 kB" — für den Report. */
  sizeText: string | null;
  author: string | null;
  dateText: string | null;
  version: number | null;
}

/**
 * Metadaten eines Anhangs aus `PageInfo.jsp?page=<Seite>/<Datei>` lesen.
 *
 * Diese Seite ist die belastbare Quelle für Größe, Datum und Autor. Der
 * AnhangIndex dieses Skins führt **nur Namen** — am echten Bestand lieferten
 * alle 140 Einträge dort keine Größenangabe, weshalb der im Auftrag verlangte
 * Größenabgleich ohne diese Seite nicht möglich wäre.
 *
 * Struktur der Tabelle: Kind | Version | Size | Date Modified | Author | Change note
 */
export function parseAttachmentInfo(infoHtml: string): AttachmentInfo {
  const leer: AttachmentInfo = { size: null, sizeText: null, author: null, dateText: null, version: null };
  const html = String(infoHtml);

  const zellen = (zeile: string): string[] =>
    [...zeile.matchAll(/<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/gi)]
      .map((m) => stripTags(m[1]));

  // Die richtige Tabelle suchen: eine, deren erste Zeile die Spalten "size"
  // UND "version" als eigene Zellen führt. Ein einfaches Suchen nach dem Wort
  // "Size" im Tabellenrumpf trifft die Upload-Maske weiter oben im Dokument —
  // am 2026-10-03 die Ursache dafür, dass alle 139 Größenabgleiche leer blieben.
  let kopf: string[] = [];
  let daten: string[] = [];
  for (const tabelle of html.matchAll(/<table[^>]*>([\s\S]*?)<\/table>/gi)) {
    const zeilen = [...tabelle[1].matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/gi)];
    if (zeilen.length < 2) continue;
    const moeglicherKopf = zellen(zeilen[0][1]).map((c) => c.toLowerCase());
    const hatSize = moeglicherKopf.some((c) => c === 'size' || c.startsWith('size'));
    const hatVersion = moeglicherKopf.some((c) => c.startsWith('version'));
    if (!hatSize || !hatVersion) continue;
    kopf = moeglicherKopf;
    daten = zellen(zeilen[1][1]);
    break;
  }
  if (kopf.length === 0) return leer;
  const feld = (name: string): string | null => {
    const i = kopf.findIndex((c) => c.includes(name));
    return i >= 0 && i < daten.length && daten[i] ? daten[i] : null;
  };

  const sizeText = feld('size');
  const versionText = feld('version');
  const version = versionText && /^\d+$/.test(versionText) ? parseInt(versionText, 10) : null;

  return {
    size: sizeText ? parseSizeText(sizeText) : null,
    sizeText,
    author: feld('author'),
    dateText: feld('date'),
    version,
  };
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
 * Die Editor-Seite von JSPWiki 2.8 enthält DREI <textarea>-Elemente:
 *
 *   id="lastEditText"  — vorheriger Stand, bei vielen Seiten leer
 *   id="previewText"   — Vorschaupuffer, im Normalfall leer
 *   id="pagetext" name="_editedtext" — der tatsächliche Seiteninhalt
 *
 * Maßgeblich ist ausschließlich `name="_editedtext"`. Das erste <textarea> zu
 * nehmen liefert bei den meisten Seiten einen Leerstring und schickt den Import
 * in den HTML-Fallback — am echten Bestand waren das 41 von 57 Seiten, die
 * dann als Fließtext statt als Markup importiert worden wären.
 *
 * Rückgabe null, wenn das Inhaltsfeld fehlt (dann greift der Fallback über das
 * gerenderte HTML).
 */
export function extractRawMarkup(editHtml: string): string | null {
  const html = String(editHtml);

  // Bevorzugt das benannte Inhaltsfeld, unabhängig von der Attributreihenfolge.
  const named = html.match(
    /<textarea[^>]*\bname=["']_editedtext["'][^>]*>([\s\S]*?)<\/textarea>/i,
  ) ?? html.match(
    /<textarea[^>]*\bid=["']pagetext["'][^>]*>([\s\S]*?)<\/textarea>/i,
  );
  if (named) return decodeHtmlEntities(named[1]).replace(/\r\n?/g, '\n');

  // Rückfall für abweichende Skins: das inhaltsreichste <textarea> gewinnt.
  const alle = [...html.matchAll(/<textarea[^>]*>([\s\S]*?)<\/textarea>/gi)];
  if (alle.length === 0) return null;
  const groesstes = alle.reduce((a, b) => (b[1].length > a[1].length ? b : a));
  if (groesstes[1].trim().length === 0) return null;
  return decodeHtmlEntities(groesstes[1]).replace(/\r\n?/g, '\n');
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
 *
 * Nur verwendet, wenn die Editor-Seite kein Markup liefert; das Ergebnis ist
 * Text, nicht Markup, und wird im Report als solcher gekennzeichnet.
 *
 * Der Inhaltsbereich dieses Skins enthält neben dem Seiteninhalt auch das
 * Formular „Add new attachment" samt Hilfetext. Ohne dessen Entfernung sah eine
 * vollständig leere Seite nach Inhalt aus: am echten Bestand hätten die vier
 * leeren Seiten Airbnb, Fewo, Pic und Trivago den Formulartext als Seitentext
 * importiert, statt als leer übersprungen zu werden.
 */
export function extractRenderedContent(pageHtml: string): string {
  const html = String(pageHtml);

  // Bevorzugt den Inhaltsbereich; id vor class, weil der Skin beides führt.
  const byId = html.match(/<div[^>]*\bid=["']pagecontent["'][^>]*>([\s\S]*)$/i);
  const byClass = html.match(
    /<div[^>]*class=["'][^"']*\b(?:pagecontent|page-content|wikitext)\b[^"']*["'][^>]*>([\s\S]*)$/i,
  );
  let inner = (byId ?? byClass)?.[1] ?? html;

  // Alles ab den Seitenaktionen bzw. der Versionszeile abschneiden.
  inner = inner.split(/<div[^>]*class=["'][^"']*\b(?:pageactions|tags|wikiversion)\b/i)[0];

  // Skin-Beiwerk entfernen: Upload-Formular, Formulare, Skripte, Stile.
  inner = inner
    .replace(/<div[^>]*\bid=["']addattachment["'][\s\S]*$/i, '')
    .replace(/<form[\s\S]*?<\/form>/gi, '')
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '');

  return stripTags(inner);
}

/**
 * Erkennt den Hinweistext für ein nicht existierendes Seitenziel.
 *
 * Der Seitenindex enthält auch verwaiste Links — Ziele, die irgendwo verlinkt
 * sind, aber nie angelegt wurden. JSPWiki liefert dafür HTTP 200 mit dem
 * Hinweis „This page does not exist". Am echten Bestand traf das `Talk.Index`,
 * das sonst mit diesem Hinweis als Seiteninhalt importiert worden wäre.
 */
export function looksLikeMissingPage(text: string): boolean {
  return /this page does not exist|diese seite existiert nicht/i.test(String(text));
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
  if (markup !== null && looksLikeMissingPage(markup)) return 'existiert nicht (verwaister Link)';
  if (markup !== null && markup.trim().length === 0) return 'leer';
  if (markup !== null && markup.trim().length < 10 && !/\[/.test(markup)) return 'praktisch leer';
  return null;
}
