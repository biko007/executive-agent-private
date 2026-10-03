/**
 * Konverter-Tests — JSPWiki-Markup → Markdown.
 *
 * Reine Funktionen, keine Datenbank. Goldfile-Charakter: die erwarteten
 * Ergebnisse stehen im Test, damit eine Änderung am Konverter sofort auffällt.
 */
import { describe, expect, test } from 'bun:test';
import {
  convertJspWikiToMarkdown, slugify, normalizePageName, titleFromPageName,
  deriveCategory, detectSensitive,
} from '../convert.js';

const baseOpts = { pageName: 'TestSeite', pageSlug: 'test-seite' };

describe('slugify', () => {
  test('Umlaute werden umgeschrieben', () => {
    expect(slugify('Passwörter')).toBe('passwoerter');
    expect(slugify('Größe Änderung')).toBe('groesse-aenderung');
  });

  test('CamelCase wird aufgetrennt', () => {
    expect(slugify('HausNeuhausen')).toBe('haus-neuhausen');
    expect(slugify('KaffeeautomatEntkalken')).toBe('kaffeeautomat-entkalken');
  });

  test('Sonderzeichen und Schrägstriche werden zu Bindestrichen', () => {
    expect(slugify('Haus Neuhausen/Heizung')).toBe('haus-neuhausen-heizung');
    expect(slugify('L19.de (Pläne)')).toBe('l19-de-plaene');
  });

  test('leerer oder unbrauchbarer Name ergibt Ersatzslug', () => {
    expect(slugify('')).toBe('seite');
    expect(slugify('---')).toBe('seite');
  });

  test('Slug endet nie auf einem Bindestrich', () => {
    const long = slugify('A'.repeat(60) + ' - ' + 'B'.repeat(60));
    expect(long.endsWith('-')).toBe(false);
    expect(long.length).toBeLessThanOrEqual(80);
  });
});

describe('titleFromPageName', () => {
  test('CamelCase wird lesbar', () => {
    expect(titleFromPageName('HausNeuhausen')).toBe('Haus Neuhausen');
  });

  test('Namen mit Leerzeichen bleiben unverändert', () => {
    expect(titleFromPageName('Haus Neuhausen')).toBe('Haus Neuhausen');
  });
});

describe('Überschriften', () => {
  test('!!! wird H1, !! wird H2, ! wird H3', () => {
    const { markdown } = convertJspWikiToMarkdown(
      '!!!Titel\n!!Abschnitt\n!Unterabschnitt',
      baseOpts,
    );
    expect(markdown).toBe('# Titel\n## Abschnitt\n### Unterabschnitt');
  });
});

describe('Inline-Auszeichnung', () => {
  test('fett und kursiv', () => {
    const { markdown } = convertJspWikiToMarkdown(
      "Das ist __fett__ und das ''kursiv''.",
      baseOpts,
    );
    expect(markdown).toBe('Das ist **fett** und das *kursiv*.');
  });

  test('Zeilenumbruch mit doppeltem Backslash', () => {
    const { markdown } = convertJspWikiToMarkdown('Zeile eins\\\\Zeile zwei', baseOpts);
    expect(markdown).toBe('Zeile eins  \nZeile zwei');
  });

  test('Trennlinie', () => {
    const { markdown } = convertJspWikiToMarkdown('oben\n----\nunten', baseOpts);
    expect(markdown).toBe('oben\n---\nunten');
  });
});

describe('Listen', () => {
  test('unsortierte Liste — ein Stern je Eintrag', () => {
    const { markdown } = convertJspWikiToMarkdown('* eins\n* zwei\n* drei', baseOpts);
    expect(markdown).toBe('- eins\n- zwei\n- drei');
  });

  test('** am Zeilenanfang ist Fettschrift, KEINE zweite Listenebene', () => {
    // Festlegung nach dem, was JSPWiki ausliefert: an der echten Seite
    // „Bedienungsanleitungen" rendert `**Miele Hausgeräte:` als <b>…</b>.
    // Die Creole-Spezifikation würde `**` als Listenebene 2 lesen — dieses
    // JSPWiki tut das nicht, und maßgeblich ist, was der Eigentümer sah.
    const { markdown } = convertJspWikiToMarkdown('**Miele Hausgeräte:', baseOpts);
    expect(markdown).toBe('**Miele Hausgeräte:**');
  });

  test('** mit Leerzeichen: die Markierung rückt an das Wort', () => {
    // `** Andere Hausgeräte` → JSPWiki: <b> Andere Hausgeräte</b>.
    // In Markdown darf hinter der öffnenden Markierung kein Leerzeichen
    // stehen, sonst erscheinen die Sterne wörtlich. Das Leerzeichen wandert
    // davor; am Textrand wird es beim Abschluss-Trimmen entfernt, mitten im
    // Dokument bleibt es erhalten.
    const einzeilig = convertJspWikiToMarkdown('** Andere Hausgeräte', baseOpts);
    expect(einzeilig.markdown).toBe('**Andere Hausgeräte**');
    expect(einzeilig.markdown).not.toContain('** ');

    const imText = convertJspWikiToMarkdown('Davor\n** Andere Hausgeräte\nDanach', baseOpts);
    expect(imText.markdown).toBe('Davor\n **Andere Hausgeräte**\nDanach');
  });

  test('leeres Fett-Paar entfällt, wie bei JSPWiki', () => {
    // `****Pflanzliste:` → JSPWiki: <b></b>Pflanzliste: — also normaler Text.
    const { markdown } = convertJspWikiToMarkdown('****Pflanzliste:', baseOpts);
    expect(markdown).toBe('Pflanzliste:');
  });

  test('geschlossene Fettschrift bleibt unverändert', () => {
    const { markdown } = convertJspWikiToMarkdown('Das ist **fett** im Satz.', baseOpts);
    expect(markdown).toBe('Das ist **fett** im Satz.');
  });

  test('sortierte Liste', () => {
    const { markdown } = convertJspWikiToMarkdown('# erster\n# zweiter', baseOpts);
    expect(markdown).toBe('1. erster\n1. zweiter');
  });
});

describe('Tabellen', () => {
  test('Creole-Kopfzeile mit |= wird zur Markdown-Kopfzeile', () => {
    const { markdown } = convertJspWikiToMarkdown(
      '|=Gerät|=Baujahr|\n|Heizung|2011|\n|Sauna|2014|',
      baseOpts,
    );
    expect(markdown).toBe(
      '| Gerät | Baujahr |\n| --- | --- |\n| Heizung | 2011 |\n| Sauna | 2014 |',
    );
  });

  test('Tabelle ohne |= behält eine LEERE Kopfzeile', () => {
    // JSPWiki rendert dort durchgehend <td>, nie <th>. Die erste Zeile zur
    // Kopfzeile zu erklären wäre bei Beschriftungstabellen wie
    // „Gruppenadresse | Datei.pdf" sachlich falsch; Markdown verlangt aber
    // eine Kopfzeile. Sie bleibt daher leer und wird im Dashboard ausgeblendet.
    const { markdown } = convertJspWikiToMarkdown('|a|b|\n|c|d|', baseOpts);
    const zeilen = markdown.split('\n');
    expect(zeilen[0]).toBe('|  |  |');
    expect(zeilen[1]).toBe('| --- | --- |');
    expect(zeilen[2]).toBe('| a | b |');
    expect(zeilen[3]).toBe('| c | d |');
  });

  test('Tabelle aus dem echten Bestand (IPAdressen-Form)', () => {
    const { markdown } = convertJspWikiToMarkdown(
      '|IP Adresse| Name| Gerät|\n|192.168.1.012|biko8srv| Dell Server|',
      baseOpts,
    );
    expect(markdown).toContain('| IP Adresse | Name | Gerät |');
    expect(markdown).toContain('| 192.168.1.012 | biko8srv | Dell Server |');
  });
});

describe('Links', () => {
  test('externer Link', () => {
    const { markdown } = convertJspWikiToMarkdown(
      '[Hersteller|https://example.com/geraet]',
      baseOpts,
    );
    expect(markdown).toBe('[Hersteller](https://example.com/geraet)');
  });

  test('interner Link mit Text', () => {
    const { markdown } = convertJspWikiToMarkdown('[Die Heizung|HausHeizung]', baseOpts);
    expect(markdown).toBe('[Die Heizung](/dashboard/wiki/haus-heizung)');
  });

  test('interner Link ohne Text', () => {
    const { markdown } = convertJspWikiToMarkdown('[HausHeizung]', baseOpts);
    expect(markdown).toBe('[HausHeizung](/dashboard/wiki/haus-heizung)');
  });

  test('Anhang-Link zeigt auf die Wiki-Anhang-URL', () => {
    const { markdown } = convertJspWikiToMarkdown('[Anleitung.pdf]', {
      ...baseOpts,
      attachmentNames: ['Anleitung.pdf'],
    });
    expect(markdown).toBe('[Anleitung.pdf](/dashboard/api/wiki/file/test-seite/Anleitung.pdf)');
  });

  test('Anhang-Link mit Seitenpräfix und eigenem Text', () => {
    const { markdown } = convertJspWikiToMarkdown('[Handbuch|TestSeite/Anleitung.pdf]', {
      ...baseOpts,
      attachmentNames: ['Anleitung.pdf'],
    });
    expect(markdown).toBe('[Handbuch](/dashboard/api/wiki/file/test-seite/Anleitung.pdf)');
  });

  test('Dateinamen mit Leerzeichen werden URL-kodiert', () => {
    const { markdown } = convertJspWikiToMarkdown('[Mein Plan.dxf]', {
      ...baseOpts,
      attachmentNames: ['Mein Plan.dxf'],
    });
    expect(markdown).toContain('Mein%20Plan.dxf');
  });

  test('slugForPage wird für interne Ziele verwendet', () => {
    const { markdown } = convertJspWikiToMarkdown('[Ziel]', {
      ...baseOpts,
      slugForPage: () => 'fester-slug',
    });
    expect(markdown).toBe('[Ziel](/dashboard/wiki/fester-slug)');
  });
});

describe('Code und Plugins', () => {
  test('mehrzeiliger Code wird eingezäunt', () => {
    const { markdown } = convertJspWikiToMarkdown(
      'Vorher\n{{{\nzeile1\nzeile2\n}}}\nNachher',
      baseOpts,
    );
    expect(markdown).toContain('```\nzeile1\nzeile2\n```');
  });

  test('Markup innerhalb von Code bleibt unangetastet', () => {
    const { markdown } = convertJspWikiToMarkdown(
      '{{{\n__nicht fett__ und [kein|Link]\n}}}',
      baseOpts,
    );
    expect(markdown).toContain('__nicht fett__');
    expect(markdown).toContain('[kein|Link]');
  });

  test('einzeiliger Code wird Inline-Code', () => {
    const { markdown } = convertJspWikiToMarkdown('Befehl {{{ls -la}}} ausführen', baseOpts);
    expect(markdown).toContain('`ls -la`');
  });

  test('Plugins werden entfernt und gezählt', () => {
    const { markdown, removedPlugins } = convertJspWikiToMarkdown(
      'Oben\n[{TableOfContents}]\nUnten\n[{Image src=\'foto.jpg\'}]',
      baseOpts,
    );
    expect(markdown).not.toContain('TableOfContents');
    expect(markdown).not.toContain('Image src');
    expect(removedPlugins).toEqual(['TableOfContents', 'Image']);
  });
});

describe('deriveCategory', () => {
  test('L19 aus dem Titel', () => {
    expect(deriveCategory('L19 Pläne', '')).toBe('L19');
  });

  test('Haus Neuhausen aus dem Titel', () => {
    expect(deriveCategory('Heizung Neuhausen', '')).toBe('Haus Neuhausen');
  });

  test('Technik aus dem Inhalt, wenn der Titel nichts hergibt', () => {
    expect(deriveCategory('Notizen', 'Der KNX-Aktor im Verteiler')).toBe('Technik');
  });

  test('Accounts & Dienste', () => {
    expect(deriveCategory('Vertrag Telefon', '')).toBe('Accounts & Dienste');
  });

  test('ohne Treffer bleibt Sonstiges', () => {
    expect(deriveCategory('Irgendwas', 'ganz normaler Text')).toBe('Sonstiges');
  });
});

describe('detectSensitive', () => {
  test('erkennt Passwort im Inhalt', () => {
    expect(detectSensitive('Router', 'Das Passwort lautet geheim')).toBe(true);
  });

  test('erkennt PIN, WLAN-Schlüssel, IBAN und API-Key', () => {
    expect(detectSensitive('Karte', 'PIN 1234')).toBe(true);
    expect(detectSensitive('Netz', 'WLAN-Schlüssel steht am Router')).toBe(true);
    expect(detectSensitive('Bank', 'IBAN DE00 0000')).toBe(true);
    expect(detectSensitive('Dienst', 'API-Key im Portal')).toBe(true);
  });

  test('erkennt Muster auch nur im Titel', () => {
    expect(detectSensitive('Zugangsdaten Kamera', 'nichts weiter')).toBe(true);
  });

  test('harmlose Seite wird nicht markiert', () => {
    expect(detectSensitive(
      'Kaffeeautomat',
      'Entkalken alle zwei Monate mit dem beiliegenden Mittel.',
    )).toBe(false);
  });
});

describe('Gesamtbeispiel', () => {
  test('typische Seite wird vollständig übersetzt', () => {
    const markup = [
      '!!!Heizung Neuhausen',
      '',
      "Die Anlage ist von __Viessmann__, Baujahr ''2011''.",
      '',
      '!!Wartung',
      '* Filter jährlich',
      '* Wasserdruck monatlich',
      '',
      '!!Unterlagen',
      '[Bedienungsanleitung|Heizung.pdf]',
      '',
      '[{TableOfContents}]',
      '----',
      'Siehe auch [HausNeuhausen].',
    ].join('\n');

    const { markdown, removedPlugins } = convertJspWikiToMarkdown(markup, {
      pageName: 'HeizungNeuhausen',
      pageSlug: 'heizung-neuhausen',
      attachmentNames: ['Heizung.pdf'],
    });

    expect(markdown).toContain('# Heizung Neuhausen');
    expect(markdown).toContain('**Viessmann**');
    expect(markdown).toContain('*2011*');
    expect(markdown).toContain('## Wartung');
    expect(markdown).toContain('- Filter jährlich');
    expect(markdown).toContain(
      '[Bedienungsanleitung](/dashboard/api/wiki/file/heizung-neuhausen/Heizung.pdf)',
    );
    expect(markdown).toContain('[HausNeuhausen](/dashboard/wiki/haus-neuhausen)');
    expect(markdown).toContain('---');
    expect(removedPlugins).toEqual(['TableOfContents']);
  });
});

describe('Creole — der Dialekt des echten Quellwikis', () => {
  test('[[Ziel|Text]] — das ZIEL steht vorn (Gegenteil von klassisch)', () => {
    // Der folgenschwerste Unterschied: klassisches JSPWiki schreibt
    // [Text|Ziel], Creole [[Ziel|Text]]. Eine Verwechslung dreht jeden Link um.
    const { markdown } = convertJspWikiToMarkdown('[[HausHeizung|Die Heizung]]', baseOpts);
    expect(markdown).toBe('[Die Heizung](/dashboard/wiki/haus-heizung)');
  });

  test('[[Ziel]] ohne Text', () => {
    const { markdown } = convertJspWikiToMarkdown('[[HausHeizung]]', baseOpts);
    expect(markdown).toBe('[HausHeizung](/dashboard/wiki/haus-heizung)');
  });

  test('[[http://…]] bleibt externer Link', () => {
    const { markdown } = convertJspWikiToMarkdown(
      '[[http://www.pukshofer.com/Firma/download.htm]]', baseOpts);
    expect(markdown).toBe(
      '[http://www.pukshofer.com/Firma/download.htm](http://www.pukshofer.com/Firma/download.htm)');
  });

  test('Creole-Anhang mit Text — aus der echten Seite Segways', () => {
    const { markdown } = convertJspWikiToMarkdown(
      '[[Bedienungsanleitung Lademanager V1.3.pdf|Lademanager]]',
      { ...baseOpts, attachmentNames: ['Bedienungsanleitung Lademanager V1.3.pdf'] },
    );
    expect(markdown).toContain('[Lademanager](/dashboard/api/wiki/file/test-seite/');
    expect(markdown).toContain('Lademanager%20V1.3.pdf)');
  });

  test('Creole-Überschriften = bis ====', () => {
    const { markdown } = convertJspWikiToMarkdown(
      '= Eins\n== Zwei\n=== Drei\n==== Vier', baseOpts);
    expect(markdown).toBe('# Eins\n## Zwei\n### Drei\n#### Vier');
  });

  test('schließende Gleichheitszeichen sind zulässig', () => {
    const { markdown } = convertJspWikiToMarkdown('== Abschnitt ==', baseOpts);
    expect(markdown).toBe('## Abschnitt');
  });

  test('Creole-Kursiv // — aber nicht in URLs', () => {
    const { markdown } = convertJspWikiToMarkdown(
      'Das ist //kursiv// und [[http://example.com/x]] bleibt heil.', baseOpts);
    expect(markdown).toContain('*kursiv*');
    expect(markdown).toContain('http://example.com/x');
    expect(markdown).not.toContain('http:*');
  });

  test('Creole-Plugins <<…>> werden entfernt und gezählt', () => {
    const { markdown, removedPlugins } = convertJspWikiToMarkdown(
      'Oben\n<<ReferringPagesPlugin max=10>>\nUnten', baseOpts);
    expect(markdown).not.toContain('ReferringPages');
    expect(removedPlugins).toEqual(['ReferringPagesPlugin']);
  });

  test('Creole-Variable <<$name>> wird entfernt, Fettschrift bleibt heil', () => {
    // Echte Stelle von der Startseite: `**<<$totalpages>> Seiten**`.
    // Ohne Mitnahme des Leerzeichens entstünde `** Seiten**` — in Markdown
    // keine Fettschrift, sondern vier sichtbare Sterne.
    const { markdown, removedPlugins } = convertJspWikiToMarkdown(
      'Dieses Wiki umfasst inzwischen **<<$totalpages>> Seiten**', baseOpts);
    expect(removedPlugins).toEqual(['totalpages']);
    expect(markdown).toBe('Dieses Wiki umfasst inzwischen **Seiten**');
  });

  test('Stilblöcke %%name … %% entfallen, der Inhalt bleibt', () => {
    // Die Markierungszeile wird geleert, nicht gelöscht — es bleibt eine
    // Leerzeile, also ein Absatzwechsel. Das entspricht der Gliederung, die
    // der Block im Original hatte, und ist in Markdown gültig.
    const { markdown } = convertJspWikiToMarkdown(
      '%%commentbox\nEin Hinweis.\n%%\nDanach.', baseOpts);
    expect(markdown).toBe('Ein Hinweis.\n\nDanach.');
    expect(markdown).not.toContain('%%');
    expect(markdown).not.toContain('commentbox');
  });

  test('Stilblock mit /% als Abschluss', () => {
    const { markdown } = convertJspWikiToMarkdown(
      '%%information\nText.\n/%\nDanach.', baseOpts);
    expect(markdown).toBe('Text.\n\nDanach.');
    expect(markdown).not.toContain('/%');
  });

  test('Creole-Bild {{datei}}', () => {
    const { markdown } = convertJspWikiToMarkdown('{{Sonnenaufgang.jpg}}', {
      ...baseOpts, attachmentNames: ['Sonnenaufgang.jpg'],
    });
    expect(markdown).toBe(
      '![Sonnenaufgang.jpg](/dashboard/api/wiki/preview/test-seite/Sonnenaufgang.jpg)');
  });

  test('Textklammern wie [1] bleiben Text, werden nicht zu Links', () => {
    // Auf der Kurzreferenz des Wikis stehen [1]…[6] als Fußnotenmarken.
    const { markdown } = convertJspWikiToMarkdown('Siehe [1] und [2].', baseOpts);
    expect(markdown).toBe('Siehe [1] und [2].');
  });
});

describe('normalizePageName — Auflösung wie bei JSPWiki', () => {
  test('Leerzeichen und Schreibweise sind unerheblich', () => {
    expect(normalizePageName('IP Adressen L19')).toBe(normalizePageName('IPAdressenL19'));
    expect(normalizePageName('ip_adressen_l19')).toBe(normalizePageName('IPAdressenL19'));
  });

  test('verschiedene Seiten bleiben unterscheidbar', () => {
    expect(normalizePageName('IPAdressen')).not.toBe(normalizePageName('IPAdressenL19'));
  });
});

describe('resolvePage — Links nur auf vorhandene Seiten', () => {
  test('vorhandene Seite wird verlinkt', () => {
    const { markdown } = convertJspWikiToMarkdown('[[IP Adressen L19]]', {
      ...baseOpts,
      resolvePage: (n) => (normalizePageName(n) === 'ipadressenl19' ? 'ipadressen-l19' : null),
    });
    expect(markdown).toBe('[IP Adressen L19](/dashboard/wiki/ipadressen-l19)');
  });

  test('nicht vorhandene Seite ergibt KEINEN Link, nur Text', () => {
    // Verweise auf Passwortseiten, Systemseiten und leere Seiten dürfen nicht
    // ins Leere führen. Am echten Bestand waren das 22 tote Links.
    const { markdown } = convertJspWikiToMarkdown('[[Passwörter|Die Kennwörter]]', {
      ...baseOpts,
      resolvePage: () => null,
    });
    expect(markdown).toBe('Die Kennwörter');
    expect(markdown).not.toContain('/dashboard/wiki/');
  });
});

describe('detectSensitive — Befund am echten Bestand', () => {
  test('Passwortspalte in einer Tabelle wird erkannt', () => {
    // Der Befund vom 2026-10-03: mehrere Seiten führen Zugangsdaten in
    // Tabellen mit der Spalte `| PW|`. Die frühere Erkennung verlangte `PW:`
    // oder `PW=` und hätte diese Seiten an den Agenten ausgeliefert.
    expect(detectSensitive('IPAdressen',
      '|IP Adresse| Name| Gerät| Port| Internet Name| User | PW|')).toBe(true);
    expect(detectSensitive('IPAdressenUndPortkonfiguration',
      '|Name/Standort |IP Adresse |Port |Type |Pw |')).toBe(true);
  });

  test('User-Spalte wird erkannt', () => {
    expect(detectSensitive('WLAN', '|IP Adresse| Name| User | Speed|')).toBe(true);
  });

  test('SSID wird erkannt', () => {
    expect(detectSensitive('Netz', 'SSID "hsh" für das Gastnetz')).toBe(true);
  });

  test('harmlose Tabelle bleibt unmarkiert', () => {
    expect(detectSensitive('Wartung', '|Teil | Intervall |\n|Filter | 2 Monate |')).toBe(false);
  });
});
