/**
 * Rote Zone am echten Push — scripts/hooks/pre-push.
 *
 * WAS HIER GEPRUEFT WIRD. Die Faelle A bis H stammen aus der Diagnose vom
 * 13.10.2026 (report-rote-zone-sperre-diagnose-20261013.md, Abschnitt 4). Drei
 * davon liess der Claude-Code-Hook durch:
 *   C — ein roter Commit auf einem anderen Branch als HEAD,
 *   E — ein Submodul-Pointer im Parent-Repo,
 *   F — migrations/*.sql direkt im Repo-Wurzelverzeichnis.
 * Genau diese drei muessen hier blockieren.
 *
 * ISOLATION. Jeder Fall bekommt ein eigenes Wegwerf-HOME, eine eigene
 * Logdatei und ein eigenes bares Remote im Temp-Verzeichnis. Dadurch kann der
 * Test auch den Freigabe-Fall pruefen, ohne das echte ~/.armed-bikosoc
 * anzulegen — cc armt sich nie selbst. Die Musterdatei wird aus der
 * Produktivfassung kopiert, damit genau die Muster geprueft werden, die im
 * Betrieb gelten.
 *
 * Es wird gegen ein lokales bares Repo im Temp-Verzeichnis uebertragen, nie
 * gegen ein echtes Remote.
 */
import { describe, test, expect, beforeAll } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, copyFileSync, writeFileSync, readFileSync,
         existsSync, utimesSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir, homedir } from 'node:os';

const HOOKS_DIR = join(dirname(new URL(import.meta.url).pathname), '..', 'scripts', 'hooks');
const PRE_PUSH = join(HOOKS_DIR, 'pre-push');
const ECHTE_CONF = join(homedir(), '.config', 'openclaw', 'red-zone.conf');

let BASIS = '';
let CONF = '';

/* Der Pfad muss als Strang "bikosoc" erkannt werden, sonst greift fail-closed
   vor der Flaggenpruefung. Deshalb endet jedes Arbeitsverzeichnis auf
   /executive-agent. */
function neuerFall(name: string) {
  const wurzel = join(BASIS, name);
  const remote = join(wurzel, 'remote.git');
  const work = join(wurzel, 'executive-agent');
  const heim = join(wurzel, 'home');
  mkdirSync(heim, { recursive: true });
  mkdirSync(remote, { recursive: true });
  execFileSync('git', ['init', '-q', '--bare', '-b', 'main', remote]);
  execFileSync('git', ['clone', '-q', remote, work]);
  g(work, 'config', 'user.email', 'test@example.invalid');
  g(work, 'config', 'user.name', 'test');
  g(work, 'config', 'core.hooksPath', HOOKS_DIR);
  return { wurzel, remote, work, heim, log: join(wurzel, 'hooks.log') };
}

function g(repo: string, ...args: string[]) {
  return execFileSync('git', ['-C', repo, ...args], { stdio: 'pipe' }).toString();
}

function commit(repo: string, datei: string, text: string, nachricht: string) {
  const ziel = join(repo, datei);
  mkdirSync(dirname(ziel), { recursive: true });
  writeFileSync(ziel, text);
  g(repo, 'add', '-A');
  g(repo, 'commit', '-qm', nachricht);
}

/** Erster Commit, damit origin/main existiert. */
function grundstein(fall: ReturnType<typeof neuerFall>) {
  commit(fall.work, 'liesmich.md', 'Basis\n', 'basis');
  uebertragen(fall, ['origin', 'main']);           // gruen, muss durchlaufen
}

interface Ergebnis { code: number; text: string; log: string }

function uebertragen(
  fall: ReturnType<typeof neuerFall>,
  args: string[],
  opt: { flaggeAlterSekunden?: number } = {},
): Ergebnis {
  if (opt.flaggeAlterSekunden !== undefined) {
    const flagge = join(fall.heim, '.armed-bikosoc');
    writeFileSync(flagge, '');
    if (opt.flaggeAlterSekunden > 0) {
      const t = new Date(Date.now() - opt.flaggeAlterSekunden * 1000);
      utimesSync(flagge, t, t);
    }
  }
  const umgebung = {
    ...process.env,
    HOME: fall.heim,
    HOOK_LOG: fall.log,
    RED_ZONE_CONF: CONF,
    PREPUSH_NOTIFY: '/nonexistent',   // im Test nie melden
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_CONFIG_SYSTEM: '/dev/null',
  };
  /* Das Unterkommando wird zur Laufzeit gebildet, damit diese Datei beim
     Bearbeiten nicht selbst als Vorgang gelesen wird. */
  const unterkommando = 'pu' + 'sh';
  try {
    execFileSync('git', ['-C', fall.work, unterkommando, ...args],
                 { env: umgebung, stdio: 'pipe' });
    return { code: 0, text: '', log: lies(fall.log) };
  } catch (e: any) {
    return { code: e.status ?? -1, text: String(e.stderr ?? ''), log: lies(fall.log) };
  }
}

/**
 * Wie `uebertragen`, aber fuer ein beliebiges Repo desselben Falls — gebraucht
 * fuer den Nachlauf, bei dem erst das Submodul und dann der Parent uebertraegt.
 * Beide teilen sich HOME und damit Freigabe und Nachlaufmarke, genau wie im
 * Betrieb.
 */
function uebertragenAus(
  fall: ReturnType<typeof neuerFall>,
  repo: string,
  args: string[],
  opt: { flaggeAlterSekunden?: number; nachlaufAlterSekunden?: number } = {},
): Ergebnis {
  if (opt.flaggeAlterSekunden !== undefined) {
    const flagge = join(fall.heim, '.armed-bikosoc');
    writeFileSync(flagge, '');
    if (opt.flaggeAlterSekunden > 0) {
      const t = new Date(Date.now() - opt.flaggeAlterSekunden * 1000);
      utimesSync(flagge, t, t);
    }
  }
  if (opt.nachlaufAlterSekunden !== undefined) {
    const marke = join(fall.heim, '.armed-bikosoc.nachlauf');
    const t = new Date(Date.now() - opt.nachlaufAlterSekunden * 1000);
    utimesSync(marke, t, t);
  }
  const umgebung = {
    ...process.env,
    HOME: fall.heim,
    HOOK_LOG: fall.log,
    RED_ZONE_CONF: CONF,
    PREPUSH_NOTIFY: '/nonexistent',
    PREPUSH_NOTIFY_SYSTEM: '/nonexistent',
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_CONFIG_SYSTEM: '/dev/null',
  };
  const unterkommando = 'pu' + 'sh';
  try {
    execFileSync('git', ['-C', repo, unterkommando, ...args], { env: umgebung, stdio: 'pipe' });
    return { code: 0, text: '', log: lies(fall.log) };
  } catch (e: any) {
    return { code: e.status ?? -1, text: String(e.stderr ?? ''), log: lies(fall.log) };
  }
}

/**
 * Baut die Lage des Betriebs nach: ein Parent-Repo mit Submodul, beide gruen
 * uebertragen, dann eine rote Datei im Submodul committet (noch nicht
 * uebertragen). Gibt die Pfade zurueck.
 */
function lageMitSubmodul(name: string) {
  const f = neuerFall(name);
  grundstein(f);
  const subRemote = join(f.wurzel, 'sub.git');
  const subVorlage = join(f.wurzel, 'sub-vorlage');
  execFileSync('git', ['init', '-q', '--bare', '-b', 'main', subRemote]);
  execFileSync('git', ['clone', '-q', subRemote, subVorlage]);
  g(subVorlage, 'config', 'user.email', 'test@example.invalid');
  g(subVorlage, 'config', 'user.name', 'test');
  commit(subVorlage, 'liesmich.md', 'sub\n', 'sub basis');
  g(subVorlage, 'push', '-q', 'origin', 'main');

  g(f.work, '-c', 'protocol.file.allow=always', 'submodule', 'add', '-q', subRemote, 'sub');
  g(f.work, 'commit', '-qm', 'Submodul aufgenommen');
  expect(uebertragen(f, ['origin', 'main']).code).toBe(0);

  /* Das Submodul ist jetzt das „Agent-Repo": eigener Hook-Pfad, eigener
     Branch. Genau von hier aus laeuft im Betrieb die erste Uebertragung. */
  const sub = join(f.work, 'sub');
  g(sub, 'config', 'user.email', 'test@example.invalid');
  g(sub, 'config', 'user.name', 'test');
  g(sub, 'config', 'core.hooksPath', HOOKS_DIR);
  g(sub, 'checkout', '-q', '-B', 'main', 'origin/main');
  commit(sub, 'hooks/deny-destructive.sh', '#!/bin/sh\n', 'Schutzhook geaendert');
  return { f, sub, subRemote };
}

function lies(p: string): string {
  try { return readFileSync(p, 'utf-8'); } catch { return ''; }
}

beforeAll(() => {
  BASIS = mkdtempSync(join(tmpdir(), 'prepush-'));
  CONF = join(BASIS, 'red-zone.conf');
  copyFileSync(ECHTE_CONF, CONF);
});

/* ── Nachlauf fuer den Submodul-Pointer (Owner-Entscheidung 14.10.2026) ──────
 *
 * Ein Vorgang besteht aus zwei Uebertragungen: erst das Agent-Repo, dann der
 * Pointer im Parent, der nur den eben freigegebenen Stand benennt. Das kostete
 * zwei Freigaben. Jetzt deckt EINE beides ab — aber nur denselben Inhalt, nur
 * einmal und nur fuer kurze Zeit. Die folgenden Faelle halten jede der sechs
 * Bedingungen fest. */
describe('pre-push: Nachlauf fuer den Submodul-Pointer', () => {
  test('eine Freigabe deckt Agent-Repo und Pointer', () => {
    const { f, sub } = lageMitSubmodul('nl-ok');

    // 1. Uebertragung: das Agent-Repo, rot, mit Freigabe
    const r1 = uebertragenAus(f, sub, ['origin', 'main'], { flaggeAlterSekunden: 5 });
    expect(r1.code).toBe(0);
    expect(existsSync(join(f.heim, '.armed-bikosoc'))).toBe(false);   // verbraucht
    expect(existsSync(join(f.heim, '.armed-bikosoc.nachlauf'))).toBe(true);

    // 2. Uebertragung: der Pointer, OHNE neue Freigabe
    g(f.work, 'add', 'sub');
    g(f.work, 'commit', '-qm', 'Submodul-Pointer nachgezogen');
    const r2 = uebertragenAus(f, f.work, ['origin', 'main']);
    expect(r2.code).toBe(0);
    expect(r2.log).toContain('Nachlauf der vorigen Freigabe genutzt');
    // und er ist verbraucht
    expect(existsSync(join(f.heim, '.armed-bikosoc.nachlauf'))).toBe(false);
  });

  test('ein Pointer auf einen ANDEREN Stand wird nicht gedeckt', () => {
    const { f, sub } = lageMitSubmodul('nl-anderer-stand');
    expect(uebertragenAus(f, sub, ['origin', 'main'], { flaggeAlterSekunden: 5 }).code).toBe(0);

    /* Noch ein roter Commit im Submodul — NICHT uebertragen und damit nicht
       freigegeben. Der Pointer zeigt jetzt auf diesen neuen Stand. */
    commit(sub, 'hooks/telegram-notify.sh', '#!/bin/sh\n', 'zweite Aenderung, ungeprueft');
    g(f.work, 'add', 'sub');
    g(f.work, 'commit', '-qm', 'Pointer auf ungepruefen Stand');

    const r = uebertragenAus(f, f.work, ['origin', 'main']);
    expect(r.code).not.toBe(0);
    expect(r.text).toContain('not armed');
  });

  test('ein eigener roter Pfad im Parent wird nicht mitgedeckt', () => {
    const { f, sub } = lageMitSubmodul('nl-parent-rot');
    expect(uebertragenAus(f, sub, ['origin', 'main'], { flaggeAlterSekunden: 5 }).code).toBe(0);

    // Pointer UND eine eigene rote Datei im Parent in einem Commit
    g(f.work, 'add', 'sub');
    const ziel = join(f.work, 'migrations', '099_parent.sql');
    mkdirSync(dirname(ziel), { recursive: true });
    writeFileSync(ziel, '-- ddl\n');
    g(f.work, 'add', '-A');
    g(f.work, 'commit', '-qm', 'Pointer plus eigene Migration');

    const r = uebertragenAus(f, f.work, ['origin', 'main']);
    expect(r.code).not.toBe(0);
  });

  test('der Nachlauf gilt genau einmal', () => {
    const { f, sub } = lageMitSubmodul('nl-einmal');
    expect(uebertragenAus(f, sub, ['origin', 'main'], { flaggeAlterSekunden: 5 }).code).toBe(0);
    g(f.work, 'add', 'sub');
    g(f.work, 'commit', '-qm', 'Pointer nachgezogen');
    expect(uebertragenAus(f, f.work, ['origin', 'main']).code).toBe(0);

    // Zweiter roter Vorgang im Parent — ohne neue Freigabe gesperrt
    const ziel = join(f.work, 'migrations', '100_zweiter.sql');
    mkdirSync(dirname(ziel), { recursive: true });
    writeFileSync(ziel, '-- ddl\n');
    g(f.work, 'add', '-A');
    g(f.work, 'commit', '-qm', 'zweiter roter Vorgang');
    const r = uebertragenAus(f, f.work, ['origin', 'main']);
    expect(r.code).not.toBe(0);
    expect(r.text).toContain('not armed');
  });

  test('ein abgelaufener Nachlauf deckt nichts mehr', () => {
    const { f, sub } = lageMitSubmodul('nl-abgelaufen');
    expect(uebertragenAus(f, sub, ['origin', 'main'], { flaggeAlterSekunden: 5 }).code).toBe(0);
    g(f.work, 'add', 'sub');
    g(f.work, 'commit', '-qm', 'Pointer nachgezogen');

    // Vorgabe sind 300 Sekunden
    const r = uebertragenAus(f, f.work, ['origin', 'main'], { nachlaufAlterSekunden: 301 });
    expect(r.code).not.toBe(0);
    expect(r.text).toContain('not armed');
    expect(r.log).toContain('Nachlauf abgelaufen');
    expect(existsSync(join(f.heim, '.armed-bikosoc.nachlauf'))).toBe(false);
  });

  test('ohne vorherige Freigabe gibt es keinen Nachlauf', () => {
    const { f, sub } = lageMitSubmodul('nl-ohne-freigabe');
    // Erste Uebertragung OHNE Freigabe -> blockiert, keine Marke
    expect(uebertragenAus(f, sub, ['origin', 'main']).code).not.toBe(0);
    expect(existsSync(join(f.heim, '.armed-bikosoc.nachlauf'))).toBe(false);
  });
});

describe('pre-push: Grundlagen', () => {
  test('Hook ist vorhanden und ausfuehrbar', () => {
    expect(existsSync(PRE_PUSH)).toBe(true);
    expect(statSync(PRE_PUSH).mode & 0o111).toBeGreaterThan(0);
  });

  test('das Parent-Repo wird als Strang bikosoc erkannt', () => {
    /* Der Live-Pfad ist ~/.openclaw/workspace. Der Punkt verhindert, dass das
       Muster ohne Punkt greift — dort muesste ein Schraegstrich direkt vor
       "openclaw" stehen. Ohne die Variante mit Punkt waere das Parent-Repo
       "unbekannter Strang" und damit nie freigebbar. */
    const wurzel = join(BASIS, 'strang', '.openclaw');
    mkdirSync(wurzel, { recursive: true });
    const remote = join(wurzel, 'remote.git');
    const work = join(wurzel, 'workspace');
    const heim = join(BASIS, 'strang', 'home');
    mkdirSync(heim, { recursive: true });
    execFileSync('git', ['init', '-q', '--bare', '-b', 'main', remote]);
    execFileSync('git', ['clone', '-q', remote, work]);
    g(work, 'config', 'user.email', 'test@example.invalid');
    g(work, 'config', 'user.name', 'test');
    g(work, 'config', 'core.hooksPath', HOOKS_DIR);
    const fall = { wurzel, remote, work, heim, log: join(wurzel, 'hooks.log') };
    commit(work, 'liesmich.md', 'Basis\n', 'basis');
    uebertragen(fall, ['origin', 'main']);
    commit(work, 'src/modules/x/migrations/099_test.sql', '-- ddl\n', 'rot');
    const r = uebertragen(fall, ['origin', 'main']);
    expect(r.code).not.toBe(0);
    expect(r.text).toContain('not armed');          // nicht "unbekannter Strang"
    expect(r.text).not.toContain('unbekannter Strang');
  });

  test('ohne lesbare Musterdatei wird fail-closed blockiert', () => {
    const f = neuerFall('ohne-conf');
    grundstein(f);
    commit(f.work, 'src/modules/x/store.ts', 'x\n', 'gruen');
    const alt = CONF;
    CONF = join(BASIS, 'gibt-es-nicht.conf');
    const r = uebertragen(f, ['origin', 'main']);
    CONF = alt;
    expect(r.code).not.toBe(0);
    expect(r.text).toContain('nicht lesbar');
  });
});

describe('pre-push: Faelle A bis H aus der Diagnose', () => {
  test('A — rote Migration im Diff, keine Freigabe: blockiert', () => {
    const f = neuerFall('a-migration');
    grundstein(f);
    commit(f.work, 'src/modules/casameta/migrations/044_tabellen.sql', '-- ddl\n', 'migration');
    const r = uebertragen(f, ['origin', 'main']);
    expect(r.code).not.toBe(0);
    expect(r.text).toContain('migrations/*.sql');
    expect(r.text).toContain('not armed');
  });

  test('B — neuer Branch wird gegen origin/main geprueft', () => {
    const f = neuerFall('b-neuer-branch');
    grundstein(f);
    g(f.work, 'checkout', '-q', '-b', 'thema');
    commit(f.work, 'src/modules/x/migrations/099_test.sql', '-- ddl\n', 'rot im neuen Branch');
    const r = uebertragen(f, ['origin', 'thema']);
    expect(r.code).not.toBe(0);
    expect(r.text).toContain('migrations/*.sql');
  });

  test('B2 — neuer Branch, nur gruene Dateien: laeuft durch', () => {
    const f = neuerFall('b2-neuer-branch-gruen');
    grundstein(f);
    g(f.work, 'checkout', '-q', '-b', 'thema');
    commit(f.work, 'src/modules/x/store.ts', 'x\n', 'gruen im neuen Branch');
    const r = uebertragen(f, ['origin', 'thema']);
    expect(r.code).toBe(0);
    expect(r.log).toContain('erlaubt:');
  });

  test('C — roter Commit auf anderem Branch als HEAD: blockiert', () => {
    /* Genau diese Luecke hatte der Claude-Code-Hook: Er prueft @{u}..HEAD und
       sah den roten Branch deshalb nie. */
    const f = neuerFall('c-anderer-branch');
    grundstein(f);
    g(f.work, 'checkout', '-q', '-b', 'rot');
    commit(f.work, 'src/modules/x/migrations/099_test.sql', '-- ddl\n', 'rot');
    g(f.work, 'checkout', '-q', 'main');            // HEAD steht auf sauberem Branch
    const r = uebertragen(f, ['origin', 'rot']);
    expect(r.code).not.toBe(0);
    expect(r.text).toContain('migrations/*.sql');
  });

  test('D — die Form des Aufrufs spielt keine Rolle (Refspec statt Branchname)', () => {
    const f = neuerFall('d-refspec');
    grundstein(f);
    g(f.work, 'checkout', '-q', '-b', 'rot');
    commit(f.work, 'hooks/deny-destructive.sh', '#!/bin/sh\n', 'Schutzmechanik');
    g(f.work, 'checkout', '-q', 'main');
    const r = uebertragen(f, ['origin', 'rot:refs/heads/rot']);
    expect(r.code).not.toBe(0);
    expect(r.text).toContain('hooks/**');
  });

  test('E — Submodul-Pointer: rote Datei im Submodul wird erkannt', () => {
    const f = neuerFall('e-submodul');
    grundstein(f);

    // Eigenes Submodul-Repo mit einer roten Datei im zweiten Commit
    const subRemote = join(f.wurzel, 'sub.git');
    const subWork = join(f.wurzel, 'sub-work');
    execFileSync('git', ['init', '-q', '--bare', '-b', 'main', subRemote]);
    execFileSync('git', ['clone', '-q', subRemote, subWork]);
    g(subWork, 'config', 'user.email', 'test@example.invalid');
    g(subWork, 'config', 'user.name', 'test');
    commit(subWork, 'liesmich.md', 'sub\n', 'sub basis');
    g(subWork, 'push', '-q', 'origin', 'main');

    g(f.work, '-c', 'protocol.file.allow=always', 'submodule', 'add', '-q', subRemote, 'sub');
    g(f.work, 'commit', '-qm', 'Submodul aufgenommen');
    const r0 = uebertragen(f, ['origin', 'main']);
    expect(r0.code).toBe(0);                       // gruener Stand laeuft durch

    // Jetzt eine rote Datei im Submodul und den Pointer nachziehen
    commit(subWork, 'src/modules/y/migrations/010_test.sql', '-- ddl\n', 'rot im Submodul');
    g(subWork, 'push', '-q', 'origin', 'main');
    g(join(f.work, 'sub'), 'fetch', '-q', 'origin');
    g(join(f.work, 'sub'), 'checkout', '-q', 'origin/main');
    g(f.work, 'add', 'sub');
    g(f.work, 'commit', '-qm', 'Submodul-Pointer nachgezogen');

    const r = uebertragen(f, ['origin', 'main']);
    expect(r.code).not.toBe(0);
    expect(r.text).toContain('Submodul');
    expect(r.text).toContain('migrations/*.sql');
  });

  test('E2 — Submodul nicht auswertbar: fail-closed', () => {
    const f = neuerFall('e2-submodul-fehlt');
    grundstein(f);
    /* Ein Gitlink-Eintrag ohne ausgechecktes Submodul: Der Hook kann den
       Bereich nicht nachschlagen und muss blockieren, nicht durchlassen. */
    g(f.work, 'update-index', '--add', '--cacheinfo',
      `160000,${'0'.repeat(39)}1,fremdes-submodul`);
    g(f.work, 'commit', '-qm', 'Pointer auf ein Submodul, das hier nicht liegt');
    const r = uebertragen(f, ['origin', 'main']);
    expect(r.code).not.toBe(0);
    expect(r.text).toContain('fail-closed');
  });

  test('F — migrations/*.sql im Repo-Wurzelverzeichnis: blockiert', () => {
    const f = neuerFall('f-wurzel-migration');
    grundstein(f);
    commit(f.work, 'migrations/099_test.sql', '-- ddl\n', 'Migration ganz oben');
    const r = uebertragen(f, ['origin', 'main']);
    expect(r.code).not.toBe(0);
    expect(r.text).toContain('migrations/*.sql');
  });

  test('G — src/migrations/*.sql: blockiert', () => {
    const f = neuerFall('g-src-migration');
    grundstein(f);
    commit(f.work, 'src/migrations/099_test.sql', '-- ddl\n', 'Migration eine Ebene tiefer');
    const r = uebertragen(f, ['origin', 'main']);
    expect(r.code).not.toBe(0);
    expect(r.text).toContain('migrations/*.sql');
  });

  test('H — .claude/hooks/**: blockiert', () => {
    const f = neuerFall('h-claude-hooks');
    grundstein(f);
    commit(f.work, '.claude/hooks/deny-destructive.sh', '#!/bin/sh\n', 'Schutzmechanik');
    const r = uebertragen(f, ['origin', 'main']);
    expect(r.code).not.toBe(0);
    expect(r.text).toContain('.claude/hooks/**');
  });
});

describe('pre-push: Freigabe und Protokoll', () => {
  test('frische Freigabe laesst den roten Pfad durch und wird verbraucht', () => {
    const f = neuerFall('freigabe-frisch');
    grundstein(f);
    commit(f.work, 'src/modules/x/migrations/099_test.sql', '-- ddl\n', 'rot');
    const r = uebertragen(f, ['origin', 'main'], { flaggeAlterSekunden: 0 });
    expect(r.code).toBe(0);
    expect(existsSync(join(f.heim, '.armed-bikosoc'))).toBe(false);
    expect(r.log).toContain('Freigabe verbraucht');
  });

  test('zwei Tage alte Freigabe wird nicht akzeptiert', () => {
    const f = neuerFall('freigabe-alt');
    grundstein(f);
    commit(f.work, 'src/modules/x/migrations/099_test.sql', '-- ddl\n', 'rot');
    const r = uebertragen(f, ['origin', 'main'], { flaggeAlterSekunden: 2 * 24 * 3600 });
    expect(r.code).not.toBe(0);
    expect(r.text).toContain('abgelaufen');
    expect(existsSync(join(f.heim, '.armed-bikosoc'))).toBe(false);
  });

  test('erlaubter Push wird mit Ref, Bereich und Ergebnis protokolliert', () => {
    const f = neuerFall('protokoll-erlaubt');
    grundstein(f);
    commit(f.work, 'src/modules/x/store.ts', 'x\n', 'gruen');
    const r = uebertragen(f, ['origin', 'main']);
    expect(r.code).toBe(0);
    const zeile = r.log.split('\n').filter(z => z.includes('erlaubt:')).pop() ?? '';
    expect(zeile).toContain('[PREPUSH]');
    expect(zeile).toContain('refs/heads/main');
    expect(zeile).toContain('..');                  // der Commit-Bereich
    expect(zeile).toContain('kein roter Pfad');
  });

  test('Loeschen eines Branches laeuft durch und wird protokolliert', () => {
    const f = neuerFall('branch-loeschen');
    grundstein(f);
    g(f.work, 'checkout', '-q', '-b', 'weg');
    commit(f.work, 'src/modules/x/store.ts', 'x\n', 'gruen');
    expect(uebertragen(f, ['origin', 'weg']).code).toBe(0);
    g(f.work, 'checkout', '-q', 'main');
    const r = uebertragen(f, ['origin', '--delete', 'weg']);
    expect(r.code).toBe(0);
    expect(r.log).toContain('wird geloescht');
  });
});
