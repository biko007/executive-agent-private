/**
 * Konverter-Tests — JSPWiki-Markup → Markdown.
 *
 * Reine Funktionen, keine Datenbank. Goldfile-Charakter: die erwarteten
 * Ergebnisse stehen im Test, damit eine Änderung am Konverter sofort auffällt.
 */
import { describe, expect, test } from 'bun:test';
import {
  convertJspWikiToMarkdown, slugify, titleFromPageName,
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
  test('unsortierte Liste mit Verschachtelung', () => {
    const { markdown } = convertJspWikiToMarkdown('* eins\n** eins-a\n* zwei', baseOpts);
    expect(markdown).toBe('- eins\n  - eins-a\n- zwei');
  });

  test('sortierte Liste', () => {
    const { markdown } = convertJspWikiToMarkdown('# erster\n# zweiter', baseOpts);
    expect(markdown).toBe('1. erster\n1. zweiter');
  });
});

describe('Tabellen', () => {
  test('Kopfzeile und Datenzeilen', () => {
    const { markdown } = convertJspWikiToMarkdown(
      '||Gerät||Baujahr\n|Heizung|2011\n|Sauna|2014',
      baseOpts,
    );
    expect(markdown).toBe(
      '| Gerät | Baujahr |\n| --- | --- |\n| Heizung | 2011 |\n| Sauna | 2014 |',
    );
  });

  test('Tabelle ohne Kopfzeile erhält eine leere Kopfzeile', () => {
    const { markdown } = convertJspWikiToMarkdown('|a|b\n|c|d', baseOpts);
    expect(markdown.split('\n')[1]).toBe('| --- | --- |');
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
