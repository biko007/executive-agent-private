#!/usr/bin/env bun
/**
 * scripts/arm-vormerken — den wartenden roten Schritt anmelden.
 *
 * Wenn cc vor einem roten Schritt stehen bleibt, legt es hier in einem Satz
 * ab, worum es geht. Sendet der Owner danach `/arm`, nennt die Quittung genau
 * diesen Satz, statt nur „Freigabe gesetzt" zu sagen.
 *
 * DAS GIBT NICHTS FREI. Die Vormerkung ist eine Beschriftung: Sie erweitert
 * keine Befugnis, verlaengert keine Frist und ersetzt keine Pruefung. cc kann
 * sich damit nicht selbst scharfstellen — das Flag setzt weiterhin allein der
 * Owner ueber Telegram.
 *
 * Aufruf:
 *   bun run scripts/arm-vormerken.ts "Migration V043 anwenden und 104 Werte schreiben" weiter
 *   bun run scripts/arm-vormerken.ts "vier Commits uebertragen" push
 *   bun run scripts/arm-vormerken.ts --loeschen
 *   bun run scripts/arm-vormerken.ts --zeigen
 *
 * Das zweite Argument ist das Wort, das die wartende Sitzung anstoesst:
 * „push" fuer eine Uebertragung, „weiter" fuer alles andere (Vorgabe). Ein
 * leeres drittes Wort bedeutet: nur freigeben, nichts anstossen.
 */
import { homedir } from 'node:os';
import { join } from 'node:path';
import {
  vormerkungLesen, vormerkungSchreiben, vormerkungLoeschen, vormerkungPfad,
  ANSTOSS_ERLAUBT,
} from '../src/modules/arm-freigabe/vormerkung.js';

const FLAGGE = join(homedir(), '.armed-bikosoc');
const argumente = process.argv.slice(2);

if (argumente.includes('--loeschen')) {
  vormerkungLoeschen(FLAGGE);
  console.log('Vormerkung entfernt.');
  process.exit(0);
}

if (argumente.includes('--zeigen') || argumente.length === 0) {
  const v = vormerkungLesen(FLAGGE);
  if (!v) {
    console.log('Keine gueltige Vormerkung.');
    console.log(`Datei: ${vormerkungPfad(FLAGGE)}`);
    process.exit(argumente.length === 0 ? 1 : 0);
  }
  console.log(`Schritt:  ${v.schritt}`);
  console.log(`Anstoss:  ${v.anstoss || '(keiner)'}`);
  console.log(`Gestellt: ${new Date(v.gestellt).toISOString()}`);
  process.exit(0);
}

const schritt = argumente[0];
const anstoss = argumente[1] ?? 'weiter';

try {
  const v = vormerkungSchreiben(FLAGGE, schritt, anstoss);
  console.log('Vorgemerkt. Der naechste /arm nennt dem Owner diesen Schritt:');
  console.log(`  ${v.schritt}`);
  console.log(`  Anstoss: ${v.anstoss || '(keiner — nur freigeben)'}`);
} catch (e: any) {
  console.error(e.message);
  console.error(`Erlaubte Anstoesse: ${ANSTOSS_ERLAUBT.map((a) => a || '(leer)').join(', ')}`);
  process.exit(2);
}
