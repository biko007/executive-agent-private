/**
 * Kein Command darf eine leere Antwort zurückgeben.
 *
 * ANLASS (Owner, 16.10.2026): „Fix den Bug". Nach jedem `/arm` stand im
 * Owner-Chat zusätzlich **„No response generated. Please try again."** — als
 * wäre etwas schiefgegangen, obwohl die Freigabe saß. Dasselbe bei
 * `/briefing` und bei der Bestätigungsfrage von `/memory drop`.
 *
 * URSACHE, belegt im Kern (`openclaw/dist/bot-native-command-plugins-*.js`):
 *
 *     const deliverableResult = hasRenderableTelegramNativeReplyPayload(result)
 *       ? … : { text: EMPTY_RESPONSE_FALLBACK };
 *
 * Ein Handler, der selbst sendet und dann `{ text: '' }` zurückgibt, liefert
 * keinen darstellbaren Inhalt — und der Kern schiebt den Fallbacktext nach.
 * Wenige Zeilen darüber steht die vorgesehene Lösung: `suppressReply === true`
 * beendet die Zustellung ohne weitere Nachricht.
 *
 * Diese Tests sind statisch, weil die Handler inline in index.ts liegen und
 * nicht importierbar sind. Sie prüfen die Quelle — das reicht, denn der Fehler
 * ist genau einer der Rückgabeform.
 */
import { describe, test, expect } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import { stillBeantwortet } from '../modules/system-telegram/index.js';

const ROOT = path.resolve(import.meta.dir, '../..');
const quelle = fs.readFileSync(path.join(ROOT, 'index.ts'), 'utf-8');

describe('stillBeantwortet', () => {
  test('setzt das Merkmal, das der Kern auswertet', () => {
    expect(stillBeantwortet()).toEqual({ text: '', suppressReply: true });
  });
});

describe('index.ts — kein Handler gibt eine leere Antwort zurück', () => {
  test('nirgends mehr ein blankes { text: \'\' }', () => {
    /* Das ist die Form, die den Fallbacktext auslöst. Wer selbst gesendet
       hat, nimmt stillBeantwortet(); wer nichts gesendet hat, gibt Text
       zurück. Eine dritte Möglichkeit gibt es nicht. */
    const treffer = quelle.match(/return \{ text: '' \}/g) ?? [];
    expect(treffer).toHaveLength(0);
  });

  test('jedes stillBeantwortet steht hinter einem eigenen Versand', () => {
    /* Sonst bliebe der Owner ohne jede Rückmeldung — stiller als nötig ist
       genauso falsch wie eine falsche Meldung. */
    const zeilen = quelle.split('\n');
    const sender = /\b(sendTelegram|sendTelegramHtmlWithMarkup|sendTelegramWithKeyboard|sendTelegramToRole|sendTelegramDocumentToRole|editiereNachricht)\s*\(/;
    zeilen.forEach((z, i) => {
      if (!z.includes('stillBeantwortet()')) return;
      const davor = zeilen.slice(Math.max(0, i - 12), i).join('\n');
      expect(sender.test(davor), `Zeile ${i + 1}: ${z.trim()}`).toBe(true);
    });
  });

  test('der Helfer wird importiert, nicht nachgebaut', () => {
    expect(quelle).toContain('stillBeantwortet,');
    expect(quelle).toContain("from './src/modules/system-telegram/index.js'");
    expect(quelle).not.toContain('suppressReply: true,');  // nur über den Helfer
  });
});

describe('alle registrierten Commands', () => {
  /** Grenzt jeden Handlerkörper zwischen zwei `name:`-Zeilen ab. */
  function handler(): Array<{ name: string; koerper: string }> {
    const marken = [...quelle.matchAll(/^    name: '([a-z0-9_]+)',/gm)]
      .map((m) => ({ pos: m.index!, name: m[1] }));
    return marken.map((m, i) => ({
      name: m.name,
      koerper: quelle.slice(m.pos, marken[i + 1]?.pos ?? quelle.length),
    }));
  }

  test('kein Handler sendet selbst und gibt daneben leeren Text zurück', () => {
    for (const h of handler()) {
      expect(h.koerper, `/${h.name}`).not.toContain("return { text: '' }");
    }
  });

  test('die bekannten Selbstsender sind abgedeckt', () => {
    /* Namentlich festgehalten, damit ein künftiger Umbau auffällt. */
    const erwartet = ['arm', 'briefing', 'memory'];
    const mitHelfer = handler()
      .filter((h) => h.koerper.includes('stillBeantwortet()'))
      .map((h) => h.name)
      .sort();
    expect(mitHelfer).toEqual(erwartet.sort());
  });

  test('/report bleibt bewusst wie es ist', () => {
    /* `/report` schickt das Dokument an die dev-Gruppe und gibt dem
       aufrufenden Chat eine Quittung — zwei verschiedene Ziele, keine
       Doppelmeldung. Der Helfer wäre hier falsch: Der Owner bekäme im
       Zweifel gar nichts. */
    const r = handler().find((h) => h.name === 'report')!;
    expect(r.koerper).not.toContain('stillBeantwortet()');
    expect(r.koerper).toContain('sendTelegramDocumentToRole');
    expect(r.koerper).toMatch(/return \{ text: `Report #/);
  });
});
