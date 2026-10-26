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
import { fristPhase, fristMeldung, fristLage } from '../alerts.js';

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
    const m = fristMeldung({ ...frist, tage_bis: 45 }, 'vorlauf');
    expect(m.titel).toBe('Frist in 45 Tagen');
    const text = m.zeilen.join(' · ');
    expect(text).toContain('N24');
    expect(text).toContain('energiekonzept');
    expect(text).toContain('22.10.2026');
  });

  test('am Termin sagt der Titel heute', () => {
    expect(fristMeldung({ ...frist, tage_bis: 0 }, 'termin').titel).toBe('Frist heute');
  });

  test('überfällig nennt die Zahl der Tage und wie es aufhört', () => {
    const m = fristMeldung({ ...frist, tage_bis: -3 }, 'ueberfaellig');
    expect(m.titel).toBe('Frist überfällig');
    const text = m.zeilen.join(' · ');
    expect(text).toContain('seit 3 Tagen');
    expect(text).toContain('erledigt');
  });

  test('ein Tag steht im Singular', () => {
    const m = fristMeldung({ ...frist, tage_bis: -1 }, 'ueberfaellig');
    const text = m.zeilen.join(' · ');
    expect(text).toContain('seit 1 Tag');
    expect(text).not.toContain('seit 1 Tagen');
  });

  /* GESTALTUNG (Owner-Auftrag 14.10.2026): Das Symbol setzt systemNachricht()
     aus der Lage. Traegt der Text selbst eines, steht es doppelt da — genau
     der Befund, der am 17.10.2026 aufgefallen ist. */
  test('der Text traegt kein eigenes Symbol und kein HTML', () => {
    for (const phase of ['vorlauf', 'termin', 'ueberfaellig']) {
      const m = fristMeldung({ ...frist, tage_bis: phase === 'ueberfaellig' ? -2 : 0 }, phase);
      const alles = [m.titel, ...m.zeilen].join(' ');
      expect(alles, phase).not.toMatch(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/u);
      expect(alles, phase).not.toContain('<');
      expect(alles, phase).not.toContain('\n');
    }
  });

  test('keine Zeile schreit in Grossbuchstaben', () => {
    /* „Frist UEBERFAELLIG" war eine Eigenart dieser Meldung; die uebrigen
       Systemmeldungen schreiben normal. */
    const m = fristMeldung({ ...frist, tage_bis: -3 }, 'ueberfaellig');
    expect(m.titel).toBe('Frist überfällig');
  });

  test('die Lage passt zur Phase', () => {
    expect(fristLage('vorlauf')).toBe('hinweis');
    expect(fristLage('termin')).toBe('aktion');
    expect(fristLage('ueberfaellig')).toBe('fehler');
  });
});

describe('statische Guards gegen alerts.ts und routes.ts', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const alerts = fs.readFileSync(path.resolve(import.meta.dir, '..', 'alerts.ts'), 'utf-8');
  const routes = fs.readFileSync(
    path.resolve(import.meta.dir, '..', '..', 'assets', 'routes.ts'), 'utf-8');

  test('der Tageslauf ruft beide Wege auf', () => {
    expect(routes).toContain('const nk = await handleObligationsAlert({ senden: !imBriefing });');
    expect(routes).toContain('const fristen = await handleFristenAlert({ senden: !imBriefing });');
  });

  test('eigene Meldung nur, wenn das Morgenbriefing NICHT zugestellt ist (26.10.2026)', () => {
    /* Die Fristen stehen seit 26.10.2026 im Morgenbriefing. Fällt es aus,
       muss der Tageslauf wie früher selbst melden — sonst ginge eine Frist
       still verloren. Ein Lesefehler zählt als „nicht zugestellt". */
    expect(routes).toContain("const imBriefing = await istZugestellt('morgen', berlinDate(0)).catch(() => false);");
    expect(alerts).toContain('const senden = opts.senden !== false;');
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
