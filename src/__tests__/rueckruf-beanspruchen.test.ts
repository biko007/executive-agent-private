/**
 * Knopfdrücke lösen keinen Agentenlauf mehr aus.
 *
 * ANLASS (Owner, 16.10.2026, 13:45 Berlin): Nach dem Knopf „Freigeben und
 * übertragen" stand im Chat **„Something went wrong while processing your
 * request."** Die Freigabe hatte gewirkt — die Meldung kam von woanders.
 *
 * URSACHE, belegt im Journal (11:45:51–11:45:57 UTC):
 *
 *   [executive-agent] command-guard: Callback erkannt — AI agent wird unterdrückt
 *   [agent/embedded]  … reason=model_not_found … from=openai/gpt-5.5
 *   [agents/harness]  Codex agent harness failed; not falling back
 *   [telegram]        outbound send ok … messageId=5777
 *
 * Der command-guard „unterdrückte" den Agenten nur mit einer ANWEISUNG an das
 * Modell („Reply with exactly: NO_REPLY"). Der Lauf fand trotzdem statt. Das
 * fiel nie auf, solange das Modell antwortete — an diesem Tag war das Backend
 * gestört, der Lauf scheiterte, und der Kern schickte seinen allgemeinen
 * Fehlertext.
 *
 * Das ist NICHT dieselbe Ursache wie Bug 1 vom selben Tag: Dort gab ein
 * Handler eine leere Antwort zurück. Hier läuft ein Agent, der nie hätte
 * laufen dürfen.
 *
 * Die Lehre, die diese Tests festhalten: Eine Anweisung an ein Modell ist
 * keine Unterdrückung. Nur das Beanspruchen der Nachricht verhindert den Lauf
 * sicher — und macht den Knopf unabhängig davon, ob irgendein Modell gerade
 * erreichbar ist.
 */
import { describe, test, expect } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import { enthaeltRueckrufZeile, istUnsererRueckruf, unwrapCallbackContent } from '../shared/telegram-callback/index.js';

const PRAEFIXE = ['icraft_', 'iscan_', 'isub_', 'segdel_', 'booking_',
  'meeting_', 'bsync_', 'bweekly_', 'memdrop_', 'armpush_'] as const;

describe('Was beansprucht wird', () => {
  test('der blanke Knopfinhalt', () => {
    expect(istUnsererRueckruf('armpush_a1b2c3', PRAEFIXE)).toBe(true);
    expect(istUnsererRueckruf('memdrop_42', PRAEFIXE)).toBe(true);
    expect(istUnsererRueckruf('bweekly_start', PRAEFIXE)).toBe(true);
  });

  test('die Schlüsselwortform des Kanals', () => {
    expect(istUnsererRueckruf('callback_data: armpush_a1b2c3', PRAEFIXE)).toBe(true);
    expect(istUnsererRueckruf('callback_data:armpush_a1b2c3', PRAEFIXE)).toBe(true);
  });

  test('die Hüllenklammer des Frameworks', () => {
    expect(istUnsererRueckruf('[Telegram Jürgen 13:45] armpush_a1b2', PRAEFIXE)).toBe(true);
    expect(istUnsererRueckruf('[Telegram Jürgen 13:45] callback_data: armpush_a1b2', PRAEFIXE)).toBe(true);
  });
});

describe('Was NICHT beansprucht wird — die wichtigere Hälfte', () => {
  /* Eine zu weite Beanspruchung verschluckt echte Nachrichten des Owners.
     Das waere schlimmer als der Fehler, um den es hier geht: Statt einer
     ueberfluessigen Meldung bekaeme er gar keine. */
  const fremd = [
    'Hallo, kannst du mir den Stand zu N24 sagen?',
    'Was bedeutet armpush_ eigentlich?',            // enthaelt, beginnt aber nicht
    'bitte memdrop_42 erklaeren',                   // dito
    '/arm',
    '/report full 3',
    'callback_data: fremd_123',                     // fremdes Praefix
    'armpush',                                      // ohne Unterstrich
    '',
    '   ',
  ];
  for (const text of fremd) {
    test(`unberührt: ${JSON.stringify(text.slice(0, 40))}`, () => {
      expect(istUnsererRueckruf(text, PRAEFIXE)).toBe(false);
    });
  }

  test('nichts Textartiges und leere Eingaben', () => {
    for (const w of [null, undefined, 42, {}, []]) {
      expect(istUnsererRueckruf(w, PRAEFIXE)).toBe(false);
    }
  });

  test('ohne angemeldete Präfixe wird nichts beansprucht', () => {
    expect(istUnsererRueckruf('armpush_a1b2', [])).toBe(false);
    expect(istUnsererRueckruf('armpush_a1b2', [''])).toBe(false);
  });
});

describe('Die Hülle wird gleich behandelt wie bisher', () => {
  test('unwrapCallbackContent bleibt die eine Schälstelle', () => {
    expect(unwrapCallbackContent('[Telegram X 1] callback_data: armpush_1')).toBe('armpush_1');
    expect(unwrapCallbackContent('  armpush_1  ')).toBe('armpush_1');
  });
});

describe('statische Guards gegen index.ts', () => {
  const quelle = fs.readFileSync(
    path.resolve(import.meta.dir, '..', '..', 'index.ts'), 'utf-8');

  test('die Nachricht wird beansprucht, nicht nur kommentiert', () => {
    expect(quelle).toContain('istUnsererRueckruf(inhalt, CALLBACK_PREFIXES)');
    expect(quelle).toContain('return { handled: true };');
  });

  test('es gibt genau EINE Präfixliste', () => {
    const treffer = quelle.match(/const CALLBACK_PREFIXES = /g) ?? [];
    expect(treffer).toHaveLength(1);
  });

  test('der command-guard benutzt dieselbe Liste und dieselbe Strenge', () => {
    /* Er bleibt als zweite Linie stehen: Fällt das Beanspruchen einmal aus,
       schweigt der Agent wenigstens weiterhin. Seit dem 16.10.2026 prüft er
       aber nicht mehr lockerer als die erste Linie — das lockere `includes`
       hatte den Traum-Lauf stillgelegt. */
    expect(quelle).toContain('enthaeltRueckrufZeile(prompt, CALLBACK_PREFIXES)');
    expect(quelle).not.toContain("prompt.includes('callback_data: ' + p)");
  });

  test('die Beanspruchung läuft vor dem Transkript-Haken', () => {
    /* Priorität 100 gegenüber 50: Erst beanspruchen, dann der Rest. */
    const beansprucht = quelle.indexOf("[executive-agent] Knopfdruck beansprucht");
    const stash = quelle.indexOf('voiceTranscriptStash.set');
    expect(beansprucht).toBeGreaterThan(-1);
    expect(beansprucht).toBeLessThan(stash);
  });
});

describe('Der command-guard und der Traum-Lauf', () => {
  /**
   * ANLASS (Owner, 16.10.2026). Am 15.10. um 03:00 hat der command-guard den
   * nächtlichen Traum-Lauf stillgelegt: Dessen Prompt zählt gespeicherte
   * Nutzernachrichten auf, und darunter waren früher gedrückte Knöpfe. Der
   * Guard suchte das Muster irgendwo im Prompt und hielt das für einen
   * Knopfdruck.
   */
  const TRAUM = [
    'Write a dream diary entry from these memory fragments:',
    '- User: callback_data: bweekly_start',
    '- User: armpush_a1b2c3',
    '- Assistant: Freigabe gesetzt',
  ].join('\n');

  test('der Traum-Prompt wird NICHT mehr unterdrückt', () => {
    expect(enthaeltRueckrufZeile(TRAUM, PRAEFIXE)).toBe(false);
  });

  test('ein echter Knopfdruck weiterhin schon', () => {
    for (const echt of [
      '[Telegram Jürgen 13:45] callback_data: armpush_a1b2',
      'callback_data: memdrop_42',
      'bweekly_start',
    ]) {
      expect(enthaeltRueckrufZeile(echt, PRAEFIXE), echt).toBe(true);
    }
  });

  test('auch zwischen Kontextzeilen wird ein echter Knopfdruck gefunden', () => {
    /* Der Prompt traegt vor der Nachricht einen Kontextblock. Die Pruefung
       muss zeilenweise sein, nicht nur am Anfang des Prompts. */
    const mitKontext = [
      'Conversation info: ⟦openclaw:ctx⟧',
      '```json',
      '{"chat_id":"telegram:133260792"}',
      '```',
      '[Telegram Jürgen 13:45] callback_data: armpush_a1b2',
    ].join('\n');
    expect(enthaeltRueckrufZeile(mitKontext, PRAEFIXE)).toBe(true);
  });

  test('ein Gesprächssatz über Knöpfe bleibt unberührt', () => {
    const satz = [
      'Conversation info: ⟦openclaw:ctx⟧',
      'Was macht eigentlich armpush_ genau? Und memdrop_42?',
    ].join('\n');
    expect(enthaeltRueckrufZeile(satz, PRAEFIXE)).toBe(false);
  });

  test('leeres und Nichttextliches ergibt false', () => {
    for (const w of ['', '   ', null, undefined, 42]) {
      expect(enthaeltRueckrufZeile(w, PRAEFIXE)).toBe(false);
    }
  });

  test('index.ts benutzt die gemeinsame Funktion, nicht mehr includes', () => {
    const quelle = fs.readFileSync(
      path.resolve(import.meta.dir, '..', '..', 'index.ts'), 'utf-8');
    expect(quelle).toContain('enthaeltRueckrufZeile(prompt, CALLBACK_PREFIXES)');
    expect(quelle).not.toContain("prompt.includes('callback_data: ' + p)");
  });
});
