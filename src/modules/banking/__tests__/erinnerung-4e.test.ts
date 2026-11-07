/**
 * Vorschlag 4e (Owner-Freigabe 07.11.2026 13:10): Montagserinnerung statt
 * Abgleichslauf für die Volksbank. Eigene Test-Datenbank (C1), Sidecar
 * nachgestellt, kein Bankkontakt, keine echte Telegram-Nachricht.
 */
import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { setupTestDb } from './test-db-setup.js';
import { abrufFrisch, abrufText, erinnerungText, erinnerungVermerk } from '../erinnerung.js';
import { erinnerungsUrteil } from '../../banking-wochencheck/logik.js';

process.env.BANKING_ENCRYPTION_KEY = 'a'.repeat(64);

let cleanup: () => Promise<void>;
beforeAll(async () => { cleanup = (await setupTestDb()).cleanup; });
afterAll(async () => { if (cleanup) await cleanup(); });

const VOLLE_IBAN = /[A-Z]{2}\d{2}\d{12,}/;

describe('Bausteine', () => {
  const jetzt = new Date('2026-11-09T12:00:00Z');
  test('frisch = letzter Abruf jünger als 3 Tage', () => {
    expect(abrufFrisch({ letzterAbruf: '2026-11-07T07:17:28Z', buchungstagBis: null }, jetzt)).toBe(true);
    expect(abrufFrisch({ letzterAbruf: '2026-11-06T11:59:00Z', buchungstagBis: null }, jetzt)).toBe(false);
    expect(abrufFrisch({ letzterAbruf: null, buchungstagBis: null }, jetzt)).toBe(false);
  });
  test('Text mit Datum, Buchungstag und Link, ohne Kontonummer', () => {
    const t = erinnerungText('Volksbank', { letzterAbruf: '2026-11-02T07:17:28Z', buchungstagBis: '2026-11-01' });
    expect(t).toBe('🏦 Volksbank: Umsätze bitte über „Bank verbinden“ abrufen (App-Freigabe nötig). Letzter Abruf: 02.11.2026 (Buchungstag bis 01.11.2026)\n→ https://app.bikobickel.de/dashboard/?tab=banking-connect');
    expect(abrufText({ letzterAbruf: null, buchungstagBis: null })).toBe('Letzter Abruf: unbekannt');
  });
  test('Wochencheck führt die Erinnerung nicht als Fehler', () => {
    expect(erinnerungsUrteil('REMINDER_SENT', erinnerungVermerk(true, { letzterAbruf: '2026-11-02T07:17:28Z', buchungstagBis: '2026-11-01' })))
      .toEqual({ urteil: 'Erinnerung', text: 'Erinnerung gesendet · Letzter Abruf: 02.11.2026 (Buchungstag bis 01.11.2026) — Abgleich nur über „Bank verbinden“' });
    expect(erinnerungsUrteil('REMINDER_SKIPPED', null)?.urteil).toBe('Erinnerung');
    expect(erinnerungsUrteil('IMPORT_FAILED', 'x')).toBeNull();
  });
});

async function institut(blz: string, iban: string) {
  const { upsertInstitution, createSession, upsertAccount } = await import('../store.js');
  const { query } = await import('../../../shared/db/index.js');
  const inst = await upsertInstitution(blz, `Bank ${blz}`, null, 'https://example.com/fints');
  const sess = await createSession(inst.id, `U_${blz}`, `P_${blz}`, `prod-${blz}`);
  await query(`UPDATE banking_sessions SET session_expires_at = $1, last_success_at = NOW() WHERE id = $2`,
    [new Date(Date.now() + 90 * 86_400_000).toISOString(), sess.id]);
  const konto = await upsertAccount(inst.id, iban, `Konto ${blz}`);
  return { inst, sess, konto };
}

async function laufzeile(institutionId: number) {
  const { query } = await import('../../../shared/db/index.js');
  return (await query(`SELECT status, trigger_source, error_message, run_phase FROM banking_sync_runs WHERE institution_id = $1 ORDER BY id DESC LIMIT 1`, [institutionId])).rows[0];
}

describe('Montagslauf mit Volksbank und KSK', () => {
  let vb: Awaited<ReturnType<typeof institut>>;
  let ksk: Awaited<ReturnType<typeof institut>>;
  const aufrufe: string[] = [];
  const gesendet: string[] = [];

  beforeAll(async () => {
    vb = await institut('64390130', 'DE00643901300000000028');
    ksk = await institut('64350070', 'DE00643500700000004413');
    const { initSyncEngine } = await import('../sync-engine.js');
    initSyncEngine({
      sendTelegram: async (_c: string, t: string) => { gesendet.push(t); return true; }, telegramChatId: () => 'test',
      _sidecarHealth: async () => ({ status: 'ok' }),
      _sidecarSync: async (p: any) => { aufrufe.push(p.account_iban); return { needs_tan: false, transactions: [], balance: 1 } as any; },
    } as any);
  });

  test('Volksbank ohne Bankkontakt, Erinnerung erzeugt, KSK unverändert abgeglichen', async () => {
    aufrufe.length = 0;
    const { runWeeklySyncWithReport } = await import('../sync-engine.js');
    const r = await runWeeklySyncWithReport({ runPhase: 'scheduled', triggerSource: 'scheduler', triggerId: '2026-11-09' });
    expect(aufrufe).toEqual([ksk.konto.iban]);
    expect(r.status).toBe('SUCCESS_FULL');
    expect(r.telegram).toContain('Bankabgleich erfolgreich');
    expect(r.erinnerungen.length).toBe(1);
    expect(r.erinnerungen[0]).toContain('🏦 Volksbank: Umsätze bitte über „Bank verbinden“ abrufen (App-Freigabe nötig).');
    expect(r.erinnerungen[0]).toContain('?tab=banking-connect');
    expect(VOLLE_IBAN.test(r.erinnerungen.join('\n') + r.telegram + gesendet.join('\n'))).toBe(false);
    const zV = await laufzeile(vb.inst.id);
    expect(zV).toMatchObject({ status: 'REMINDER_SENT', trigger_source: 'timer', run_phase: 'scheduled' });
    expect(zV.error_message).toContain('Erinnerung gesendet');
    expect((await laufzeile(ksk.inst.id)).status).toBe('SUCCESS_FULL');
  });

  test('frischer Abruf über „Bank verbinden“ (< 3 Tage): Erinnerung unterdrückt, nur Vermerk', async () => {
    aufrufe.length = 0;
    const { protokolliereLauf } = await import('../abruf-nach-verbinden.js');
    await protokolliereLauf(vb.inst.id, vb.sess.id, [{ konto: '…0028', status: 'ok', umsaetze: 3, neu: 1, umgeschluesselt: 0, pdfVerknuepft: 0, saldenprobe: 0 }] as any);
    const { runWeeklySyncWithReport } = await import('../sync-engine.js');
    const r = await runWeeklySyncWithReport({ runPhase: 'scheduled' });
    expect(r.erinnerungen).toEqual([]);
    expect(aufrufe).toEqual([ksk.konto.iban]);
    const zV = await laufzeile(vb.inst.id);
    expect(zV.status).toBe('REMINDER_SKIPPED');
    expect(zV.error_message).toContain('Erinnerung unterdrückt');
  });

  test('„Abgleich jetzt“ (manual) bleibt unverändert und spricht die Volksbank an', async () => {
    aufrufe.length = 0;
    const { startWeeklySync } = await import('../sync-engine.js');
    const r = await startWeeklySync({ runPhase: 'manual' });
    expect(aufrufe.sort()).toEqual([vb.konto.iban, ksk.konto.iban].sort());
    expect(r.erinnerungen).toEqual([]);
  });
});
