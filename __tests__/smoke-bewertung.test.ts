/**
 * Smoke-Bewertung: welche rote Prüfung blockiert welchen Deploy (02.11.2026).
 * Dienst × Prüfergebnis → ok / warnung / blockiert.
 */
import { describe, test, expect } from 'bun:test';
import { einstufung, diensteAusArgumenten, ergebnisZeile } from '../scripts/smoke-bewertung.ts';

const GW = ['openclaw-gateway'];
const DASH = ['openclaw-dashboard'];

describe('einstufung', () => {
  test('bestandene Prüfung ist immer ok', () => {
    for (const d of [GW, DASH, null]) expect(einstufung('Codex-Anmeldung', true, d)).toBe('ok');
  });

  test('Codex-Anmeldung rot: blockiert nur das Gateway', () => {
    expect(einstufung('Codex-Anmeldung', false, GW)).toBe('blockiert');
    expect(einstufung('Codex-Anmeldung', false, DASH)).toBe('warnung');
    expect(einstufung('Codex-Anmeldung', false, ['openclaw-trading'])).toBe('warnung');
    expect(einstufung('Codex-Anmeldung', false, ['openclaw-banking-fints'])).toBe('warnung');
    expect(einstufung('Codex-Anmeldung', false, ['openclaw-pdf-worker'])).toBe('warnung');
  });

  test('mehrere Dienste: blockiert, sobald das Gateway dabei ist', () => {
    expect(einstufung('Codex-Anmeldung', false, ['openclaw-dashboard', 'openclaw-gateway'])).toBe('blockiert');
    expect(einstufung('Codex-Anmeldung', false, ['openclaw-dashboard', 'openclaw-trading'])).toBe('warnung');
  });

  test('Modellroute folgt derselben Regel', () => {
    expect(einstufung('Agentenpfad (Modellroute)', false, GW)).toBe('blockiert');
    expect(einstufung('Agentenpfad (Modellroute)', false, DASH)).toBe('warnung');
  });

  test('ohne Deploy-Kontext bleibt jede rote Prüfung ein Fehler', () => {
    expect(einstufung('Codex-Anmeldung', false, null)).toBe('blockiert');
    expect(einstufung('Dashboard HTTP', false, null)).toBe('blockiert');
  });

  test('dienstfremde Prüfungen blockieren weiterhin jeden Deploy', () => {
    for (const d of [GW, DASH]) {
      expect(einstufung('Dashboard HTTP', false, d)).toBe('blockiert');
      expect(einstufung('env-Datei', false, d)).toBe('blockiert');
    }
  });

  test('cc-Login ist reine Frühwarnung und blockiert nie', () => {
    for (const d of [GW, DASH, null]) expect(einstufung('cc-Login', false, d)).toBe('warnung');
  });

  test('ähnliche Namen werden nicht verwechselt', () => {
    expect(einstufung('codex-anmeldung', false, DASH)).toBe('blockiert');
    expect(einstufung('Codex-Anmeldung ', false, DASH)).toBe('blockiert');
  });
});

describe('diensteAusArgumenten', () => {
  test('liest die Liste, sonst null', () => {
    expect(diensteAusArgumenten(['bun', 'x', '--dienste=openclaw-dashboard,openclaw-trading']))
      .toEqual(['openclaw-dashboard', 'openclaw-trading']);
    expect(diensteAusArgumenten(['bun', 'x', '--notify'])).toBeNull();
    expect(diensteAusArgumenten(['--dienste='])).toBeNull();
    expect(diensteAusArgumenten(['--dienste= openclaw-gateway ,'])).toEqual(['openclaw-gateway']);
  });
});

describe('ergebnisZeile', () => {
  test('Zählweise mit und ohne Warnungen', () => {
    expect(ergebnisZeile({ ok: 36, warnungen: 0, blockiert: 0 })).toBe('RESULT: ALL PASS (36/36)');
    expect(ergebnisZeile({ ok: 36, warnungen: 1, blockiert: 0 })).toBe('RESULT: ALL PASS (36/36 + 1 Warnung)');
    expect(ergebnisZeile({ ok: 36, warnungen: 2, blockiert: 0 })).toBe('RESULT: ALL PASS (36/36 + 2 Warnungen)');
    expect(ergebnisZeile({ ok: 35, warnungen: 1, blockiert: 1 })).toBe('RESULT: FAIL (35/36 passed, 1 Warnung)');
    expect(ergebnisZeile({ ok: 36, warnungen: 0, blockiert: 1 })).toBe('RESULT: FAIL (36/37 passed)');
  });
});

describe('deploy.sh nutzt die Bewertung', () => {
  const { readFileSync } = require('node:fs');
  const { resolve } = require('node:path');
  const text: string = readFileSync(resolve(import.meta.dir, '..', 'scripts', 'deploy.sh'), 'utf-8');

  test('Smoke-Test bekommt die Dienstliste', () => {
    expect(text).toContain('bun run scripts/smoke-test.ts --dienste="$dienste"');
  });

  test('Alarm nach Rückfall nur bei krankem Dienst, nicht bei rotem Smoke', () => {
    const rueckfall = text.slice(text.indexOf('# Ueber den Alarm entscheidet allein'));
    const alarm = rueckfall.indexOf('notify "ROLLBACK FAILED');
    expect(alarm).toBeGreaterThan(0);
    // der einzige ALARM-Zweig hängt an health_check_all, nicht an run_smoke
    expect(rueckfall.slice(0, alarm)).toContain('if ! health_check_all "${SERVICES[@]}"; then');
    expect(rueckfall.slice(0, alarm)).not.toContain('run_smoke');
    expect(rueckfall).toContain('Dienst gesund, Smoke weiterhin rot');
  });
});

// ── Codex-Anmeldung: bald ablaufend = Warnung, abgelaufen = Fehler (09.11.2026) ──
import { codexAblaufStufe, CODEX_WARN_TAGE } from '../scripts/smoke-bewertung.ts';

describe('codexAblaufStufe', () => {
  test('bald ablaufend (unter 3 Tagen) → Warnung', () => {
    expect(CODEX_WARN_TAGE).toBe(3);
    expect(codexAblaufStufe(2.8)).toBe('warnung');
    expect(codexAblaufStufe(0.01)).toBe('warnung');
  });
  test('abgelaufen → Fehler', () => {
    expect(codexAblaufStufe(-0.1)).toBe('fehler');
    expect(codexAblaufStufe(Number.NaN)).toBe('fehler');
  });
  test('genug Restlaufzeit → ok', () => {
    expect(codexAblaufStufe(3)).toBe('ok');
    expect(codexAblaufStufe(40)).toBe('ok');
  });
});
