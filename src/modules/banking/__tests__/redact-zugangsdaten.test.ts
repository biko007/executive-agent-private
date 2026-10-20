/**
 * C5: Zugangsdaten nie im Log (Befund 20.10.2026 — connect-Aufruf stand mit
 * PIN und Anmeldename im Journal).
 */
import { describe, test, expect } from 'bun:test';
import { redactClientData } from '../sidecar-client.js';

describe('redactClientData', () => {
  test('PIN, Anmeldename und TAN werden geschwärzt', () => {
    const r = redactClientData({ session_id: 20, blz: '64350070', user_id: 'KENNUNG123', pin: 'GEHEIM1', tan: '123456', fints_url: 'https://x' });
    expect(r).toEqual({ session_id: 20, blz: '64350070', user_id: '<REDACTED>', pin: '<REDACTED>', tan: '<REDACTED>', fints_url: 'https://x' });
    expect(JSON.stringify(r)).not.toContain('GEHEIM1');
    expect(JSON.stringify(r)).not.toContain('KENNUNG123');
  });

  test('auch verschachtelt und ohne Längenangabe', () => {
    const r: any = redactClientData({ inner: { pin: 'X', userId: 'Y' } });
    expect(r.inner).toEqual({ pin: '<REDACTED>', userId: '<REDACTED>' });
  });

  test('client_data bleibt wie bisher mit Länge geschwärzt', () => {
    expect((redactClientData({ client_data: 'abcd' }) as any).client_data).toBe('<REDACTED:4-chars>');
  });
});
