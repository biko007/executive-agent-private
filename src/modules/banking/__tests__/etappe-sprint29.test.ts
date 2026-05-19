/**
 * banking/etappe-sprint29.test.ts — Sprint 2.9 tests.
 * Tests for: retry-disable, cancelSession fire-and-forget, complete-tan
 * validation (empty TAN), DELETE /banking/session/:id.
 *
 * No DB required for these tests — they test HTTP/sidecar behavior only.
 */
import { describe, test, expect, beforeAll, afterAll } from 'bun:test';

// ── Sidecar Client Tests (Sprint 2.9) ──────────────────────────────────────

describe('sidecar-client sprint 2.9', () => {
  test('1. cancelSession does not throw on network error', async () => {
    // Point at unreachable port to simulate sidecar down
    const saved = process.env.BANKING_SIDECAR_URL;
    process.env.BANKING_SIDECAR_URL = 'http://127.0.0.1:19999';
    try {
      const { cancelSession } = await import('../sidecar-client.js');
      // Must not throw — fire-and-forget contract
      await cancelSession(99999);
    } finally {
      if (saved) process.env.BANKING_SIDECAR_URL = saved;
      else delete process.env.BANKING_SIDECAR_URL;
    }
  });

  test('2. cancelSession fire-and-forget on sidecar 500', async () => {
    // Start a minimal HTTP server that always returns 500
    const server = Bun.serve({
      port: 0, // random available port
      fetch() {
        return new Response('Internal Server Error', { status: 500 });
      },
    });

    const saved = process.env.BANKING_SIDECAR_URL;
    process.env.BANKING_SIDECAR_URL = `http://127.0.0.1:${server.port}`;
    try {
      const { cancelSession } = await import('../sidecar-client.js');
      // Must not throw even on 500
      await cancelSession(12345);
    } finally {
      if (saved) process.env.BANKING_SIDECAR_URL = saved;
      else delete process.env.BANKING_SIDECAR_URL;
      server.stop(true);
    }
  });

  test('3. connect does not retry on 500 (maxRetries=0)', async () => {
    let callCount = 0;
    const server = Bun.serve({
      port: 0,
      fetch() {
        callCount++;
        return new Response('Server Error', { status: 500 });
      },
    });

    const saved = process.env.BANKING_SIDECAR_URL;
    process.env.BANKING_SIDECAR_URL = `http://127.0.0.1:${server.port}`;
    try {
      const { connect, SidecarError } = await import('../sidecar-client.js');
      try {
        await connect({
          session_id: 1, blz: '12345678', user_id: 'X', pin: 'X',
          fints_url: 'https://example.com/fints',
        });
      } catch (e: any) {
        expect(e).toBeInstanceOf(SidecarError);
        expect(e.statusCode).toBe(500);
      }
      // Should be exactly 1 call (no retry)
      expect(callCount).toBe(1);
    } finally {
      if (saved) process.env.BANKING_SIDECAR_URL = saved;
      else delete process.env.BANKING_SIDECAR_URL;
      server.stop(true);
    }
  });

  test('4. completeTan does not retry on 500 (maxRetries=0)', async () => {
    let callCount = 0;
    const server = Bun.serve({
      port: 0,
      fetch() {
        callCount++;
        return new Response('Server Error', { status: 500 });
      },
    });

    const saved = process.env.BANKING_SIDECAR_URL;
    process.env.BANKING_SIDECAR_URL = `http://127.0.0.1:${server.port}`;
    try {
      const { completeTan, SidecarError } = await import('../sidecar-client.js');
      try {
        await completeTan({
          session_id: 1, blz: '12345678', user_id: 'X', pin: 'X',
          fints_url: 'https://example.com/fints',
          client_data: 'dummy', tan_data: 'dummy', tan: '',
        });
      } catch (e: any) {
        expect(e).toBeInstanceOf(SidecarError);
        expect(e.statusCode).toBe(500);
      }
      // Should be exactly 1 call (no retry)
      expect(callCount).toBe(1);
    } finally {
      if (saved) process.env.BANKING_SIDECAR_URL = saved;
      else delete process.env.BANKING_SIDECAR_URL;
      server.stop(true);
    }
  });
});

// ── Route-Level Tests via Gateway (if running) ─────────────────────────────

describe('gateway routes sprint 2.9', () => {
  const GATEWAY_URL = 'http://127.0.0.1:18789';
  const token = process.env.CORE_SERVICE_TOKEN || '';

  function isGatewayAvailable(): Promise<boolean> {
    return fetch(`${GATEWAY_URL}/health`, {
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(2000),
    }).then(r => r.ok).catch(() => false);
  }

  test('5. complete-tan rejects missing session_id → 400', async () => {
    if (!token || !(await isGatewayAvailable())) {
      console.log('  (skipped — gateway not available)');
      return;
    }
    const res = await fetch(`${GATEWAY_URL}/api/banking/complete-tan`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toContain('session_id');
  });

  test('6. complete-tan accepts empty TAN string (passes validation)', async () => {
    if (!token || !(await isGatewayAvailable())) {
      console.log('  (skipped — gateway not available)');
      return;
    }
    const res = await fetch(`${GATEWAY_URL}/api/banking/complete-tan`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ session_id: 99999, tan: '' }),
    });
    // Should NOT be 400 — validation passes, tan-bridge handles the rest
    expect(res.status).not.toBe(400);
  });

  test('7. DELETE /banking/session/:id returns 204', async () => {
    if (!token || !(await isGatewayAvailable())) {
      console.log('  (skipped — gateway not available)');
      return;
    }
    const res = await fetch(`${GATEWAY_URL}/api/banking/session/99999`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(res.status).toBe(204);
  });
});
