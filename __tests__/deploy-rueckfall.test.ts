/**
 * Rückfall in deploy.sh: Arbeitsstand exakt auf den Rückfallpunkt.
 *
 * ANLASS (23.10.2026, report-banking-paket-abend-20261023): Der Rückfall
 * stellte nur die Dateien des Rückfallpunkts wieder her. Eine neu
 * hinzugekommene Testdatei blieb neben dem alten Code liegen, der Testlauf
 * des Rückfalls scheiterte, Telegram meldete falsch „ROLLBACK FAILED“.
 *
 * Die Tests fahren `rueckfall_arbeitsstand` aus scripts/deploy-rueckfall.sh
 * in einem Wegwerf-Repository. Der Rückfall-Testlauf ist dort ein kleiner
 * Läufer, der wie run-tests.sh jede Testdatei ausführt.
 */
import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, writeFileSync, readFileSync, rmSync, existsSync, mkdirSync, renameSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

const BAUSTEIN = resolve(import.meta.dir, '..', 'scripts', 'deploy-rueckfall.sh');
const DEPLOY = resolve(import.meta.dir, '..', 'scripts', 'deploy.sh');

let repo: string;
const sh = (cmd: string) => spawnSync('bash', ['-c', cmd], { cwd: repo, encoding: 'utf-8' });
const git = (...a: string[]) => {
  const r = spawnSync('git', a, { cwd: repo, encoding: 'utf-8' });
  if (r.status !== 0) throw new Error(`git ${a.join(' ')}: ${r.stderr}`);
  return r.stdout.trim();
};
const schreib = (pfad: string, inhalt: string) => {
  mkdirSync(join(repo, pfad, '..'), { recursive: true });
  writeFileSync(join(repo, pfad), inhalt);
};
const rueckfall = (ziel: string, stand: string) =>
  sh(`source '${BAUSTEIN}' && rueckfall_arbeitsstand '${repo}' ${ziel} ${stand}`);
/** Läufer wie run-tests.sh: jede tests/*.sh muss mit 0 enden. */
const testlauf = () => sh('for t in tests/*.sh; do bash "$t" || exit 1; done');

let altStand: string;
let neuStand: string;

beforeEach(() => {
  repo = mkdtempSync(join(tmpdir(), 'rueckfall-'));
  git('init', '-q');
  git('config', 'user.email', 'test@example.com');
  git('config', 'user.name', 'Test');
  schreib('.gitignore', 'laufzeit/\n');
  schreib('lib.sh', 'alt() { echo alt; }\n');
  schreib('tests/alt.sh', 'source lib.sh; alt >/dev/null\n');
  schreib('umbenannt-vorher.txt', 'gleich\n');
  git('add', '-A'); git('commit', '-qm', 'Rückfallpunkt');
  altStand = git('rev-parse', 'HEAD');
  // Deploy-Stand: neue Funktion, neue Testdatei dafür, Umbenennung, Datei mit Leerzeichen
  schreib('lib.sh', 'alt() { echo alt; }\nneu() { echo neu; }\n');
  schreib('tests/neu.sh', 'source lib.sh; neu >/dev/null\n');
  renameSync(join(repo, 'umbenannt-vorher.txt'), join(repo, 'umbenannt-nachher.txt'));
  schreib('docs/mit leerzeichen.md', 'neu\n');
  git('add', '-A'); git('commit', '-qm', 'Deploy-Stand');
  neuStand = git('rev-parse', 'HEAD');
  // Nicht versioniert bzw. ignoriert: darf der Rückfall nie anfassen
  schreib('notiz-des-owners.txt', 'privat\n');
  schreib('laufzeit/zustand.json', '{}\n');
});
afterEach(() => rmSync(repo, { recursive: true, force: true }));

describe('rueckfall_arbeitsstand', () => {
  test('Gegenprobe: das alte Verfahren (nur checkout) lässt die neue Testdatei liegen, der Testlauf scheitert', () => {
    git('checkout', altStand, '--', '.');
    expect(existsSync(join(repo, 'tests/neu.sh'))).toBe(true);
    expect(testlauf().status).not.toBe(0);
  });

  test('neue Testdatei verschwindet, alter Code zurück, Rückfall-Testlauf grün', () => {
    const r = rueckfall(altStand, neuStand);
    expect(r.status).toBe(0);
    expect(existsSync(join(repo, 'tests/neu.sh'))).toBe(false);
    expect(readFileSync(join(repo, 'lib.sh'), 'utf-8')).toBe('alt() { echo alt; }\n');
    expect(testlauf().status).toBe(0);
  });

  test('Arbeitsstand und Index entsprechen exakt dem Rückfallpunkt', () => {
    expect(rueckfall(altStand, neuStand).status).toBe(0);
    expect(sh(`git diff --quiet ${altStand} -- .`).status).toBe(0);
    expect(sh(`git diff --cached --quiet ${altStand} -- .`).status).toBe(0);
  });

  test('Umbenennung und Dateinamen mit Leerzeichen', () => {
    expect(rueckfall(altStand, neuStand).status).toBe(0);
    expect(existsSync(join(repo, 'umbenannt-vorher.txt'))).toBe(true);
    expect(existsSync(join(repo, 'umbenannt-nachher.txt'))).toBe(false);
    expect(existsSync(join(repo, 'docs/mit leerzeichen.md'))).toBe(false);
  });

  test('nicht versionierte und ignorierte Dateien bleiben unberührt', () => {
    expect(rueckfall(altStand, neuStand).status).toBe(0);
    expect(readFileSync(join(repo, 'notiz-des-owners.txt'), 'utf-8')).toBe('privat\n');
    expect(readFileSync(join(repo, 'laufzeit/zustand.json'), 'utf-8')).toBe('{}\n');
  });

  test('Rückfallpunkt gleich Deploy-Stand: nichts zu entfernen, Exit 0', () => {
    expect(rueckfall(neuStand, neuStand).status).toBe(0);
    expect(existsSync(join(repo, 'tests/neu.sh'))).toBe(true);
  });

  test('unbekannter Rückfallpunkt: Exit ungleich 0 (Alarm bleibt berechtigt)', () => {
    expect(rueckfall('0000000000000000000000000000000000000000', neuStand).status).not.toBe(0);
  });
});

describe('Review 23.10.2026: Unterordner und Ordner/Datei', () => {
  test('Dienst im Unterordner (wie trading-agent im workspace-Repo): neue Datei verschwindet, Exit 0', () => {
    schreib('dienst/alt.ts', 'alt\n');
    git('add', '-A'); git('commit', '-qm', 'Rückfallpunkt Unterordner');
    const ziel = git('rev-parse', 'HEAD');
    schreib('dienst/neu.test.ts', 'neu\n');
    git('add', '-A'); git('commit', '-qm', 'Deploy Unterordner');
    const stand = git('rev-parse', 'HEAD');
    const r = sh(`source '${BAUSTEIN}' && rueckfall_arbeitsstand '${join(repo, 'dienst')}' ${ziel} ${stand}`);
    expect(r.status).toBe(0);
    expect(existsSync(join(repo, 'dienst/neu.test.ts'))).toBe(false);
    expect(existsSync(join(repo, 'dienst/alt.ts'))).toBe(true);
  });

  test('aus Ordner wurde Datei: Rückfall stellt den Ordner her, Exit 0', () => {
    schreib('foo/bar', 'bar\n');
    git('add', '-A'); git('commit', '-qm', 'Ordner');
    const ziel = git('rev-parse', 'HEAD');
    git('rm', '-q', '-r', 'foo'); schreib('foo', 'jetzt Datei\n');
    git('add', '-A'); git('commit', '-qm', 'Datei');
    const stand = git('rev-parse', 'HEAD');
    expect(rueckfall(ziel, stand).status).toBe(0);
    expect(readFileSync(join(repo, 'foo/bar'), 'utf-8')).toBe('bar\n');
  });

  test('unbekannter Deploy-Stand: Exit ungleich 0', () => {
    expect(rueckfall(altStand, '1111111111111111111111111111111111111111').status).not.toBe(0);
  });
});

describe('deploy.sh bindet den Baustein ein', () => {
  const text = readFileSync(DEPLOY, 'utf-8');
  test('Rückfall ruft rueckfall_arbeitsstand statt nur checkout', () => {
    expect(text).toContain('source "${AGENT_DIR}/scripts/deploy-rueckfall.sh" ||');
    expect(text).toContain('rueckfall_arbeitsstand "$PRIMARY_BUILD_DIR" "$LAST_GOOD" "$DEPLOY_SHA"');
    expect(text).not.toMatch(/if ! git -C "\$PRIMARY_BUILD_DIR" checkout "\$LAST_GOOD" -- \.; then/);
  });
  test('Ablauf steht in einer Funktion — bash liest sie ganz, bevor der Rückfall deploy.sh ersetzt', () => {
    expect(text).toMatch(/\nhauptablauf\(\) \{\n/);
    expect(text.trimEnd().endsWith('hauptablauf "$@"\nexit $?')).toBe(true);
  });
  test('bash -n: Syntax in Ordnung', () => {
    expect(spawnSync('bash', ['-n', DEPLOY]).status).toBe(0);
  });
});
