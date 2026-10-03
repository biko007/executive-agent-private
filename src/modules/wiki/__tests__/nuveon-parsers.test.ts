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
  extractRenderedContent, looksLikeLoginPage, looksLikeMissingPage, skipReason,
  parseSizeText, parseAttachmentInfo,
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
  test('rechnet DEZIMAL um — so wie JSPWiki', () => {
    // JSPWiki meldet kB als 1000 Byte, nicht 1024. Am echten Bestand
    // gegengeprüft (2026-10-03): Tools.zip meldet „1532.6 kB" bei exakt
    // 1.532.597 Byte Content-Length, Biko-Haus-2729.tif „126183.7 kB" bei
    // 126.183.728 Byte. Mit dem Faktor 1024 lägen alle Vergleiche um 2,4 %
    // daneben und der Größenabgleich wäre wertlos.
    expect(parseSizeText('1.4 MB')).toBe(1_400_000);
    expect(parseSizeText('612.0 kB')).toBe(612_000);
    expect(parseSizeText('900 bytes')).toBe(900);
  });

  test('die gemessenen Werte aus dem echten Bestand', () => {
    // Beide Angaben stammen aus den Infoseiten des Quellwikis, die exakten
    // Bytezahlen aus der Content-Length-Kopfzeile derselben Dateien.
    expect(parseSizeText('1532.6 kB')).toBe(1_532_600);
    expect(Math.abs(1_532_600 - 1_532_597)).toBeLessThanOrEqual(100);
    expect(parseSizeText('126183.7 kB')).toBe(126_183_700);
    expect(Math.abs(126_183_700 - 126_183_728)).toBeLessThanOrEqual(100);
  });

  test('geschütztes Leerzeichen zwischen Zahl und Einheit', () => {
    // JSPWiki schreibt "1532.6&nbsp;kB"; nach dem Auflösen der Entity steht
    // dort U+00A0, das kein normales \s ist.
    expect(parseSizeText('1532.6\u00a0kB')).toBe(1_532_600);
  });

  test('Binärformen werden binär gerechnet', () => {
    expect(parseSizeText('1 KiB')).toBe(1024);
    expect(parseSizeText('1 MiB')).toBe(1024 * 1024);
  });

  test('deutsches Dezimalkomma', () => {
    expect(parseSizeText('1,5 MB')).toBe(1_500_000);
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
    expect(pdf?.size).toBe(1_400_000);
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

describe('parseAttachmentInfo — Metadaten der Anhang-Infoseite', () => {
  /**
   * Nachbildung der Infoseite von JSPWiki 2.8. Entscheidend: VOR der
   * gesuchten Tabelle steht die Upload-Maske, die das Wort „Size" ebenfalls
   * enthält. Ein Regex, der nur nach „Size" im Tabellenrumpf sucht, greift
   * die falsche Tabelle — am echten Bestand blieben deshalb alle 139
   * Größenabgleiche leer.
   */
  const INFO_HTML = `
<div id="pagecontent">
  <table class="formtable">
    <tr><td>Select file:</td><td>Max Size 10 MB</td></tr>
  </table>
  <table class="wikitable">
    <tr><th>Kind</th><th>Version</th><th>Size</th><th>Date Modified</th><th>Author</th><th>Change note</th></tr>
    <tr><td>zip</td><td>1</td><td>1532.6&nbsp;kB</td><td>12-Oct-2013 09:36</td><td>JuergenBickel</td><td>Hinweis</td></tr>
  </table>
</div>`;

  test('liest Größe, Autor, Datum und Version', () => {
    const info = parseAttachmentInfo(INFO_HTML);
    expect(info.size).toBe(1_532_600);
    expect(info.sizeText).toBe('1532.6 kB');
    expect(info.author).toBe('JuergenBickel');
    expect(info.dateText).toBe('12-Oct-2013 09:36');
    expect(info.version).toBe(1);
  });

  test('nimmt NICHT die Upload-Maske, auch wenn sie "Size" enthält', () => {
    const info = parseAttachmentInfo(INFO_HTML);
    expect(info.size).not.toBe(10);
    expect(info.author).toBe('JuergenBickel');
  });

  test('ohne passende Tabelle leere Felder, kein Fehler', () => {
    const info = parseAttachmentInfo('<html><body>nichts</body></html>');
    expect(info).toEqual({ size: null, sizeText: null, author: null, dateText: null, version: null });
  });
});

describe('looksLikeMissingPage', () => {
  test('erkennt den Hinweis auf eine nicht angelegte Seite', () => {
    // Der Seitenindex führt auch verwaiste Linkziele. JSPWiki antwortet dort
    // mit HTTP 200 und diesem Hinweis — am echten Bestand traf das Talk.Index.
    expect(looksLikeMissingPage('This page does not exist. Why don\u2019t you go and create it ?')).toBe(true);
    expect(looksLikeMissingPage('Diese Seite existiert nicht')).toBe(true);
  });

  test('normale Seite ist nicht betroffen', () => {
    expect(looksLikeMissingPage('Modell Jura E8, gekauft 2013.')).toBe(false);
  });

  test('skipReason überspringt verwaiste Ziele', () => {
    expect(skipReason('Talk.Index', 'This page does not exist. Similar pages:'))
      .toContain('existiert nicht');
  });
});

describe('extractRawMarkup — das richtige textarea', () => {
  /**
   * Die Editor-Seite führt drei textarea-Elemente. Nur `name="_editedtext"`
   * trägt den Seiteninhalt; das erste (`lastEditText`) ist bei den meisten
   * Seiten leer. Am echten Bestand fielen deshalb 41 von 57 Seiten in den
   * HTML-Fallback und wären als Fließtext statt als Markup importiert worden.
   */
  const EDIT_DREI = `
<textarea id="lastEditText" style="display: none;"></textarea>
<textarea name="previewText" id="previewText" style="display:none;"></textarea>
<textarea id="pagetext" name="_editedtext" style="display:none;">== Aloha!

Das ist der echte Inhalt mit [[Link|Text]].</textarea>`;

  test('nimmt das Inhaltsfeld, nicht das erste textarea', () => {
    const markup = extractRawMarkup(EDIT_DREI);
    expect(markup).toContain('== Aloha!');
    expect(markup).toContain('[[Link|Text]]');
  });

  test('Rückfall auf das inhaltsreichste textarea bei abweichendem Skin', () => {
    const markup = extractRawMarkup(
      '<textarea id="a"></textarea><textarea id="b">Viel mehr Inhalt hier drin.</textarea>');
    expect(markup).toBe('Viel mehr Inhalt hier drin.');
  });

  test('alle textarea leer ergibt null', () => {
    expect(extractRawMarkup('<textarea id="a"></textarea><textarea id="b">   </textarea>')).toBeNull();
  });
});

describe('extractRenderedContent — Skin-Beiwerk entfernen', () => {
  test('das Upload-Formular zählt nicht als Seiteninhalt', () => {
    // Ohne diese Bereinigung sahen die vier leeren Seiten Airbnb, Fewo, Pic
    // und Trivago nach Inhalt aus und wären importiert worden.
    const html = `<div id="pagecontent">
      <div id="addattachment"><h3>Add new attachment</h3>
      <form action="/biko/attach"><input type="file"></form>
      In order to upload a new attachment to this page, please use the following box.
      </div></div>`;
    expect(extractRenderedContent(html).trim()).toBe('');
  });

  test('echter Inhalt bleibt erhalten', () => {
    const html = '<div id="pagecontent"><p>Modell <b>Jura E8</b>.</p>'
      + '<div id="addattachment">Add new attachment</div></div>';
    const text = extractRenderedContent(html);
    expect(text).toContain('Jura E8');
    expect(text).not.toContain('Add new attachment');
  });
});
