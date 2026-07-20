/**
 * db-guard.test.ts — Unit-Tests für src/core/db-guard.ts
 *
 * Testet checkDbUrl() direkt (kein process.exit).
 * Alle Tests manipulieren process.env.OPENCLAW_TEST lokal und stellen zurück.
 */
import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { checkDbUrl } from '../db-guard.js';

let savedOpenclawTest: string | undefined;

beforeEach(() => {
  savedOpenclawTest = process.env.OPENCLAW_TEST;
  delete process.env.OPENCLAW_TEST;
});

afterEach(() => {
  if (savedOpenclawTest === undefined) {
    delete process.env.OPENCLAW_TEST;
  } else {
    process.env.OPENCLAW_TEST = savedOpenclawTest;
  }
});

describe('checkDbUrl', () => {
  it('blockiert openclaw_core (Verbotsliste)', () => {
    const reason = checkDbUrl('postgresql://openclaw:pw@127.0.0.1:5432/openclaw_core');
    expect(reason).not.toBeNull();
    expect(reason).toContain('openclaw_core');
  });

  it('blockiert n8n (Verbotsliste)', () => {
    const reason = checkDbUrl('postgresql://openclaw:pw@127.0.0.1:5432/n8n');
    expect(reason).not.toBeNull();
    expect(reason).toContain('n8n');
  });

  it('blockiert nicht parsbare URL (fail-closed)', () => {
    const reason = checkDbUrl('nicht-eine-url');
    expect(reason).not.toBeNull();
  });

  it('blockiert URL mit leerem DB-Namen', () => {
    const reason = checkDbUrl('postgresql://openclaw:pw@127.0.0.1:5432/');
    expect(reason).not.toBeNull();
    expect(reason).toContain('leer');
  });

  it('erlaubt openclaw_test_* mit OPENCLAW_TEST=1', () => {
    process.env.OPENCLAW_TEST = '1';
    const reason = checkDbUrl('postgresql://openclaw:pw@127.0.0.1:5432/openclaw_test_assets_1234_56');
    expect(reason).toBeNull();
  });

  it('erlaubt beliebige DB ohne OPENCLAW_TEST', () => {
    // OPENCLAW_TEST nicht gesetzt — keine Test-Muster-Prüfung
    const reason = checkDbUrl('postgresql://openclaw:pw@127.0.0.1:5432/some_other_db');
    expect(reason).toBeNull();
  });

  it('blockiert Nicht-Test-DB mit OPENCLAW_TEST=1', () => {
    process.env.OPENCLAW_TEST = '1';
    const reason = checkDbUrl('postgresql://openclaw:pw@127.0.0.1:5432/some_other_db');
    expect(reason).not.toBeNull();
    expect(reason).toContain('openclaw_test_');
  });
});
