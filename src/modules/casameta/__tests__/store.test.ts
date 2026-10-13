/**
 * Tests des Casameta-Protokolls.
 *
 * Der Schwerpunkt liegt auf der Wiederholbarkeit. Der Protokollschritt läuft
 * nach dem Agentenlauf und muss nach einem Abbruch erneut laufen können, ohne
 * dass dabei Aktionen doppelt in der Datenbank landen oder die Zähler
 * davonlaufen. Genau das wird hier geprüft — nicht, ob ein INSERT funktioniert.
 */
import { describe, it, expect, beforeAll, afterAll } from 'bun:test';
import { setupTestDb } from './test-db-setup.js';

let store: typeof import('../store.js');
let cleanup: () => Promise<void>;

beforeAll(async () => {
  const s = await setupTestDb();
  cleanup = s.cleanup;
  store = await import('../store.js');
});

afterAll(async () => { await cleanup(); });

function aktion(seq: number, typ: 'lesen' | 'schreiben', extra: Record<string, unknown> = {}) {
  return {
    seq,
    occurredAt: new Date(Date.UTC(2026, 9, 13, 10, 0, seq)).toISOString(),
    actionType: typ,
    pageUrl: 'https://portal.casameta.de/abrechnung/kostenarten',
    ...extra,
  } as any;
}

describe('casameta/store', () => {
  it('legt einen Lauf an und liest ihn zurück', async () => {
    await store.laufAnlegen({
      runId: '261013-bestand-mg24', propertyCode: 'mg24', periodYear: 2025,
      mode: 'lesen', taskFile: 'auftrag.md', artifactPath: '/tmp/lauf',
    });
    const l = await store.laufLesen('261013-bestand-mg24');
    expect(l?.propertyCode).toBe('mg24');
    expect(l?.mode).toBe('lesen');
    expect(l?.status).toBe('laeuft');
  });

  it('legt denselben Lauf nicht zweimal an', async () => {
    await store.laufAnlegen({ runId: '261013-bestand-mg24', mode: 'schreiben' });
    const l = await store.laufLesen('261013-bestand-mg24');
    /* Der Modus darf sich NICHT auf 'schreiben' geändert haben — ein zweiter
       Aufruf ist ein Wiederholungslauf, keine Neudefinition. */
    expect(l?.mode).toBe('lesen');
  });

  it('übernimmt Aktionen und zählt sie nach Typ', async () => {
    const neu = await store.uebernehmeAktionen('261013-bestand-mg24', [
      aktion(1, 'lesen', { fieldLabel: 'Abrechnungszeitraum', valueBefore: '2025' }),
      aktion(2, 'lesen', { fieldLabel: 'Nutzer', valueBefore: '3' }),
      aktion(3, 'schreiben', {
        fieldLabel: 'Kaltwasser', valueBefore: '0,00', valueAfter: '1.214,01',
        verified: true, screenshotBefore: 'vor-3.png', screenshotAfter: 'nach-3.png',
      }),
    ]);
    expect(neu).toBe(3);
    const l = await store.laufLesen('261013-bestand-mg24');
    expect(l?.actionsRead).toBe(2);
    expect(l?.actionsWritten).toBe(1);
  });

  it('fügt bei einem Wiederholungslauf nichts doppelt ein', async () => {
    const neu = await store.uebernehmeAktionen('261013-bestand-mg24', [
      aktion(1, 'lesen', { fieldLabel: 'Abrechnungszeitraum' }),
      aktion(2, 'lesen', { fieldLabel: 'Nutzer' }),
      aktion(3, 'schreiben', { fieldLabel: 'Kaltwasser' }),
      aktion(4, 'schreiben', { fieldLabel: 'Entwässerung', valueAfter: '1.005,10' }),
    ]);
    /* Nur die vierte ist neu. */
    expect(neu).toBe(1);
    const l = await store.laufLesen('261013-bestand-mg24');
    expect(l?.actionsRead).toBe(2);
    expect(l?.actionsWritten).toBe(2);
  });

  it('schließt den Lauf mit Status und Grund ab', async () => {
    await store.laufAbschliessen('261013-bestand-mg24', {
      status: 'gestoppt',
      stopReason: 'Schaltfläche „Abrechnung freigeben" angetroffen',
      summary: 'Bestandsaufnahme abgebrochen',
      dropboxPath: '/bikosoc-reports/casameta/runs/261013-bestand-mg24',
    });
    const l = await store.laufLesen('261013-bestand-mg24');
    expect(l?.status).toBe('gestoppt');
    expect(l?.stopReason).toContain('freigeben');
    expect(l?.finishedAt).not.toBeNull();
  });

  it('lässt nur die vereinbarten Aktionstypen zu', async () => {
    await store.laufAnlegen({ runId: '261013-typtest-mg24', mode: 'lesen' });
    await expect(store.uebernehmeAktionen('261013-typtest-mg24', [
      aktion(1, 'loeschen' as any),
    ])).rejects.toThrow();
  });

  it('verweigert Aktionen zu einem unbekannten Lauf', async () => {
    await expect(store.uebernehmeAktionen('gibtesnicht', [aktion(1, 'lesen')]))
      .rejects.toThrow();
  });

  it('gibt für einen unbekannten Lauf null zurück', async () => {
    expect(await store.laufLesen('gibtesnicht')).toBeNull();
  });
});
