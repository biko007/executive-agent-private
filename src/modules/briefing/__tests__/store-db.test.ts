/**
 * Ablage der Briefings — Roundtrip, Versuchszähler, Nachholstand, Liste.
 *
 * Läuft gegen eine frische Test-Datenbank (C1 Test-DB-Isolation).
 */
import { describe, expect, test, beforeAll, afterAll } from 'bun:test';
import { setupTestDb } from './test-db-setup.js';

let cleanup: () => Promise<void>;
let store: typeof import('../store.js');

beforeAll(async () => {
  const setup = await setupTestDb();
  cleanup = setup.cleanup;
  store = await import('../store.js');
});

afterAll(async () => {
  if (cleanup) await cleanup();
});

describe('Briefing-Ablage', () => {
  test('erster Versuch scheitert, Nachholversuch stellt zu', async () => {
    await store.speichereVersuch({ art: 'morgen', datum: '2026-10-26', textHtml: '', status: 'fehler',
      telegramOk: false, mailOk: null, fehler: 'briefing_timeout' });
    let e = await store.holeBriefing('morgen', '2026-10-26');
    expect(e!.status).toBe('fehler');
    expect(e!.versuche).toBe(1);
    expect(e!.fehler).toBe('briefing_timeout');

    await store.speichereVersuch({ art: 'morgen', datum: '2026-10-26', textHtml: '<b>Hallo</b>', status: 'gesendet',
      telegramOk: true, mailOk: null, fehler: null });
    e = await store.holeBriefing('morgen', '2026-10-26');
    expect(e!.status).toBe('gesendet');
    expect(e!.versuche).toBe(2);
    expect(e!.textHtml).toBe('<b>Hallo</b>');
    expect(e!.gesendetAt).not.toBeNull();
    expect(await store.istZugestellt('morgen', '2026-10-26')).toBe(true);
  });

  test('eine zugestellte Mail bleibt zugestellt', async () => {
    await store.speichereVersuch({ art: 'abend', datum: '2026-10-26', textHtml: 'A', status: 'erzeugt',
      telegramOk: false, mailOk: true, fehler: 'telegram' });
    await store.speichereVersuch({ art: 'abend', datum: '2026-10-26', textHtml: 'A', status: 'gesendet',
      telegramOk: true, mailOk: null, fehler: null });
    const e = await store.holeBriefing('abend', '2026-10-26');
    expect(e!.mailOk).toBe(true);
    expect(e!.telegramOk).toBe(true);
  });

  test('spätere Telegram-Zustellung nachtragen', async () => {
    await store.speichereVersuch({ art: 'morgen', datum: '2026-10-25', textHtml: 'X', status: 'erzeugt',
      telegramOk: false, mailOk: null, fehler: null });
    await store.markiereGesendet('morgen', '2026-10-25');
    expect(await store.istZugestellt('morgen', '2026-10-25')).toBe(true);
  });

  test('Fehlermeldung wird festgehalten, auch ohne vorherigen Versuch', async () => {
    await store.markiereFehlerGemeldet('morgen', '2026-10-24', 'Gateway aus');
    const e = await store.holeBriefing('morgen', '2026-10-24');
    expect(e!.fehlerGemeldet).toBe(true);
    expect(e!.status).toBe('fehler');
  });

  test('Liste: nur die letzten Tage, neueste zuerst', async () => {
    const heute = new Date().toISOString().slice(0, 10);
    const vor10 = new Date(Date.now() - 10 * 86_400_000).toISOString().slice(0, 10);
    await store.speichereVersuch({ art: 'morgen', datum: heute, textHtml: 'H', status: 'gesendet',
      telegramOk: true, mailOk: null, fehler: null });
    await store.speichereVersuch({ art: 'morgen', datum: vor10, textHtml: 'Alt', status: 'gesendet',
      telegramOk: true, mailOk: null, fehler: null });
    const liste = await store.listeBriefings(7);
    expect(liste[0].datum).toBe(heute);
    expect(liste.some(b => b.datum === vor10)).toBe(false);
  });

  test('ungültige Art scheitert an der Prüfregel', async () => {
    await expect(store.speichereVersuch({ art: 'mittag' as any, datum: '2026-10-26', textHtml: '', status: 'erzeugt',
      telegramOk: false, mailOk: null, fehler: null })).rejects.toThrow();
  });
});
