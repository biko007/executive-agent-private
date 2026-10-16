/**
 * Rote Befehlsmuster greifen nur an einer Befehlsposition.
 *
 * ANLASS (Owner, 16.10.2026): „Fix den Bug". Am selben Tag haben zwei
 * Owner-Freigaben Lesebefehle bezahlt:
 *
 *   10:12  ein Report wurde geschrieben, dessen Tabelle ein rotes Muster zitiert
 *   10:25  ein `grep`, das in einer Skriptdatei nach einem Schalter suchte
 *
 * Beide haben die Datenbank nicht angefasst. Beide haben eine Freigabe
 * vernichtet, die für etwas anderes erteilt war. Der Hook verglich das Muster
 * gegen den gesamten Befehlstext; eine blosse Erwähnung genügte.
 *
 * Diese Tests fahren den echten Hook in einer Wegwerf-Umgebung: eigenes HOME,
 * eigene red-zone.conf. Geprüft wird beides — dass Lesen durchgeht UND dass
 * echte Aufrufe in jeder Verpackung rot bleiben. Der zweite Teil ist der
 * wichtigere: Eine Verankerung, die zu viel durchlässt, wäre schlimmer als
 * der Fehler, den sie behebt.
 */
import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { mkdtempSync, writeFileSync, rmSync, mkdirSync, chmodSync, copyFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

const HOOK = resolve(import.meta.dir, '..', 'hooks', 'deny-destructive.sh');

/* Die Muster werden zusammengesetzt. Stünden sie als Literal in dieser Datei,
   würde schon das Lesen der Datei durch ein Werkzeug den Hook auslösen — genau
   der Fehler, um den es geht. */
const KERN = 'openclaw' + '_core';
const SCHALTER = '--' + 'apply';
const MIGRIEREN = 'migrate' + '.*' + SCHALTER;
const LOESCHEN = '(de' + 'lete|dr' + 'op|tr' + 'unc)[a-z]*';

let heim: string;
let conf: string;

beforeAll(() => {
  heim = mkdtempSync(join(tmpdir(), 'rotzone-'));
  mkdirSync(join(heim, '.config', 'openclaw'), { recursive: true });
  conf = join(heim, '.config', 'openclaw', 'red-zone.conf');
  writeFileSync(conf, [
    '[red-paths]',
    '*/migrations/*.sql',
    '',
    '[red-commands]',
    MIGRIEREN,
    'psql.*' + KERN,
    'npm\\s+publish',
    'docker\\s+push',
    '~' + LOESCHEN + '.*' + KERN,   // Tilde: ueberall
    '',
  ].join('\n'));
  mkdirSync(join(heim, 'bin'), { recursive: true });
});

afterAll(() => rmSync(heim, { recursive: true, force: true }));

/** Den Hook mit einem Bash-Befehl füttern. Gibt den Exit-Code zurück. */
function pruefe(command: string, armed = false): { code: number; meldung: string } {
  const flagge = join(heim, '.armed-bikosoc');
  if (armed) writeFileSync(flagge, 'armed by test\n');
  else rmSync(flagge, { force: true });

  const eingabe = JSON.stringify({
    tool_name: 'Bash',
    tool_input: { command },
    cwd: heim,
  });
  const r = spawnSync('bash', [HOOK], {
    input: eingabe,
    env: { ...process.env, HOME: heim, RED_ZONE_CONF: conf, HOOK_LOG: join(heim, 'hooks.log') },
    encoding: 'utf-8',
  });
  return { code: r.status ?? -1, meldung: `${r.stdout ?? ''}${r.stderr ?? ''}` };
}

/** Blockiert der Hook? Exit 2 = Block. */
const blockiert = (c: string) => pruefe(c).code === 2;

describe('Lesen verbraucht keine Freigabe mehr', () => {
  const harmlos: Array<[string, string]> = [
    ['grep nach dem Schalter in einer Datei',
      `grep -n "argv|${SCHALTER}|process.exit" scripts/migrate-sprint5-assets.ts`],
    ['dieselbe Suche hinter einem Semikolon',
      `head -20 scripts/migrate-sprint5-assets.ts; grep -n "${SCHALTER}" scripts/migrate-sprint5-assets.ts`],
    ['rg über das Repo',
      `rg "migrate.*${SCHALTER}" --type ts`],
    ['cat einer Datei, die das Muster enthält',
      `cat docs/projekt/Arm-Freigabe.md`],
    ['echo mit dem Mustertext',
      `echo "roter Befehl: migrate … ${SCHALTER}"`],
    ['Hier-Dokument, Muster in Backticks',
      `cat > report.md <<'EOF'\nDer rote Befehl hei\u00dft \`migrate … ${SCHALTER}\`.\nEOF`],
    ['Hier-Dokument, Muster im Fliesstext',
      `cat > report.md <<'EOF'\nFrueher verbrauchte migrate mit ${SCHALTER} jede Freigabe.\nEOF`],
    ['Dateiliste',
      `ls scripts/ | grep -iE "backup|migrate"`],
    ['git log nach dem Begriff',
      `git log --oneline --grep "migrate"`],
  ];

  for (const [name, befehl] of harmlos) {
    test(name, () => {
      expect(blockiert(befehl), befehl).toBe(false);
    });
  }
});

describe('Echte Aufrufe bleiben rot', () => {
  const rot: Array<[string, string]> = [
    ['direkt über den Läufer',
      `bun run scripts/migrate-steckbrief.ts ${SCHALTER}`],
    ['nach &&',
      `npm run build && bun run scripts/migrate-steckbrief.ts ${SCHALTER}`],
    ['nach einem Semikolon',
      `cd /repo; bun run scripts/migrate-steckbrief.ts ${SCHALTER}`],
    ['über bash -c',
      `bash -c "bun run scripts/migrate-steckbrief.ts ${SCHALTER}"`],
    ['über npx',
      `npx tsx scripts/migrate-steckbrief.ts ${SCHALTER}`],
    ['mit vorangestellter Umgebungsvariablen',
      `POSTGRES_URL=x bun run scripts/migrate-steckbrief.ts ${SCHALTER}`],
    ['mit timeout davor',
      `timeout 300 bun run scripts/migrate-steckbrief.ts ${SCHALTER}`],
    ['in einer Prozesssubstitution',
      `echo $(bun run scripts/migrate-steckbrief.ts ${SCHALTER})`],
    ['psql gegen die Produktivdatenbank',
      `psql ${KERN} -c "select 1"`],
    ['npm publish',
      `npm publish`],
    ['docker push',
      `docker push registry/bild:neu`],
  ];

  for (const [name, befehl] of rot) {
    test(name, () => {
      expect(blockiert(befehl), befehl).toBe(true);
    });
  }
});

describe('Die Tilde greift weiterhin überall', () => {
  test('als Argument in Anführungszeichen', () => {
    const sql = 'de' + 'lete from x where y';
    expect(blockiert(`irgendein-werkzeug --sql "${sql}" --db ${KERN}`)).toBe(true);
  });

  test('auch mitten im Text', () => {
    const sql = 'tr' + 'uncate';
    expect(blockiert(`echo "${sql} tabelle in ${KERN}"`)).toBe(true);
  });
});

describe('Die harten Verbote sind unverändert', () => {
  test('rekursives Löschen bleibt gesperrt und ist nicht armbar', () => {
    const befehl = 'r' + 'm -rf /tmp/irgendwas';
    expect(pruefe(befehl).code).toBe(2);
    expect(pruefe(befehl, true).code).toBe(2);   // auch mit Freigabe
  });

  test('eine Tabelle zu verwerfen bleibt gesperrt', () => {
    const befehl = 'psql -c "DR' + 'OP TABLE kunden"';
    expect(pruefe(befehl, true).code).toBe(2);
  });
});

describe('Mit Freigabe läuft ein roter Befehl durch', () => {
  test('und die Freigabe wird dabei genau einmal verbraucht', () => {
    const befehl = `bun run scripts/migrate-steckbrief.ts ${SCHALTER}`;
    expect(pruefe(befehl, true).code).toBe(0);      // erste Ausfuehrung: erlaubt
    expect(pruefe(befehl).code).toBe(2);            // zweite: Flagge ist weg
  });
});

describe('Bekannte Grenze: die Markdown-Tabelle', () => {
  /**
   * Ein Muster, das in einer Tabellenzeile direkt hinter einem `|` steht, ist
   * fuer den Hook von einer Shell-Pipe nicht zu unterscheiden — `foo | psql …`
   * MUSS rot bleiben, also bleibt `|` ein Trennzeichen. Das ist der Preis der
   * Verankerung, und er ist klein: Ein Report wird mit dem Schreibwerkzeug
   * geschrieben, nicht ueber die Befehlszeile.
   *
   * Der Test haelt die Grenze fest, damit sie nicht als Ueberraschung
   * wiederkommt.
   */
  test('Tabellenzeile mit dem Muster hinter einem Strich bleibt rot', () => {
    const zeile = `cat > r.md <<'EOF'\n| Roter Befehl | migrate … ${SCHALTER} |\nEOF`;
    expect(blockiert(zeile)).toBe(true);
  });

  test('dieselbe Zeile mit Backticks um das Muster ist harmlos', () => {
    const zeile = `cat > r.md <<'EOF'\n| Roter Befehl | \`migrate … ${SCHALTER}\` |\nEOF`;
    expect(blockiert(zeile)).toBe(false);
  });
});
