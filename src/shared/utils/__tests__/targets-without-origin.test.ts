/**
 * Regressionstest zum Befund "doppelte Quittungen" (2026-10-10).
 *
 * Ein Command-Handler, der selbst an eine Rolle sendet UND einen Antworttext
 * zurueckgibt, erzeugte zwei Nachrichten: das Framework stellt den
 * Rueckgabetext in den Ursprungschat zu, und beim Owner IST der operative Chat
 * seine eigene DM. Bei `/arm push` war der Text wortgleich.
 *
 * `targetsWithoutOrigin` ist die Stelle, an der das entschieden wird: bleibt
 * nach dem Filtern kein Ziel uebrig, entfaellt die Eigensendung und es bleibt
 * bei genau EINER Antwort.
 */
import { describe, test, expect } from 'bun:test';
import { targetsWithoutOrigin } from '../index.js';

const OWNER_DM = '133260792';
const DEV_GRUPPE = '-5378559097';

describe('targetsWithoutOrigin', () => {
  test('Befehl aus dem Rollenchat: kein Ziel bleibt uebrig → genau eine Antwort', () => {
    // Genau der Live-Fall: /arm push aus der Owner-DM, operativ == Owner-DM.
    expect(targetsWithoutOrigin([OWNER_DM], OWNER_DM)).toEqual([]);
  });

  test('Befehl aus einem anderen Chat: die Rolle wird weiterhin informiert', () => {
    // /arm push aus der dev-Gruppe — der operative Chat soll es erfahren.
    expect(targetsWithoutOrigin([OWNER_DM], DEV_GRUPPE)).toEqual([OWNER_DM]);
  });

  test('mehrere Rollenziele: nur der Ursprungschat fliegt heraus', () => {
    expect(targetsWithoutOrigin([OWNER_DM, DEV_GRUPPE], OWNER_DM)).toEqual([DEV_GRUPPE]);
    expect(targetsWithoutOrigin([OWNER_DM, DEV_GRUPPE], DEV_GRUPPE)).toEqual([OWNER_DM]);
  });

  test('Zahl gegen Zeichenkette: Telegram-IDs kommen in beiden Formen', () => {
    expect(targetsWithoutOrigin([OWNER_DM], Number(OWNER_DM) as unknown as string)).toEqual([]);
    expect(targetsWithoutOrigin([` ${OWNER_DM} `], OWNER_DM)).toEqual([]);
  });

  test('negative Gruppen-IDs werden korrekt verglichen', () => {
    expect(targetsWithoutOrigin([DEV_GRUPPE], DEV_GRUPPE)).toEqual([]);
    expect(targetsWithoutOrigin([DEV_GRUPPE], '5378559097')).toEqual([DEV_GRUPPE]);
  });

  test('ohne Ursprungschat bleibt alles stehen — kein stilles Verschlucken', () => {
    // Laesst sich der Ursprung nicht bestimmen, ist eine Meldung zu viel
    // besser als keine.
    expect(targetsWithoutOrigin([OWNER_DM], '')).toEqual([OWNER_DM]);
    expect(targetsWithoutOrigin([OWNER_DM], undefined as unknown as string)).toEqual([OWNER_DM]);
  });

  test('keine Ziele bleiben keine Ziele', () => {
    expect(targetsWithoutOrigin([], OWNER_DM)).toEqual([]);
  });
});
