/**
 * Parser-Tests für den Nuveon-Import.
 *
 * Grundlage sind Fixture-Ausschnitte im Stil von JSPWiki 2.8 (beide Link-Formen,
 * Anhangtabelle, Editor-Seite, Anmeldemaske). Damit ist der Import prüfbar,
 * ohne das Quellwiki anzufassen.
 */
import { describe, expect, test } from 'bun:test';
import {
  parsePageIndex, parseAttachmentIndex, extractRawMarkup, parsePageMeta,
  extractRenderedContent, looksLikeLoginPage, skipReason, parseSizeText,
  decodeHtmlEntities, stripTags, SYSTEM_PAGES, PASSWORD_PAGES,
} from '../nuveon-parsers.js';

// ── Fixtures ────────────────────────────────────────────────────────────────

const INDEX_HTML = `
<html><body><div class="pagecontent">
<div class="collapsebox">
 <ul>
  <li><a class="wikipage" href="/biko/wiki/Home">Home</a></li>
  <li><a class="wikipage" href="/biko/wiki/HausNeuhausen">HausNeuhausen</a></li>
  <li><a class="wikipage" href="/biko/wiki/Kaffeeautomat">Kaffeeautomat</a></li>
  <li><a class="wikipage" href="/biko/wiki/Passw%C3%B6rter">Passwörter</a></li>
  <li><a class="wikipage" href="/biko/Wiki.jsp?page=L19">L19</a></li>
  <li><a class="wikipage" href="/biko/wiki/Index">Index</a></li>
  <li><a href="/biko/attach/Kaffeeautomat/Anleitung.pdf">Anleitung.pdf</a></li>
  <li><a href="/biko/Edit.jsp?page=Home">bearbeiten</a></li>
 </ul>
</div>
</div></body></html>`;

const ATTACH_INDEX_HTML = `
<html><body>
<table class="wikitable">
 <tr><th>Datei</th><th>Größe</th><th>Autor</th><th>Datum</th></tr>
 <tr>
  <td><a href="/biko/attach/Kaffeeautomat/Anleitung.pdf">Anleitung.pdf</a></td>
  <td>1.4 MB</td><td>JuergenBickel</td><td>12.03.2014 18:22</td>
 </tr>
 <tr>
  <td><a href="/biko/attach/HausNeuhausen/DSC_0042.tif">DSC_0042.tif</a></td>
  <td>84.2 MB</td><td>JuergenBickel</td><td>04.07.2015</td>
 </tr>
 <tr>
  <td><a href="/biko/attach/L19/Grundriss%20EG.dxf">Grundriss EG.dxf</a></td>
  <td>612.0 kB</td><td>Planer</td><td>28.01.2013</td>
 </tr>
 <tr>
  <td><a href="/biko/attach/Passw%C3%B6rter/geheim.pdf">geheim.pdf</a></td>
  <td>4.0 kB</td><td>JuergenBickel</td><td>01.01.2012</td>
 </tr>
</table>
</body></html>`;

const EDIT_HTML = `
<html><body>
<form action="/biko/Edit.jsp?page=Kaffeeautomat" method="post">
<textarea id="editorarea" name="_editedtext" rows="25">!!!Kaffeeautomat

Modell __Jura E8__, gekauft 2013.

* Entkalken alle zwei Monate
* Wasserfilter j&auml;hrlich

[Anleitung.pdf]
Siehe auch [HausNeuhausen].
&lt;nicht HTML&gt;</textarea>
</form>
</body></html>`;

const VIEW_HTML = `
<html><body>
<div class="pagecontent"><h1>Kaffeeautomat</h1><p>Modell <b>Jura E8</b>, gekauft 2013.</p></div>
<div class="wikiversion">
 Diese Seite wurde zuletzt geändert am 12.03.2014 18:22 von JuergenBickel.
</div>
</body></html>`;

const LOGIN_HTML = `
<form action="/biko/Login.jsp?redirect=Home" method="post">
 <input type="text" name="j_username" /><input type="password" name="j_password" />
</form>`;

// ── Tests ───────────────────────────────────────────────────────────────────

describe('decodeHtmlEntities', () => {
  test('benannte und numerische Entities', () => {
    expect(decodeHtmlEntities('Gr&ouml;&szlig;e &amp; Ma&szlig;')).toBe('Größe & Maß');
    expect(decodeHtmlEntities('&#8364; &#x20AC;')).toBe('€ €');
  });

  test('unbekannte Entity bleibt stehen', () => {
    expect(decodeHtmlEntities('&unbekannt;')).toBe('&unbekannt;');
  });
});

describe('stripTags', () => {
  test('entfernt Tags und normalisiert Leerraum', () => {
    expect(stripTags('<p>Hallo   <b>Welt</b></p>')).toBe('Hallo Welt');
  });
});

describe('parsePageIndex', () => {
  const pages = parsePageIndex(INDEX_HTML);

  test('findet Seiten in beiden Link-Formen', () => {
    expect(pages).toContain('Home');
    expect(pages).toContain('HausNeuhausen');
    expect(pages).toContain('Kaffeeautomat');
    expect(pages).toContain('L19');
  });

  test('dekodiert Umlaute im Seitennamen', () => {
    expect(pages).toContain('Passwörter');
  });

  test('verwirft Anhang- und Aktionslinks', () => {
    expect(pages.some((p) => p.includes('/'))).toBe(false);
    expect(pages.some((p) => p.endsWith('.jsp'))).toBe(false);
  });

  test('Ergebnis ist dedupliziert und sortiert', () => {
    expect(new Set(pages).size).toBe(pages.length);
    expect([...pages]).toEqual([...pages].sort((a, b) => a.localeCompare(b, 'de')));
  });

  test('anderer Wiki-Pfad wird berücksichtigt', () => {
    const other = parsePageIndex('<a href="/mywiki/wiki/Seite">Seite</a>', '/mywiki');
    expect(other).toEqual(['Seite']);
  });
});

describe('parseSizeText', () => {
  test('rechnet Einheiten in Byte um', () => {
    expect(parseSizeText('1.4 MB')).toBe(Math.round(1.4 * 1024 * 1024));
    expect(parseSizeText('612.0 kB')).toBe(612 * 1024);
    expect(parseSizeText('900 bytes')).toBe(900);
  });

  test('deutsches Dezimalkomma', () => {
    expect(parseSizeText('1,5 MB')).toBe(Math.round(1.5 * 1024 * 1024));
  });

  test('ohne Größenangabe null', () => {
    expect(parseSizeText('JuergenBickel')).toBeNull();
  });
});

describe('parseAttachmentIndex', () => {
  const entries = parseAttachmentIndex(ATTACH_INDEX_HTML);

  test('findet alle Anhänge mit Seitenzuordnung', () => {
    expect(entries.length).toBe(4);
    const byFile = new Map(entries.map((e) => [e.filename, e]));
    expect(byFile.get('Anleitung.pdf')?.pageName).toBe('Kaffeeautomat');
    expect(byFile.get('DSC_0042.tif')?.pageName).toBe('HausNeuhausen');
  });

  test('dekodiert Leerzeichen und Umlaute in Namen', () => {
    const dxf = entries.find((e) => e.filename === 'Grundriss EG.dxf');
    expect(dxf).toBeDefined();
    expect(dxf?.pageName).toBe('L19');
    const secret = entries.find((e) => e.pageName === 'Passwörter');
    expect(secret?.filename).toBe('geheim.pdf');
  });

  test('liest Größe, Autor und Datum aus der Tabellenzeile', () => {
    const pdf = entries.find((e) => e.filename === 'Anleitung.pdf');
    expect(pdf?.size).toBe(Math.round(1.4 * 1024 * 1024));
    expect(pdf?.author).toBe('JuergenBickel');
    expect(pdf?.dateText).toBe('12.03.2014 18:22');
  });

  test('ohne Tabellenkontext bleiben Zusatzfelder null', () => {
    const bare = parseAttachmentIndex('<a href="/biko/attach/Seite/datei.pdf">datei.pdf</a>');
    expect(bare.length).toBe(1);
    expect(bare[0].size).toBeNull();
    expect(bare[0].author).toBeNull();
  });
});

describe('extractRawMarkup', () => {
  test('liest den Editor-Inhalt und löst Entities auf', () => {
    const markup = extractRawMarkup(EDIT_HTML);
    expect(markup).not.toBeNull();
    expect(markup).toContain('!!!Kaffeeautomat');
    expect(markup).toContain('__Jura E8__');
    expect(markup).toContain('Wasserfilter jährlich');
    expect(markup).toContain('<nicht HTML>');
  });

  test('ohne Textarea null', () => {
    expect(extractRawMarkup('<html><body>nichts</body></html>')).toBeNull();
  });
});

describe('parsePageMeta', () => {
  test('liest Datum und Autor aus dem Seitenfuß', () => {
    const meta = parsePageMeta(VIEW_HTML);
    expect(meta.dateText).toBe('12.03.2014 18:22');
    expect(meta.author).toBe('JuergenBickel');
  });

  test('ohne Angaben bleiben die Felder null', () => {
    const meta = parsePageMeta('<html><body>nur Text</body></html>');
    expect(meta.author).toBeNull();
    expect(meta.dateText).toBeNull();
  });
});

describe('extractRenderedContent', () => {
  test('liefert den Text des Inhaltsbereichs', () => {
    const text = extractRenderedContent(VIEW_HTML);
    expect(text).toContain('Kaffeeautomat');
    expect(text).toContain('Jura E8');
    expect(text).not.toContain('<b>');
  });
});

describe('looksLikeLoginPage', () => {
  test('erkennt die Anmeldemaske', () => {
    expect(looksLikeLoginPage(LOGIN_HTML)).toBe(true);
  });

  test('normale Seite ist keine Anmeldemaske', () => {
    expect(looksLikeLoginPage(VIEW_HTML)).toBe(false);
  });
});

describe('skipReason', () => {
  test('Passwortseiten werden mit Stop-Condition begründet übersprungen', () => {
    expect(skipReason('PW', null)).toContain('Passwortseite');
    expect(skipReason('Passwörter', null)).toContain('Passwortseite');
    expect(skipReason('PasswortÄndern', null)).toContain('Passwortseite');
  });

  test('Systemseiten werden übersprungen', () => {
    expect(skipReason('Index', null)).toBe('Systemseite');
    expect(skipReason('LeftMenu', null)).toBe('Systemseite');
    expect(skipReason('AnhangIndex', null)).toBe('Systemseite');
  });

  test('leere Seiten werden übersprungen', () => {
    expect(skipReason('Irgendwas', '')).toBe('leer');
    expect(skipReason('Irgendwas', '   \n ')).toBe('leer');
  });

  test('Inhaltsseite wird nicht übersprungen', () => {
    expect(skipReason('Kaffeeautomat', '!!!Kaffeeautomat\nModell Jura E8')).toBeNull();
  });

  test('vor dem Laden entscheidbar (markup = null)', () => {
    expect(skipReason('Kaffeeautomat', null)).toBeNull();
  });
});

describe('Listen aus dem Auftrag', () => {
  test('alle im Auftrag genannten Systemseiten sind erfasst', () => {
    for (const name of [
      'AnhangIndex', 'Index', 'EditPageHelp', 'InterwikiLink', 'LeftMenu',
      'LeftMenuFooter', 'LeftMenuLogo', 'LetzteÄnderungen', 'Sandkasten',
      'Standardseite', 'Stub', 'SystemInfo', 'Textformatierungsregel',
      'UndefinierteSeite', 'UnreferenzierteSeite', 'WikiEtikette',
      'WikiInEinerMinute', 'CustomEditorial', 'Editorial', 'JuwiSkin',
      'JuwiAccessLog', 'Talk', 'PDFExport',
    ]) {
      expect(SYSTEM_PAGES.has(name)).toBe(true);
    }
  });

  test('alle im Auftrag genannten Passwortseiten sind erfasst', () => {
    for (const name of ['PW', 'Passwörter', 'PasswortÄndern']) {
      expect(PASSWORD_PAGES.has(name)).toBe(true);
    }
  });
});
