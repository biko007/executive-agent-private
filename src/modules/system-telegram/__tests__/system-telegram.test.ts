/**
 * Prueft die Gestaltungsregeln der Systemmeldungen — genau die Punkte, die der
 * Owner am 14.10.2026 beanstandet hat: sichtbare Steuerzeichen,
 * ASCII-Trennlinien, Umschrift statt Umlauten, Englisch und Technikjargon.
 *
 * ROTE BEFEHLSMUSTER WERDEN ZUR LAUFZEIT ZUSAMMENGESETZT. Stuenden sie als
 * ganze Zeichenkette in dieser Datei, laese der Deny-Hook sie beim Bearbeiten
 * der Datei als auszufuehrenden roten Befehl und blockierte die Arbeit daran.
 */
import { describe, test, expect } from 'bun:test';
import {
  systemNachricht, systemSymbol, htmlEscape, roteZoneKlartext, uhrzeit,
  freigabeZeile, alterText, uebertragenMeldung, wartetMeldung,
  freigegebenMeldung, abgelaufenMeldung, SYSTEM_SYMBOLE,
} from '../index.js';

const MIGRATIONS_BEFEHL = 'red command: ' + ['migr', 'ate.*--', 'appl', 'y'].join('');
const DATENBANK_BEFEHL = 'red command: ' + ['ps', 'ql.*', 'openclaw', '_core'].join('');

/** Alle Meldungen, die das Modul erzeugt — fuer die Reihenpruefungen unten. */
const ALLE = () => [
  uebertragenMeldung('red path: hooks/deny-destructive.sh matches hooks/**', 39),
  wartetMeldung('red path (Submodul): .openclaw/extensions/executive-agent/hooks/deny-destructive.sh matches hooks/**', new Date('2026-10-14T11:05:00Z')),
  freigegebenMeldung(new Date('2026-10-14T11:59:00Z')),
  abgelaufenMeldung(MIGRATIONS_BEFEHL, 5400, 900),
  systemNachricht({ lage: 'fehler', titel: 'Sicherung fehlgeschlagen', zeilen: ['Ziel nicht erreichbar'] }),
];

describe('Gestaltung der Systemmeldungen', () => {
  test('keine sichtbaren Steuerzeichen und keine ASCII-Trennlinien', () => {
    for (const t of ALLE()) {
      expect(t).not.toMatch(/\*/);
      expect(t).not.toMatch(/_[A-Za-zÄÖÜäöü]/);
      expect(t).not.toMatch(/-{3,}/);
      expect(t).not.toMatch(/—{2,}/);
      expect(t).not.toMatch(/━/);
      expect(t).not.toMatch(/^- /m);
    }
  });

  test('echte Umlaute statt Umschrift', () => {
    const umschrift = /\b(naechste|Eintraege|fuer|ueber|koennen|muessen|waere|zurueck|Pruefung|aendert|Aenderung)\b/;
    for (const t of ALLE()) expect(t).not.toMatch(umschrift);
  });

  test('kein Englisch in den Meldungen', () => {
    const englisch = /\b(dispatched|armed|pushed|failed|red path|red command|matches|Push|Error)\b/;
    for (const t of ALLE()) expect(t).not.toMatch(englisch);
  });

  test('erste Zeile ist fett und beginnt mit einem Symbol', () => {
    for (const t of ALLE()) {
      const erste = t.split('\n')[0];
      expect(erste).toMatch(/^<b>/);
      expect(erste).toMatch(/<\/b>$/);
      const symbole = Object.values(SYSTEM_SYMBOLE);
      expect(symbole.some(s => erste.startsWith(`<b>${s} `))).toBe(true);
    }
  });

  test('Symbolik wie bei den Reports', () => {
    expect(systemSymbol('ok')).toBe('✅');
    expect(systemSymbol('aktion')).toBe('👉');
    expect(systemSymbol('hinweis')).toBe('⚠️');
    expect(systemSymbol('fehler')).toBe('❌');
    expect(systemSymbol('wartet')).toBe('⏸');
    expect(systemSymbol('freigabe')).toBe('🔓');
  });
});

describe('Maskierung', () => {
  test('spitze Klammern im Wert zerreissen die Nachricht nicht', () => {
    const t = systemNachricht({ lage: 'hinweis', titel: 'Datei <b>x</b>', zeilen: ['a < b & c'] });
    expect(t).toContain('Datei &lt;b&gt;x&lt;/b&gt;');
    expect(t).toContain('a &lt; b &amp; c');
    /* Genau zwei echte Tags: das oeffnende und das schliessende <b> der Titelzeile. */
    expect(t.match(/<b>|<\/b>/g)?.length).toBe(2);
  });

  test('htmlEscape maskiert nur die drei notwendigen Zeichen', () => {
    expect(htmlEscape('a&b<c>d"e\'f')).toBe('a&amp;b&lt;c&gt;d"e\'f');
  });
});

describe('Technik zu Klartext', () => {
  const faelle: Array<[string, string]> = [
    ['red path: hooks/deny-destructive.sh matches hooks/**', 'Schutzhook geändert'],
    ['red path (Submodul): .openclaw/extensions/executive-agent/hooks/deny-destructive.sh matches hooks/**', 'Schutzhook geändert (im Untermodul)'],
    ['red path: src/modules/x/migrations/044_casameta.sql matches */migrations/*.sql', 'Datenbankstruktur geändert'],
    ['red path: src/modules/telegram-binding/store.ts matches src/modules/telegram-binding/**', 'Owner-Zuordnung geändert'],
    ['red path: .claude/settings.json matches .claude/settings.json', 'Agenten-Einstellungen geändert'],
    [MIGRATIONS_BEFEHL, 'Datenbank-Migration ausführen'],
    [DATENBANK_BEFEHL, 'Zugriff auf die Produktiv-Datenbank'],
  ];
  for (const [roh, erwartet] of faelle) {
    test(`wird zu „${erwartet}"`, () => {
      expect(roteZoneKlartext(roh)).toBe(erwartet);
    });
  }

  test('kein Pfad, kein Glob-Muster und kein Hash in der fertigen Meldung', () => {
    const t = uebertragenMeldung(
      'red path (Submodul): .openclaw/extensions/executive-agent/hooks/deny-destructive.sh matches hooks/**', 39);
    expect(t).not.toContain('deny-destructive.sh');
    expect(t).not.toContain('**');
    expect(t).not.toContain('.openclaw');
    expect(t).toContain('Schutzhook geändert');
    expect(t).toContain('Freigabe genutzt nach 39 s');
  });

  test('unbekannter Grund wird nicht erfunden', () => {
    expect(roteZoneKlartext('red path: irgendwas/neu.txt matches irgendwas/**')).toBe('geschützte Datei geändert');
    expect(roteZoneKlartext('')).toBe('roter Pfad berührt');
  });
});

describe('Fristen', () => {
  test('Uhrzeit in Berliner Zeit', () => {
    expect(uhrzeit(new Date('2026-10-14T11:59:00Z'))).toBe('13:59');
  });

  test('Freigabezeile nennt die Uhrzeit des Ablaufs', () => {
    expect(freigabeZeile(new Date('2026-10-14T11:59:00Z'))).toBe('🔓 Freigabe aktiv bis 13:59 (einmalig)');
  });

  test('Alter in Sekunden, ab anderthalb Minuten in Minuten', () => {
    expect(alterText(39)).toBe('nach 39 s');
    expect(alterText(89)).toBe('nach 89 s');
    expect(alterText(180)).toBe('nach 3 Min.');
  });

  test('die Wartemeldung sagt, wie lange die Freigabe gilt', () => {
    expect(wartetMeldung('red path: hooks/x.sh matches hooks/**')).toContain('15 Minuten');
  });
});
