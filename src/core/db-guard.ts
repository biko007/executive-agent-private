/**
 * db-guard.ts — Fail-closed DB-URL Guard (C1)
 *
 * Schützt vor unbeabsichtigten Schreibzugriffen auf Produktiv-DBs im Test-/
 * Migrations-Kontext. Eingebunden in test-db-setup.ts, inline .test.ts-Setups
 * und Migration-Scripts.
 *
 * Marker: OPENCLAW_TEST=1 (gesetzt in scripts/run-tests.sh)
 */

export const BLOCKED_DBS = ['openclaw_core', 'n8n'];
export const TEST_DB_PATTERN = /^openclaw_test_/;

/**
 * Prüft ob die DB-URL sicher ist.
 * Pure function — kein process.exit, testbar ohne Prozessabbruch.
 * @returns null wenn sicher, reason-string wenn blockiert
 */
export function checkDbUrl(url: string): string | null {
  let dbName: string;
  try {
    const parsed = new URL(url);
    dbName = parsed.pathname.replace(/^\//, '');
  } catch {
    return `DB-URL nicht parsbar: ${url}`;
  }

  if (!dbName) {
    return 'DB-Name ist leer';
  }

  if (BLOCKED_DBS.includes(dbName)) {
    return `DB '${dbName}' ist in der Verbotsliste`;
  }

  if (process.env.OPENCLAW_TEST === '1' && !TEST_DB_PATTERN.test(dbName)) {
    return `OPENCLAW_TEST=1 aber DB '${dbName}' matcht nicht ^openclaw_test_`;
  }

  return null;
}

/**
 * Asserter — ruft process.exit(1) bei Verstoß (fail-closed).
 * Wird direkt nach process.env.POSTGRES_URL = testUrl aufgerufen.
 */
export function assertSafeDbUrl(url: string): void {
  const reason = checkDbUrl(url);
  if (reason !== null) {
    console.error(`[db-guard] BLOCKED: ${reason}`);
    process.exit(1);
  }
}
