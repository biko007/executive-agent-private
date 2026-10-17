/**
 * Objektfristen — wann gemeldet wird und wann nicht.
 *
 * ANLASS (Owner, 17.10.2026): `objekt_fristen` stand bis dahin nur auf der
 * Objektkachel. Am 17.10. war nachgewiesen, dass der Tageslauf 0 Zeilen prüft,
 * obwohl zwei Fristen eingetragen waren — die Erinnerung kam nie.
 *
 * Die Regel lautet seither:
 *   - am Tag (Termin − Vorlauftage), falls Vorlauf > 0,
 *   - am Termin selbst,
 *   - danach TÄGLICH als überfällig, bis `erledigt_am` gesetzt ist.
 *
 * Der Vorlauf meldet GENAU am Stichtag und nicht an jedem Tag danach: Sonst
 * stünde dieselbe Frist 45 Morgen lang im Chat, und niemand liest sie mehr.
 */
import { describe, test, expect } from 'bun:test';
import { fristPhase, fristMeldung } from '../alerts.js';

describe('Welche Phase heute gilt', () => {
  test('am Vorlauftag — und nur dort', () => {
    expect(fristPhase(45, 45)).toBe('vorlauf');
    expect(fristPhase(46, 45)).toBeNull();
    expect(fristPhase(44, 45)).toBeNull();
  });

  test('am Termin', () => {
    expect(fristPhase(0, 45)).toBe('termin');
    expect(fristPhase(0, 0)).toBe('termin');
  });

  test('danach täglich überfällig', () => {
    for (const tage of [-1, -2, -30, -400]) {
      expect(fristPhase(tage, 45), String(tage)).toBe('ueberfaellig');
    }
  });

  test('ohne Vorlauf gibt es vorher keine Meldung', () => {
    /* Die Wiedervorlage energiekonzept hat vorlauf_tage = 0: Sie soll am
       22.10.2026 melden, nicht vorher. */
    expect(fristPhase(5, 0)).toBeNull();
    expect(fristPhase(1, 0)).toBeNull();
    expect(fristPhase(0, 0)).toBe('termin');
  });

  test('zwischen Vorlauf und Termin ist Ruhe', () => {
    for (const tage of [1, 7, 20, 44]) {
      expect(fristPhase(tage, 45), String(tage)).toBeNull();
    }
  });
});

describe('Der Meldetext', () => {
  const frist = {
    frist_id: 1, property_code: 'N24', art: 'wiedervorlage',
    bezeichnung: 'energiekonzept: finale Jahresabrechnung 2025 anmahnen',
    termin: '2026-10-22', vorlauf_tage: 0, tage_bis: 5, verantwortlich: 'owner',
  };

  test('nennt Objekt, Sache und Termin im deutschen Format', () => {
    const t = fristMeldung({ ...frist, tage_bis: 45 }, 'vorlauf');
    expect(t).toContain('N24');
    expect(t).toContain('energiekonzept');
    expect(t).toContain('22.10.2026');
    expect(t).toContain('45 Tagen');
  });

  test('am Termin steht HEUTE', () => {
    expect(fristMeldung({ ...frist, tage_bis: 0 }, 'termin')).toContain('HEUTE');
  });

  test('überfällig nennt die Zahl der Tage und wie es aufhört', () => {
    const t = fristMeldung({ ...frist, tage_bis: -3 }, 'ueberfaellig');
    expect(t).toContain('ÜBERFÄLLIG');
    expect(t).toContain('3 Tagen');
    expect(t).toContain('erledigt');
  });

  test('ein Tag steht im Singular', () => {
    expect(fristMeldung({ ...frist, tage_bis: -1 }, 'ueberfaellig')).toContain('seit 1 Tag.');
  });
});

describe('statische Guards gegen alerts.ts und routes.ts', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const alerts = fs.readFileSync(path.resolve(import.meta.dir, '..', 'alerts.ts'), 'utf-8');
  const routes = fs.readFileSync(
    path.resolve(import.meta.dir, '..', '..', 'assets', 'routes.ts'), 'utf-8');

  test('der Tageslauf ruft beide Wege auf', () => {
    expect(routes).toContain('const nk = await handleObligationsAlert();');
    expect(routes).toContain('const fristen = await handleFristenAlert();');
  });

  test('die Zustellung geht in den Owner-DM, nicht nach dev', () => {
    /* Ohne Rolle nimmt die Notify-Route `operativ`. Eine Frist, die der Owner
       persönlich einhalten muss, gehört dorthin. */
    const block = alerts.slice(alerts.indexOf('async function sendeFristmeldung'));
    expect(block).toContain('/api/internal/notify');
    expect(block).not.toContain("role: 'dev'");
  });

  test('das Protokoll liegt in system_settings, nicht in nk_alert_log', () => {
    /* nk_alert_log hat einen Fremdschlüssel auf nk_period_obligations und eine
       CHECK-Liste der NK-Phasen — es kann diese Meldungen nicht aufnehmen. */
    expect(alerts).toContain("'fristen_alarm_log'");
    const block = alerts.slice(alerts.indexOf('export async function handleFristenAlert'));
    expect(block).not.toContain('nk_alert_log');
  });

  test('nur offene Fristen werden geprüft', () => {
    expect(alerts).toContain('WHERE f.erledigt_am IS NULL');
  });
});
