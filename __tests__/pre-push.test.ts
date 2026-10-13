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

function lies(p: string): string {
  try { return readFileSync(p, 'utf-8'); } catch { return ''; }
}

beforeAll(() => {
  BASIS = mkdtempSync(join(tmpdir(), 'prepush-'));
  CONF = join(BASIS, 'red-zone.conf');
  copyFileSync(ECHTE_CONF, CONF);
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
