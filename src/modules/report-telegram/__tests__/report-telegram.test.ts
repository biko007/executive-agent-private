/**
 * Form der Telegram-Nachrichten. Owner-Vorgabe 14.10.2026: je Auftrag genau
 * zwei Nachrichten, klar, kurz, aus einem festen Kopfblock statt aus Prosa.
 */
import { describe, test, expect } from 'bun:test';
import {
  kopfblockLesen, kopfblockFallback, uebernahmeNachricht, ergebnisNachricht,
  statusSymbol, htmlEscape, dateiKlartext, kuerzen, ERGEBNIS_MAX,
  ergebnisKnoepfe, goBefehl, CLAUDE_URL,
} from '../index.js';

const KOPF = `---
titel: MG24 Pelletbestand umgebucht
status: aktion
aufgabe: Brennstoffbestand 2025 auf die hergeleiteten Werte umbuchen
ergebnis: [ "Anfangsbestand 6,60 t", "Endbestand 3,20 t", "Kosten 6.273,49 EUR" ]
aktion: "Entwurf prüfen und absenden"
tests: ok
rote_zone: nein
dauer_min: 12
---

# Irgendein Report
`;

describe('Kopfblock lesen', () => {
  test('liest alle Felder', () => {
    const k = kopfblockLesen(KOPF)!;
    expect(k.typ).toBe('ergebnis');
    expect(k.titel).toBe('MG24 Pelletbestand umgebucht');
    expect(k.status).toBe('aktion');
    expect(k.ergebnis).toEqual(['Anfangsbestand 6,60 t', 'Endbestand 3,20 t', 'Kosten 6.273,49 EUR']);
    expect(k.aktion).toBe('Entwurf prüfen und absenden');
    expect(k.tests).toBe('ok');
    expect(k.roteZone).toBe(false);
    expect(k.dauerMin).toBe(12);
  });

  test('Liste auch als Spiegelstriche', () => {
    const k = kopfblockLesen('---\ntitel: T\nergebnis:\n  - erste\n  - zweite\nstatus: ok\n---\n')!;
    expect(k.ergebnis).toEqual(['erste', 'zweite']);
  });

  test('ohne Kopfblock null', () => {
    expect(kopfblockLesen('# Report ohne Block\n\nText')).toBeNull();
    expect(kopfblockLesen('')).toBeNull();
    expect(kopfblockLesen('---\ntitel: offen')).toBeNull();   // kein Abschluss
  });

  test('unbekannter Status wird zu hinweis, nicht zu ok', () => {
    const k = kopfblockLesen('---\nstatus: quatsch\n---\n')!;
    expect(k.status).toBe('hinweis');
  });

  test('rote_zone: ja wird erkannt', () => {
    expect(kopfblockLesen('---\nrote_zone: ja\n---\n')!.roteZone).toBe(true);
    expect(kopfblockLesen('---\nrote_zone: nein\n---\n')!.roteZone).toBe(false);
  });
});

describe('Statussymbole', () => {
  test('alle fuenf', () => {
    expect(statusSymbol('ok')).toBe('✅');
    expect(statusSymbol('aktion')).toBe('👉');
    expect(statusSymbol('hinweis')).toBe('⚠️');
    expect(statusSymbol('fehler')).toBe('❌');
    expect(statusSymbol('wartet')).toBe('⏸');
  });
});

describe('Dateiname in Klartext', () => {
  test('Zeitstempel und dropbox-Praefix fallen weg', () => {
    expect(dateiKlartext('2026-10-13T12-10-20-922Z-dropbox-20261013-140920-mg24-pellet.txt'))
      .toBe('mg24-pellet.txt');
    expect(dateiKlartext('20261014-084520-mg24-pelletbestand.txt')).toBe('mg24-pelletbestand.txt');
    expect(dateiKlartext('report-mg24-w3-20261014.md')).toBe('report-mg24-w3-20261014.md');
  });
});

describe('HTML', () => {
  test('maskiert genau drei Zeichen', () => {
    expect(htmlEscape('a & b < c > d')).toBe('a &amp; b &lt; c &gt; d');
    expect(htmlEscape('6,60 t · 2.238,52 €')).toBe('6,60 t · 2.238,52 €');
  });
  test('keine Markdown-Sternchen in der Ausgabe', () => {
    const k = kopfblockLesen(KOPF)!;
    expect(ergebnisNachricht(k, 'report-x.md')).not.toContain('**');
  });
});

describe('Nachricht 1: Aufgabe uebernommen', () => {
  const k = kopfblockLesen(
    '---\ntyp: uebernahme\ntitel: Pelletbestand MG24\n'
    + 'datei: 2026-10-14T09-00-00-000Z-dropbox-20261014-110000-mg24-pellet.txt\n'
    + 'zeit: "11:26"\nwarteschlange: leer\nstatus: ok\n---\n')!;

  test('vier Zeilen, Dateiname ohne Praefix, genau einmal', () => {
    const n = uebernahmeNachricht(k);
    const zeilen = n.split('\n');
    expect(zeilen).toHaveLength(4);
    expect(zeilen[0]).toBe('📥 <b>Aufgabe übernommen</b>');
    expect(zeilen[1]).toBe('Pelletbestand MG24');
    expect(zeilen[2]).toBe('📄 mg24-pellet.txt');
    expect(zeilen[3]).toBe('🕐 11:26 · Warteschlange: leer');
    expect((n.match(/mg24-pellet\.txt/g) || []).length).toBe(1);
  });

  test('kein Pfad, kein done-Hinweis, kein Nutzungsblock', () => {
    const n = uebernahmeNachricht(k);
    for (const weg of ['/home/', 'done', 'Status:', 'Nutzung', '/do ']) {
      expect(n).not.toContain(weg);
    }
  });

  test('Warteschlange mit Zahl', () => {
    const w = { ...k, warteschlange: '2 wartend' };
    expect(uebernahmeNachricht(w)).toContain('Warteschlange: 2 wartend');
  });
});

describe('Nachricht 2: Ergebnis', () => {
  test('Grundgeruest', () => {
    const n = ergebnisNachricht(kopfblockLesen(KOPF)!, 'report-mg24.md');
    expect(n).toContain('👉 <b>Ergebnis</b> · MG24 Pelletbestand umgebucht');
    expect(n).toContain('<b>Aufgabe:</b>');
    expect(n).toContain('• Anfangsbestand 6,60 t');
    expect(n).toContain('⚙️ Tests ✓ · Rote Zone: nein · 12 Min.');
  });

  test('bei Status aktion steht die Aktion direkt unter dem Titel', () => {
    const z = ergebnisNachricht(kopfblockLesen(KOPF)!, 'report-x.md').split('\n');
    expect(z[1]).toContain('<b>Ihre Aktion:</b>');
  });

  test('sonst steht die Aktion vor der Fusszeile', () => {
    const k = { ...kopfblockLesen(KOPF)!, status: 'ok' as const, aktion: 'keine' };
    const z = ergebnisNachricht(k, 'report-x.md').split('\n');
    expect(z[1]).not.toContain('Ihre Aktion');
    expect(z[z.length - 2]).toContain('<b>Ihre Aktion:</b> keine');
    expect(z[0]).toStartWith('✅');
  });

  test('hoechstens drei Spiegelstriche', () => {
    const k = { ...kopfblockLesen(KOPF)!, ergebnis: ['a', 'b', 'c', 'd', 'e'] };
    expect((ergebnisNachricht(k, 'x.md').match(/^• /gm) || []).length).toBe(3);
  });

  test('laenger als 800 Zeichen wird gekuerzt', () => {
    const k = { ...kopfblockLesen(KOPF)!, aufgabe: 'x'.repeat(2000) };
    const n = ergebnisNachricht(k, 'x.md');
    expect(n.length).toBeLessThanOrEqual(ERGEBNIS_MAX);
    expect(n).toEndWith('…');
  });

  test('Tests ✗ und Rote Zone ja', () => {
    const k = { ...kopfblockLesen(KOPF)!, tests: 'fehler' as const, roteZone: true, dauerMin: null };
    const n = ergebnisNachricht(k, 'x.md');
    expect(n).toContain('⚙️ Tests ✗ · Rote Zone: ja');
    expect(n).not.toContain('Min.');
  });
});

describe('Fallback ohne Kopfblock', () => {
  test('Titel aus Dateiname, Status Hinweis', () => {
    const k = kopfblockFallback('report-mg24-w3-20261014.md');
    expect(k.titel).toBe('mg24-w3-20261014');
    expect(k.status).toBe('hinweis');
    expect(k.fehlt).toBe(true);
    const n = ergebnisNachricht(k, 'report-mg24-w3-20261014.md');
    expect(n).toStartWith('⚠️');
    expect(n).toContain('Kopfblock fehlt');
  });
});

describe('kuerzen', () => {
  test('laesst Kurzes unberuehrt', () => {
    expect(kuerzen('kurz', 10)).toBe('kurz');
  });
  test('kuerzt mit Auslassungszeichen', () => {
    expect(kuerzen('abcdefghij', 5)).toBe('abcd…');
  });
});

describe('Knoepfe unter der Ergebnisnachricht', () => {
  // Owner-Korrektur 14.10.2026: Der Link https://claude.ai/new war mit der
  // alten Go-Nachricht entfallen und wird gebraucht.
  const k = ergebnisKnoepfe('report-mg24-pelletbestand-20261014.md') as any;

  test('zwei Zeilen mit je einem Knopf — untereinander', () => {
    expect(k.inline_keyboard).toHaveLength(2);
    expect(k.inline_keyboard[0]).toHaveLength(1);
    expect(k.inline_keyboard[1]).toHaveLength(1);
  });

  test('Reihenfolge: erst kopieren, dann der Link', () => {
    const [[eins], [zwei]] = k.inline_keyboard;
    expect(eins.text).toBe('go bikosoc kopieren');
    expect(eins.copy_text.text).toBe('go bikosoc report-mg24-pelletbestand-20261014.md');
    expect(zwei.text).toBe('claude.ai');
    expect(zwei.url).toBe(CLAUDE_URL);
    expect(CLAUDE_URL).toBe('https://claude.ai/new');
  });

  test('der Linkknopf traegt keinen copy_text und umgekehrt', () => {
    const [[eins], [zwei]] = k.inline_keyboard;
    expect(eins.url).toBeUndefined();
    expect(zwei.copy_text).toBeUndefined();
  });

  test('gilt unabhaengig vom Status — die Knoepfe haengen am Dateinamen', () => {
    for (const name of ['report-a.md', 'report-b-20261014.md']) {
      const z = (ergebnisKnoepfe(name) as any).inline_keyboard;
      expect(z[0][0].copy_text.text).toBe(`go bikosoc ${name}`);
      expect(z[1][0].url).toBe(CLAUDE_URL);
    }
  });

  test('Pfad wird auf den Dateinamen reduziert', () => {
    expect(goBefehl('/home/biko/bikosoc-spec/report-x.md')).toBe('go bikosoc report-x.md');
    expect(goBefehl('')).toBe('go bikosoc');
  });
});

describe('Maskierte Anfuehrungszeichen im Kopfblock', () => {
  // Aufgefallen an der eigenen Testnachricht vom 14.10.2026: Rueckstriche
  // standen sichtbar in der Telegram-Nachricht.
  test('im Listeneintrag', () => {
    const k = kopfblockLesen(
      '---\nstatus: ok\nergebnis: [ "Knopf \\"claude.ai\\" neben dem Kopierknopf", "zweiter" ]\n---\n')!;
    expect(k.ergebnis).toEqual(['Knopf "claude.ai" neben dem Kopierknopf', 'zweiter']);
    expect(k.ergebnis[0]).not.toContain('\\');
  });

  test('im einfachen Feld', () => {
    const k = kopfblockLesen('---\nstatus: ok\naktion: "Datei \\"x.md\\" prüfen"\n---\n')!;
    expect(k.aktion).toBe('Datei "x.md" prüfen');
  });

  test('ein Komma im Eintrag trennt nicht', () => {
    const k = kopfblockLesen('---\nstatus: ok\nergebnis: [ "a, b und c", "zwei" ]\n---\n')!;
    expect(k.ergebnis).toEqual(['a, b und c', 'zwei']);
  });
});
