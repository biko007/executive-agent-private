/**
 * Feste Bankliste für „Bank verbinden" (20.10.2026). Reine Daten, keine DB.
 */
import { describe, test, expect } from 'bun:test';
import { unterstuetzteBank, tanVerfahrenFuerSidecar, UNTERSTUETZTE_BANKEN } from '../banken.js';

describe('Bankliste', () => {
  test('KSK unverändert gegenüber dem erfolgreichen Verbinden vom 20.10.2026', () => {
    expect(unterstuetzteBank('64350070')).toEqual({
      blz: '64350070',
      name: 'Kreissparkasse Tuttlingen',
      fintsUrl: 'https://banking-bw1.s-fints-pt-bw.de/fints30',
    });
  });

  test('Volksbank mit hinterlegter Atruvia-Adresse und SecureGo plus', () => {
    const vb = unterstuetzteBank('64390130');
    expect(vb?.name).toBe('Volksbank Schwarzwald-Donau-Neckar eG');
    expect(vb?.fintsUrl).toBe('https://fints1.atruvia.de/cgi-bin/hbciservlet');
    expect(vb?.tanVerfahren).toBe('SecureGo');
  });

  test('unbekannte oder fehlende BLZ wird abgelehnt', () => {
    expect(unterstuetzteBank('12345678')).toBeNull();
    expect(unterstuetzteBank('')).toBeNull();
    expect(unterstuetzteBank(undefined)).toBeNull();
  });

  test('alle Adressen sind https', () => {
    for (const b of Object.values(UNTERSTUETZTE_BANKEN)) expect(b.fintsUrl.startsWith('https://')).toBe(true);
  });
});

describe('TAN-Verfahren an den Sidecar', () => {
  test('S-pushTAN bleibt bei der Automatik (kein Hinweis)', () => {
    expect(tanVerfahrenFuerSidecar('pushTAN1')).toBeUndefined();
    expect(tanVerfahrenFuerSidecar(null)).toBeUndefined();
  });
  test('SecureGo plus wird weitergegeben', () => {
    expect(tanVerfahrenFuerSidecar('SecureGo')).toBe('SecureGo');
  });
});

describe('Fehlertext für das Formular', () => {
  test('Klartext aus detail einer Sidecar-Antwort mit HTTP 400', async () => {
    const { fehlertextFuerFormular } = await import('../tan-bridge.js');
    const { SidecarError } = await import('../sidecar-client.js');
    const body = JSON.stringify({ error: 'tan_verfahren', detail: 'SecureGo plus ist für diesen Zugang nicht freigeschaltet.' });
    const e = new SidecarError(`Sidecar returned 400: ${body}`, 400, body);
    expect(fehlertextFuerFormular(e)).toBe('SecureGo plus ist für diesen Zugang nicht freigeschaltet.');
  });

  test('ohne JSON bleibt es bei der Meldung', async () => {
    const { fehlertextFuerFormular } = await import('../tan-bridge.js');
    expect(fehlertextFuerFormular(new Error('Timeout'))).toBe('Timeout');
  });
});
