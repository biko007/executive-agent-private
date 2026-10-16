/**
 * Der Knopf „Freigeben und übertragen" — Berechtigung, Einmaligkeit, Texte.
 *
 * Die Sicherheitszusage lautet: nur der Owner, nur einmal, Freigabe verfaellt
 * nach 15 Minuten. Die ersten beiden Punkte entscheidet pruefeKnopf(), der
 * dritte bleibt beim Deny-Hook; hier wird nur geprueft, dass die Frist, die
 * dieses Modul nennt, dieselbe ist.
 */
import { describe, test, expect } from 'bun:test';
import {
  ARM_TTL_SEK, KNOPF_PRAEFIX, ablaufZeitpunkt, knopfMarkup, pruefeKnopf,
  freigabeGesetztText, uebertragungGestartetText, startFehlgeschlagenText,
  knopfErledigtText, nichtOwnerText, verbrauchtText,
} from '../index.js';

const BASIS = { kennung: 'k1', erwartet: 'k1', ownerId: '111', verbraucht: false };

describe('Berechtigung am Knopf', () => {
  test('der Owner darf', () => {
    expect(pruefeKnopf({ ...BASIS, senderId: '111' })).toEqual({ ok: true });
  });

  test('eine fremde Benutzerkennung wird abgewiesen', () => {
    /* '111 ' fehlt bewusst: Fuehrende und folgende Leerzeichen stammen aus dem
         Transport, nicht vom Nutzer — die Pruefung schneidet sie ab. */
    for (const fremd of ['222', '1110', '11', '', ' ', 'owner', '1 11']) {
      const r = pruefeKnopf({ ...BASIS, senderId: fremd });
      expect(r.ok, `senderId=${JSON.stringify(fremd)}`).toBe(false);
      if (!r.ok) expect(r.grund).toBe('fremder_nutzer');
    }
  });

  test('ohne hinterlegten Owner darf niemand', () => {
    const r = pruefeKnopf({ ...BASIS, senderId: '111', ownerId: null });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.grund).toBe('fremder_nutzer');
  });

  test('die Abweisung verraet nicht, ob eine Freigabe aussteht', () => {
    const ohneFreigabe = pruefeKnopf({ ...BASIS, erwartet: null, senderId: '222' });
    const mitFreigabe = pruefeKnopf({ ...BASIS, senderId: '222' });
    expect(ohneFreigabe).toEqual(mitFreigabe);
  });
});

describe('Einmaligkeit', () => {
  test('ein zweiter Druck laeuft ins Leere', () => {
    const r = pruefeKnopf({ ...BASIS, senderId: '111', verbraucht: true });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.grund).toBe('verbraucht');
  });

  test('eine alte Kennung gilt nicht mehr', () => {
    const r = pruefeKnopf({ ...BASIS, kennung: 'alt', erwartet: 'neu', senderId: '111' });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.grund).toBe('unbekannt');
  });
});

describe('Knopf und Frist', () => {
  test('callback_data traegt das Praefix und bleibt unter 64 Byte', () => {
    const m = knopfMarkup('a'.repeat(200));
    const daten = m.inline_keyboard[0][0].callback_data;
    expect(daten.startsWith(KNOPF_PRAEFIX)).toBe(true);
    expect(Buffer.byteLength(daten, 'utf-8')).toBeLessThanOrEqual(64);
  });

  test('Knopfbeschriftung ist deutsch und traegt das Freigabe-Symbol', () => {
    expect(knopfMarkup('k').inline_keyboard[0][0].text).toBe('🔓 Freigeben und übertragen');
  });

  test('die Frist ist dieselbe wie im Deny-Hook: 900 Sekunden', () => {
    expect(ARM_TTL_SEK).toBe(900);
    expect(ablaufZeitpunkt(1_000_000)).toBe(1_000_000 + 900_000);
  });
});

describe('Texte', () => {
  const ABLAUF = new Date('2026-10-14T11:59:00Z');
  const ALLE = [
    freigabeGesetztText(ABLAUF, null, false),
    freigabeGesetztText(ABLAUF, 'Migration V043 anwenden', true),
    uebertragungGestartetText(ABLAUF),
    startFehlgeschlagenText('keine Sitzung'),
    knopfErledigtText(ABLAUF),
    nichtOwnerText(),
    verbrauchtText(),
  ];

  test('kein Englisch, keine Umschrift, keine Steuerzeichen', () => {
    for (const t of ALLE) {
      /* Ausnahme: Der Befehl heisst „push". Wo der Owner ihn selbst eintippen
         soll, steht er in Anfuehrungszeichen — das ist ein Eigenname, kein
         englischer Satzbau. Ueberall sonst ist Englisch verboten. */
      expect(t.replace(/„push"/g, '')).not.toMatch(/\b(armed|dispatched|push|Push)\b/);
      expect(t).not.toMatch(/\b(naechste|fuer|ueber|Uebertragung)\b/);
      expect(t).not.toMatch(/\*/);
      expect(t).not.toMatch(/━|-{3,}/);
    }
  });

  test('der Befehlsname steht nur dort, wo der Owner ihn eintippen soll', () => {
    expect(startFehlgeschlagenText('x')).toContain('„push"');
    for (const t of ALLE.filter(x => !x.includes('Start fehlgeschlagen'))) {
      expect(t).not.toContain('push');
    }
  });

  test('jede Meldung beginnt fett mit einem Symbol', () => {
    for (const t of ALLE) expect(t.split('\n')[0]).toMatch(/^<b>(✅|👉|⚠️|❌|⏸|🔓) .+<\/b>$/);
  });

  test('die Ablaufzeit steht drin, wo eine Frist laeuft', () => {
    expect(freigabeGesetztText(ABLAUF, null, false)).toContain('Freigabe aktiv bis 13:59 (einmalig)');
    expect(uebertragungGestartetText(ABLAUF)).toContain('bis 13:59');
  });

  /* GEAENDERT AM 16.10.2026. Vorher stand hier, dass `/arm` eine wartende
     Uebertragung NICHT startet — und die Quittung sagte das auch. Genau diese
     Trennung war die Verwirrung: Der Owner musste wissen, wann `push`
     dazugehoert. Jetzt startet `/arm` den angemeldeten Schritt selbst, und die
     Quittung nennt ihn beim Namen. */
  test('die Quittung nennt den vorgemerkten Schritt', () => {
    const t = freigabeGesetztText(ABLAUF, 'Migration V043 anwenden', true);
    expect(t).toContain('freigegeben: Migration V043 anwenden');
    expect(t).toContain('cc führt ihn jetzt aus');
  });

  test('ohne Vormerkung bleibt sie allgemein, nennt aber die Lage', () => {
    const t = freigabeGesetztText(ABLAUF, null, false);
    expect(t).toContain('gilt für den nächsten roten Schritt');
    expect(t).toContain('cc führt ihn beim nächsten Schritt aus');
    expect(t).not.toContain('freigegeben:');
  });

  test('ob gestartet wurde, steht im Titel — nicht im Kleingedruckten', () => {
    expect(freigabeGesetztText(ABLAUF, null, true)).toContain('Freigegeben und gestartet');
    expect(freigabeGesetztText(ABLAUF, null, false)).toContain('Freigabe gesetzt');
  });

  test('der Fehlerfall sagt, was der Owner selbst tun kann', () => {
    expect(startFehlgeschlagenText('keine Sitzung')).toContain('in der Sitzung selbst eingeben');
  });
});
