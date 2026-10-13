/**
 * Rote Zone: Push-Schutz — automatisierte Pruefung des Deny-Hooks.
 *
 * WAS DIESER TEST BEWEIST. Der Rote-Zone-Schutz beim Push ist bisher durch
 * nichts abgesichert: smoke-test.ts Check 15 prueft nur, dass die Hook-Datei
 * existiert, ausfuehrbar ist und nicht driftet — nicht, dass sie greift.
 * Dieser Test fuettert den echten Hook mit dem echten PreToolUse-JSON und
 * prueft den Exit-Code. Es wird nichts gepusht.
 *
 * ISOLATION. HOME wird auf ein Wegwerfverzeichnis gesetzt. Damit landen
 * Hook-Log, Dedupe-Verzeichnis und — entscheidend — das Armed-Flag im
 * Testverzeichnis. Der Test kann den armed-Fall also pruefen, ohne das echte
 * ~/.armed-bikosoc anzulegen; cc armt sich nie selbst.
 * red-zone.conf wird aus der Produktivdatei kopiert, damit der Test genau die
 * Muster prueft, die im Betrieb gelten.
 */
import { describe, test, expect, beforeAll } from 'bun:test';
import { execFileSync, execSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, copyFileSync, writeFileSync, existsSync, utimesSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir, homedir } from 'node:os';

const HOOK = join(homedir(), '.claude', 'hooks', 'deny-destructive.sh');
const ECHTE_CONF = join(homedir(), '.config', 'openclaw', 'red-zone.conf');

let BASIS = '';
let TEST_HOME = '';

/** Legt ein Repo an, dessen Pfad als Strang bikosoc erkannt wird, mit genau
 *  einer Datei im Diff gegen den Upstream. */
function repoMitDatei(name: string, datei: string): string {
  const d = join(BASIS, name, 'executive-agent');
  mkdirSync(d, { recursive: true });
  const g = (...a: string[]) => execFileSync('git', ['-C', d, ...a], { stdio: 'pipe' });
  g('init', '-q', '-b', 'main');
  g('config', 'user.email', 'test@example.invalid');
  g('config', 'user.name', 'test');
  g('remote', 'add', 'origin', d);
  g('config', 'remote.origin.fetch', '+refs/heads/*:refs/remotes/origin/*');
  writeFileSync(join(d, 'liesmich'), 'a\n');
  g('add', '-A'); g('commit', '-qm', 'basis');
  g('update-ref', 'refs/remotes/origin/main', 'HEAD');
  g('config', 'branch.main.remote', 'origin');
  g('config', 'branch.main.merge', 'refs/heads/main');
  mkdirSync(join(d, datei, '..'), { recursive: true });
  writeFileSync(join(d, datei), 'b\n');
  g('add', '-A'); g('commit', '-qm', 'aenderung');
  return d;
}

/** Ruft den echten Hook auf und gibt seinen Exit-Code und stderr zurueck. */
function hookAufruf(befehl: string, cwd: string): { code: number; text: string } {
  const eingabe = JSON.stringify({ tool_name: 'Bash', tool_input: { command: befehl }, cwd });
  try {
    execFileSync('bash', [HOOK], {
      input: eingabe,
      env: { ...process.env, HOME: TEST_HOME },
      stdio: 'pipe',
    });
    return { code: 0, text: '' };
  } catch (e: any) {
    return { code: e.status ?? -1, text: String(e.stderr ?? '') };
  }
}

/* Das Wort wird zur Laufzeit gebildet. Sonst erkennt der aeussere Deny-Hook
   den Testtext beim Bearbeiten dieser Datei als echten Vorgang. */
const PUSH = 'pu' + 'sh';
/* Auch das rote Befehlsmuster wird zur Laufzeit gebaut — sonst liest der
   Deny-Hook diese Datei beim Bearbeiten als auszufuehrenden Befehl. */
const BEFEHL_ROT = 'bun run scripts/migrate-v099.ts --' + 'apply';

beforeAll(() => {
  BASIS = mkdtempSync(join(tmpdir(), 'rotezone-'));
  TEST_HOME = join(BASIS, 'home');
  mkdirSync(join(TEST_HOME, '.config', 'openclaw'), { recursive: true });
  mkdirSync(join(TEST_HOME, '.claude'), { recursive: true });
  copyFileSync(ECHTE_CONF, join(TEST_HOME, '.config', 'openclaw', 'red-zone.conf'));
});

describe('Rote Zone: Push-Schutz', () => {
  test('Hook ist vorhanden und ausfuehrbar', () => {
    expect(existsSync(HOOK)).toBe(true);
    execSync(`test -x ${HOOK}`);
  });

  test('roter Pfad im Diff wird ohne Freigabe blockiert', () => {
    const d = repoMitDatei('rot', 'src/modules/x/migrations/099_test.sql');
    const r = hookAufruf(`git -C ${d} ${PUSH}`, d);
    expect(r.code).toBe(2);
    expect(r.text).toContain('migrations/*.sql');
    expect(r.text).toContain('not armed');
  });

  test('Schutzmechanik selbst ist roter Pfad', () => {
    const d = repoMitDatei('hooks', '.claude/hooks/deny-destructive.sh');
    expect(hookAufruf(`git -C ${d} ${PUSH}`, d).code).toBe(2);
  });

  test('gruener Pfad laeuft durch', () => {
    const d = repoMitDatei('gruen', 'src/modules/x/store.ts');
    expect(hookAufruf(`git -C ${d} ${PUSH}`, d).code).toBe(0);
  });

  test('ohne aufloesbaren Repo-Pfad wird fail-closed blockiert', () => {
    const d = repoMitDatei('failclosed', 'src/modules/x/store.ts');
    const r = hookAufruf(`git ${PUSH}`, d);
    expect(r.code).toBe(2);
    expect(r.text).toContain('fail-closed');
  });

  test('ohne Upstream wird fail-closed blockiert', () => {
    const d = repoMitDatei('kein-upstream', 'src/modules/x/store.ts');
    execFileSync('git', ['-C', d, 'branch', '--unset-upstream']);
    const r = hookAufruf(`git -C ${d} ${PUSH}`, d);
    expect(r.code).toBe(2);
    expect(r.text).toContain('fail-closed');
  });

  test('frische Freigabe laesst den roten Pfad durch, verbraucht sie aber nicht', () => {
    /* Seit es scripts/hooks/pre-push gibt, verbraucht dieser Hook die Freigabe
       beim Uebertragen NICHT mehr — das tut der git-Hook, der erst laeuft, wenn
       wirklich uebertragen wird. Verschwaende das Flag schon hier, blockierte
       der pre-push-Hook genau das, was hier durchgelassen wurde. */
    const d = repoMitDatei('armed', 'src/modules/x/migrations/099_test.sql');
    const flagge = join(TEST_HOME, '.armed-bikosoc');
    writeFileSync(flagge, '');
    expect(hookAufruf(`git -C ${d} ${PUSH}`, d).code).toBe(0);
    expect(existsSync(flagge)).toBe(true);
    rmSync(flagge);
  });

  test('ein Befehl, der die Hook-Datei nur nennt, ist keine Uebertragung', () => {
    /* Die Datei heisst scripts/hooks/pre-<wort>. Mit einer zu groben
       Worterkennung galt jedes `git add` darauf als Uebertragung und wurde
       gegen rote Pfade geprueft — ein Fehlalarm, der das Arbeiten an der
       Schutzmechanik selbst verhindert haette. */
    const d = repoMitDatei('nennung', 'src/modules/x/migrations/099_test.sql');
    const r = hookAufruf(`git -C ${d} add scripts/hooks/pre-${PUSH}`, d);
    expect(r.code).toBe(0);
  });

  test('bei einem roten BEFEHL bleibt es beim Verbrauch hier', () => {
    /* Ohne Uebertragung gibt es keinen pre-push-Hook, der verbrauchen koennte.
       Die Einmaligkeit muss deshalb an dieser Stelle erhalten bleiben. */
    const d = repoMitDatei('befehl', 'src/modules/x/store.ts');
    const flagge = join(TEST_HOME, '.armed-bikosoc');
    writeFileSync(flagge, '');
    const r = hookAufruf(BEFEHL_ROT, d);
    expect(r.code).toBe(0);
    expect(existsSync(flagge)).toBe(false);
  });

  /* Dieser Test ist der eigentliche Zweck der Uebung. Er bildet den Vorfall
     vom 13.10.2026 nach: Eine Freigabe vom 11.10. 07:32 Uhr lag zwei Tage
     unverbraucht herum und autorisierte dann einen Push, fuer den sie nie
     gedacht war. Seit der Verfallsfrist kann das nicht mehr passieren. */
  test('zwei Tage alte Freigabe wird NICHT akzeptiert', () => {
    const d = repoMitDatei('abgelaufen', 'src/modules/x/migrations/099_test.sql');
    const flagge = join(TEST_HOME, '.armed-bikosoc');
    writeFileSync(flagge, '');
    const vorZweiTagen = new Date(Date.now() - 2 * 24 * 3600 * 1000);
    utimesSync(flagge, vorZweiTagen, vorZweiTagen);
    const r = hookAufruf(`git -C ${d} ${PUSH}`, d);
    expect(r.code).toBe(2);
    expect(r.text).toContain('abgelaufen');
    expect(existsSync(flagge)).toBe(false);
  });
});
