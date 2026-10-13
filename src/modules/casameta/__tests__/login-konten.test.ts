/**
 * Mehrere Casameta-Zugaenge — je Objekt einer.
 *
 * WARUM DIESE TESTS. Casameta fuehrt pro Objekt ein eigenes Konto (Owner-Angabe
 * 13.10.2026). Zwei Dinge duerfen dabei nie passieren:
 *   1. Die Konten teilen sich ein Browserprofil oder einen Sitzungszustand —
 *      dann verdraengt die Anmeldung am zweiten Objekt die des ersten, und es
 *      ist nicht mehr feststellbar, in wessen Abrechnung geschrieben wird.
 *   2. Eine Auskunftsfunktion gibt einen hinterlegten Wert preis.
 * Beides pruefen diese Tests.
 */
import { describe, test, expect } from 'bun:test';
import {
  envSchluessel, kontoPfade, hinterlegteKonten, KONTEN,
} from '../../../../scripts/casameta-login.ts';

describe('Casameta-Konten', () => {
  test('Env-Schluessel tragen den Objektteil', () => {
    expect(envSchluessel('mg24')).toEqual({
      benutzer: 'CASAMETA_MG24_USER', passwort: 'CASAMETA_MG24_PASSWORD',
    });
    expect(envSchluessel('n24')).toEqual({
      benutzer: 'CASAMETA_N24_USER', passwort: 'CASAMETA_N24_PASSWORD',
    });
  });

  test('ohne Objekt gelten die alten Schluessel weiter', () => {
    expect(envSchluessel()).toEqual({
      benutzer: 'CASAMETA_USER', passwort: 'CASAMETA_PASSWORD',
    });
  });

  test('Kleinschreibung spielt keine Rolle', () => {
    expect(envSchluessel('MG24')).toEqual(envSchluessel('mg24'));
  });

  test('jedes Konto hat ein eigenes Profil und einen eigenen Sitzungszustand', () => {
    const a = kontoPfade('mg24');
    const b = kontoPfade('n24');
    expect(a.profil).not.toBe(b.profil);
    expect(a.zustand).not.toBe(b.zustand);
    // und keiner liegt im Pfad des anderen
    expect(a.profil.startsWith(b.profil)).toBe(false);
    expect(b.profil.startsWith(a.profil)).toBe(false);
  });

  test('Pfade enthalten die Objektkennung', () => {
    for (const k of KONTEN) {
      expect(kontoPfade(k).profil).toContain(`/konten/${k}/`);
    }
  });

  test('ohne Objekt bleiben die Altpfade erhalten', () => {
    const o = kontoPfade();
    expect(o.profil.endsWith('/casameta/profile')).toBe(true);
    expect(o.zustand.endsWith('/casameta/storage_state.json')).toBe(true);
    expect(o.profil).not.toContain('/konten/');
  });

  test('hinterlegteKonten nennt nur Kennungen, nie Werte', () => {
    const k = hinterlegteKonten();
    expect(Array.isArray(k)).toBe(true);
    for (const eintrag of k) {
      /* Ein Benutzername waere eine E-Mail-Adresse, ein Passwort stuende hinter
         einem Gleichheitszeichen. Beides darf hier nicht auftauchen. */
      expect(eintrag).not.toContain('@');
      expect(eintrag).not.toContain('=');
      expect(eintrag.length).toBeLessThanOrEqual(20);
    }
  });
});
