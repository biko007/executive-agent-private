/**
 * Der Fuhrpark führt seit dem 17.10.2026 auch ein Boot.
 *
 * ANLASS: Die Cranchi T 43 ist als FZG-T43 eingetragen. Das Datenmodell kannte
 * den Typ „boat" bereits; der Morgen-Digest nicht — dort stand fest „TÜV" und
 * ein Motorrad für alles, was kein Auto ist. Ein Boot hat keinen TÜV: Die
 * Zulassungsurkunde nennt eine Nachuntersuchung, und die Zulassung erlischt zu
 * einem Stichtag.
 */
import { describe, test, expect } from 'bun:test';
import { vehicleIcon, pruefungLabel } from '../store.js';

describe('Fahrzeugart im Meldetext', () => {
  test('jede Art hat ihr eigenes Symbol', () => {
    expect(vehicleIcon('car')).toBe('🚗');
    expect(vehicleIcon('boat')).toBe('🚤');
    expect(vehicleIcon('bike')).toBe('🚲');
  });

  test('das Boot wird nicht mehr als Fahrrad gezeigt', () => {
    expect(vehicleIcon('boat')).not.toBe(vehicleIcon('bike'));
    expect(vehicleIcon('boat')).not.toBe(vehicleIcon('car'));
  });

  test('ein Boot hat keinen TÜV', () => {
    expect(pruefungLabel('boat')).toBe('Untersuchung/Zulassung');
    expect(pruefungLabel('boat')).not.toContain('TÜV');
  });

  test('Auto und Fahrrad behalten den TÜV', () => {
    expect(pruefungLabel('car')).toBe('TÜV');
    expect(pruefungLabel('bike')).toBe('TÜV');
  });
});

describe('statischer Waechter gegen den Morgen-Digest', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const quelle = fs.readFileSync(
    path.resolve(import.meta.dir, '..', '..', '..', '..', 'index.ts'), 'utf-8');

  test('der Digest nimmt Symbol und Beschriftung aus dem Modul', () => {
    expect(quelle).toContain('const icon = vehicleIcon(w.vehicleType);');
    expect(quelle).toContain("pruefungLabel(w.vehicleType)");
  });

  test('die feste Beschriftung ist weg', () => {
    expect(quelle).not.toContain("w.field === 'tuev' ? 'TÜV'");
    expect(quelle).not.toContain("w.vehicleType === 'car' ? '🚗' : '🏍'");
  });
});
