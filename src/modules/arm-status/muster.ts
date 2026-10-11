/**
 * arm-status/muster — Rote Pfade und offene Migrationen erkennen.
 *
 * Reine Funktionen auf Texten und Listen: keine Git-Aufrufe, keine Datenbank.
 * So sind auch die Fehlalarm-Fälle prüfbar.
 *
 * HINTERGRUND. Der Leerlauf-Wächter meldet eine wartende Armierung bisher nur,
 * wenn der Deny-Hook eine Blockade protokolliert hat — also nur, wenn der rote
 * Schritt wirklich VERSUCHT wurde. Weiß Claude Code vorher, dass er blockiert
 * würde, versucht es ihn gar nicht; dann steht nichts im Protokoll und niemand
 * erfährt, dass der Owner gebraucht wird.
 *
 * Diese Lücke wird über TATSACHEN geschlossen, nicht über Textdeutung in
 * Berichten (ein erster Versuch darüber schlug auf Prosa an und ist deshalb
 * verworfen worden):
 *
 *   1. Liegt in den noch nicht gepushten Commits ein roter Pfad?
 *   2. Liegt eine Migrationsdatei vor, deren Version nicht in `schema_version`
 *      steht?
 *
 * Beides ist eine Abfrage mit einer eindeutigen Antwort.
 */

/**
 * Liest die Pfadmuster aus `red-zone.conf`.
 *
 * Die Datei hat Abschnitte `[red-paths]` und `[red-commands]`; hier zaehlt nur
 * der erste. Kommentarzeilen beginnen mit `#`, Leerzeilen werden übergangen.
 * Maßgeblich ist allein diese Datei — eine zweite Liste im Code wäre genau der
 * Weg, auf dem sich beide auseinanderentwickeln.
 */
export function lesePfadMuster(konfig: string): string[] {
  const muster: string[] = [];
  let imAbschnitt = false;
  for (const rohzeile of (konfig || '').split('\n')) {
    const zeile = rohzeile.trim();
    if (zeile.startsWith('[')) {
      imAbschnitt = zeile === '[red-paths]';
      continue;
    }
    if (!imAbschnitt || !zeile || zeile.startsWith('#')) continue;
    muster.push(zeile);
  }
  return muster;
}

/**
 * Passt ein Pfad auf ein Muster der roten Zone?
 *
 * Der Hook vergleicht mit `[[ "$f" == $pattern ]]`. Dort überspannt `*` auch
 * Schraegstriche: Ein Sternchen-Muster auf `…/migrations/….sql` trifft deshalb
 * auch `src/modules/banking/migrations/V040__x.sql`. Diese Umsetzung hält sich
 * bewusst an dasselbe Verhalten: Eine abweichende Auslegung hier würde
 * Pfade melden, die der Hook durchlässt, oder umgekehrt.
 */
export function istRoterPfad(pfad: string, muster: string[]): string | null {
  for (const m of muster) {
    // Ein oder mehrere Sternchen werden gleich behandelt: In bash überspannt
    // schon ein einzelnes `*` beim Vergleich mit `==` auch Schrägstriche, `**`
    // bedeutet dort also nichts anderes. Beide in EINEM Schritt zu ersetzen
    // vermeidet einen Platzhalter — ein erster Entwurf benutzte dafür ein
    // Leerzeichen, und der Übersetzer machte daraus zwei verschiedene Zeichen,
    // sodass kein `**`-Muster mehr traf.
    const regex = new RegExp('^' + m
      .replace(/[.+^${}()|[\]\\]/g, '\\$&')
      .replace(/\*+/g, '.*')
      .replace(/\?/g, '.') + '$');
    if (regex.test(pfad)) return m;
  }
  return null;
}

export interface MigrationsDatei {
  /** Modul, unter dem die Version in `schema_version` steht. */
  modul: string;
  version: number;
  pfad: string;
}

/**
 * Zerlegt einen Migrationspfad in Modul und Version.
 *
 * `src/modules/assets/migrations/V041__heizkosten.sql` → assets / 41
 * `src/shared/settings/migrations/035_system_settings.sql` → null
 *
 * Nur Dateien mit `V`-Vorsatz zählen. Die Dateien mit Zahlenvorsatz (`0xx_`)
 * sind Boot-Zeit-Migrationen, die der Dienst beim Start selbst anwendet — sie
 * brauchen keine Armierung und keinen Owner.
 */
export function zerlegeMigration(pfad: string): MigrationsDatei | null {
  const m = pfad.match(/^src\/(?:modules|shared)\/([^/]+)\/migrations\/V(\d+)__/);
  if (!m) return null;
  return { modul: m[1], version: parseInt(m[2], 10), pfad };
}

/**
 * Welche Migrationsdateien sind noch nicht angewendet?
 *
 * `angewendet` ist die Menge der Paare `modul:version` aus `schema_version`.
 */
export function offeneMigrationen(
  dateien: string[],
  angewendet: Set<string>,
): MigrationsDatei[] {
  const out: MigrationsDatei[] = [];
  for (const pfad of dateien) {
    const m = zerlegeMigration(pfad);
    if (!m) continue;
    if (angewendet.has(`${m.modul}:${m.version}`)) continue;
    out.push(m);
  }
  return out.sort((a, b) => a.version - b.version);
}

export interface ArmBedarf {
  wartet: boolean;
  /** Was den Owner braucht, in Klartext. */
  gegenstand?: string;
  /** Woran es erkannt wurde — für den Report und das Protokoll. */
  quelle?: 'ungepushter_roter_pfad' | 'migration_nicht_angewendet';
  /** Ein stabiler Schlüssel, damit dieselbe Lage nur einmal gemeldet wird. */
  kennung?: string;
}

/**
 * Setzt die gesammelten Tatsachen zu einer Aussage zusammen.
 *
 * Reihenfolge: Ein ungepushter roter Pfad ist der dringendere Fall — dort
 * liegt fertige Arbeit, die nicht beim Owner ankommt. Eine nicht angewendete
 * Migration kann dagegen auch bewusst warten.
 */
export function fasseArmBedarf(fakten: {
  rotePfadeUngepusht: { pfad: string; muster: string }[];
  offeneMigrationen: MigrationsDatei[];
}): ArmBedarf {
  if (fakten.rotePfadeUngepusht.length > 0) {
    const liste = fakten.rotePfadeUngepusht.slice(0, 3).map(r => r.pfad);
    const rest = fakten.rotePfadeUngepusht.length - liste.length;
    return {
      wartet: true,
      quelle: 'ungepushter_roter_pfad',
      gegenstand: `${fakten.rotePfadeUngepusht.length} noch nicht gepushte Änderung`
        + `${fakten.rotePfadeUngepusht.length === 1 ? '' : 'en'} an rotem Pfad: `
        + liste.join(', ') + (rest > 0 ? ` und ${rest} weitere` : ''),
      kennung: 'push:' + fakten.rotePfadeUngepusht.map(r => r.pfad).sort().join('|'),
    };
  }

  if (fakten.offeneMigrationen.length > 0) {
    const liste = fakten.offeneMigrationen.map(m => `${m.modul} V${m.version}`);
    return {
      wartet: true,
      quelle: 'migration_nicht_angewendet',
      gegenstand: `${liste.length} Migration${liste.length === 1 ? '' : 'en'} liegt vor, `
        + `aber nicht angewendet: ${liste.join(', ')}`,
      kennung: 'apply:' + liste.sort().join('|'),
    };
  }

  return { wartet: false };
}
