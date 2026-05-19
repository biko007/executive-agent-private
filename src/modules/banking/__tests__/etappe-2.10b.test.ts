/**
 * banking/etappe-2.10b.test.ts — Sidecar-Client + tan-bridge clientDataB64 passthrough.
 * 7 tests (T1-T7):
 *   T1-T2: sidecar.connect with/without client_data_b64 (mock sidecar)
 *   T3-T4: redactClientData pure function
 *   T5-T6: initiateConnect passthrough with/without clientDataB64 (DB + mock sidecar)
 *   T7:    E2E: initiateConnect → mock sidecar returns client_data → updateSessionState persists
 *
 * Uses Bun.serve() mock sidecar pattern from etappe-sprint29.test.ts
 * and setupTestDb() from test-db-setup.ts (T5-T7).
 */
import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { setupTestDb } from './test-db-setup.js';

// Set encryption key BEFORE any module imports that might use it
process.env.BANKING_ENCRYPTION_KEY = 'a'.repeat(64);

// ── T1-T2: sidecar.connect client_data_b64 passthrough ─────────────────────

describe('sidecar.connect client_data_b64', () => {
  test('T1: connect sends client_data_b64 when provided', async () => {
    let capturedBody: any;
    const server = Bun.serve({
      port: 0,
      async fetch(req) {
        capturedBody = await req.json();
        return Response.json({ needs_tan: false, client_data: 'RESP_B64', accounts: [] });
      },
    });

    const saved = process.env.BANKING_SIDECAR_URL;
    process.env.BANKING_SIDECAR_URL = `http://127.0.0.1:${server.port}`;
    try {
      const { connect } = await import('../sidecar-client.js');
      await connect({
        session_id: 1,
        blz: '12345678',
        user_id: 'X',
        pin: 'X',
        fints_url: 'https://example.com/fints',
        client_data_b64: 'abc',
      });

      expect(capturedBody).toBeDefined();
      expect(capturedBody.client_data_b64).toBe('abc');
      expect(capturedBody.session_id).toBe(1);
    } finally {
      if (saved) process.env.BANKING_SIDECAR_URL = saved;
      else delete process.env.BANKING_SIDECAR_URL;
      server.stop(true);
    }
  });

  test('T8: connect logs redacted client_data_b64 (not cleartext)', async () => {
    const server = Bun.serve({
      port: 0,
      async fetch() {
        return Response.json({ needs_tan: false, client_data: 'RESPONSE_SECRET', accounts: [] });
      },
    });

    const saved = process.env.BANKING_SIDECAR_URL;
    process.env.BANKING_SIDECAR_URL = `http://127.0.0.1:${server.port}`;
    const logged: string[] = [];
    const origLog = console.log;
    console.log = (...args: any[]) => {
      logged.push(args.map(a => typeof a === 'object' ? JSON.stringify(a) : String(a)).join(' '));
    };
    try {
      const { connect } = await import('../sidecar-client.js');
      await connect({
        session_id: 99,
        blz: '12345678',
        user_id: 'X',
        pin: 'X',
        fints_url: 'https://example.com/fints',
        client_data_b64: 'SUPER_SECRET_B64',
      });

      // Request log must contain redacted marker, NOT cleartext
      const reqLog = logged.find(l => l.includes('connect →'));
      expect(reqLog).toBeDefined();
      expect(reqLog).toContain('<REDACTED:');
      expect(reqLog).not.toContain('SUPER_SECRET_B64');

      // Response log must redact client_data from sidecar response
      const resLog = logged.find(l => l.includes('connect ←'));
      expect(resLog).toBeDefined();
      expect(resLog).toContain('<REDACTED:');
      expect(resLog).not.toContain('RESPONSE_SECRET');
    } finally {
      console.log = origLog;
      if (saved) process.env.BANKING_SIDECAR_URL = saved;
      else delete process.env.BANKING_SIDECAR_URL;
      server.stop(true);
    }
  });

  test('T2: connect sends client_data_b64 as null when null', async () => {
    let capturedBody: any;
    const server = Bun.serve({
      port: 0,
      async fetch(req) {
        capturedBody = await req.json();
        return Response.json({ needs_tan: false, accounts: [] });
      },
    });

    const saved = process.env.BANKING_SIDECAR_URL;
    process.env.BANKING_SIDECAR_URL = `http://127.0.0.1:${server.port}`;
    try {
      const { connect } = await import('../sidecar-client.js');
      await connect({
        session_id: 2,
        blz: '12345678',
        user_id: 'X',
        pin: 'X',
        fints_url: 'https://example.com/fints',
        client_data_b64: null,
      });

      expect(capturedBody).toBeDefined();
      expect(capturedBody.client_data_b64).toBeNull();
    } finally {
      if (saved) process.env.BANKING_SIDECAR_URL = saved;
      else delete process.env.BANKING_SIDECAR_URL;
      server.stop(true);
    }
  });
});

// ── T3-T4: redactClientData ─────────────────────────────────────────────────

describe('redactClientData', () => {
  test('T3: flat object — redacts client_data_b64, preserves other fields', async () => {
    const { redactClientData } = await import('../sidecar-client.js');

    const input = {
      session_id: 1,
      client_data_b64: 'abcdefghij',
      blz: '12345678',
    };
    const result = redactClientData(input);

    expect(result.session_id).toBe(1);
    expect(result.blz).toBe('12345678');
    expect(result.client_data_b64).toBe('<REDACTED:10-chars>');
  });

  test('T4: nested + array — redacts client_data, preserves non-matching', async () => {
    const { redactClientData } = await import('../sidecar-client.js');

    const input = {
      outer: 'kept',
      nested: {
        client_data: 'secret123',
        other: 42,
      },
      list: [
        { client_data_b64: 'xyz', name: 'a' },
        { name: 'b' },
      ],
    };
    const result = redactClientData(input);

    expect(result.outer).toBe('kept');
    expect((result as any).nested.client_data).toBe('<REDACTED:9-chars>');
    expect((result as any).nested.other).toBe(42);
    expect((result as any).list[0].client_data_b64).toBe('<REDACTED:3-chars>');
    expect((result as any).list[0].name).toBe('a');
    expect((result as any).list[1].name).toBe('b');
  });
});

// ── T5-T7: initiateConnect passthrough (DB + mock sidecar) ──────────────────

describe('initiateConnect clientDataB64 passthrough', () => {
  let cleanup: () => Promise<void>;

  beforeAll(async () => {
    const result = await setupTestDb();
    cleanup = result.cleanup;
  });

  afterAll(async () => {
    if (cleanup) await cleanup();
  });

  /** Create a session + institution in the test DB. */
  async function createTestSession(blz: string, bankName: string, userId: string, pin: string) {
    const { upsertInstitution, createSession } = await import('../store.js');
    const inst = await upsertInstitution(blz, bankName, null, 'https://example.com/fints');
    const session = await createSession(inst.id, userId, pin, 'test-product');
    return { institution: inst, session };
  }

  test('T5: initiateConnect with clientDataB64 → sidecar receives client_data_b64', async () => {
    const { session } = await createTestSession('30000001', 'T5b Bank', 'USER_B5', 'PIN555');

    let capturedBody: any;
    const server = Bun.serve({
      port: 0,
      async fetch(req) {
        capturedBody = await req.json();
        return Response.json({ needs_tan: false, client_data: 'NEW_STATE', accounts: [] });
      },
    });

    const saved = process.env.BANKING_SIDECAR_URL;
    process.env.BANKING_SIDECAR_URL = `http://127.0.0.1:${server.port}`;
    try {
      const { initiateConnect } = await import('../tan-bridge.js');
      const result = await initiateConnect(session.id, 'x');

      expect(result.status).toBe('connected');
      expect(capturedBody).toBeDefined();
      expect(capturedBody.client_data_b64).toBe('x');
      expect(capturedBody.session_id).toBe(session.id);
    } finally {
      if (saved) process.env.BANKING_SIDECAR_URL = saved;
      else delete process.env.BANKING_SIDECAR_URL;
      server.stop(true);
    }
  });

  test('T6: initiateConnect with clientDataB64=null → sidecar receives no client_data_b64', async () => {
    const { session } = await createTestSession('30000002', 'T6b Bank', 'USER_B6', 'PIN666');

    let capturedBody: any;
    const server = Bun.serve({
      port: 0,
      async fetch(req) {
        capturedBody = await req.json();
        return Response.json({ needs_tan: false, accounts: [] });
      },
    });

    const saved = process.env.BANKING_SIDECAR_URL;
    process.env.BANKING_SIDECAR_URL = `http://127.0.0.1:${server.port}`;
    try {
      const { initiateConnect } = await import('../tan-bridge.js');
      const result = await initiateConnect(session.id, null);

      expect(result.status).toBe('connected');
      expect(capturedBody).toBeDefined();
      // client_data_b64 should be absent (undefined → omitted by JSON.stringify)
      expect(capturedBody.client_data_b64).toBeUndefined();
    } finally {
      if (saved) process.env.BANKING_SIDECAR_URL = saved;
      else delete process.env.BANKING_SIDECAR_URL;
      server.stop(true);
    }
  });

  test('T7: E2E: initiateConnect → mock sidecar returns client_data → updateSessionState persists', async () => {
    const { session } = await createTestSession('30000003', 'T7b Bank', 'USER_B7', 'PIN777');

    const mockClientData = 'NEW_B64_STATE_DATA';
    const server = Bun.serve({
      port: 0,
      async fetch() {
        return Response.json({
          needs_tan: false,
          client_data: mockClientData,
          accounts: [{ iban: 'DE89370400440532013000', display_name: 'Test Konto' }],
        });
      },
    });

    const saved = process.env.BANKING_SIDECAR_URL;
    process.env.BANKING_SIDECAR_URL = `http://127.0.0.1:${server.port}`;
    try {
      const { initiateConnect } = await import('../tan-bridge.js');
      const result = await initiateConnect(session.id, 'REUSE_B64');

      expect(result.status).toBe('connected');
      expect(result.accountCount).toBe(1);

      // Verify session_state_encrypted was persisted and is decryptable
      const { getDecryptedSession } = await import('../store.js');
      const decrypted = await getDecryptedSession(session.id);
      expect(decrypted).not.toBeNull();
      expect(decrypted!.state).toBe(mockClientData);
    } finally {
      if (saved) process.env.BANKING_SIDECAR_URL = saved;
      else delete process.env.BANKING_SIDECAR_URL;
      server.stop(true);
    }
  });
});
