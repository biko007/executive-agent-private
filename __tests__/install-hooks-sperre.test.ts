/**
 * Ein Hook, zwei Stränge: Niemand überschreibt den anderen.
 *
 * ANLASS (Owner-Auftrag 16.10.2026). `~/.claude/hooks/` ist für alle Stränge
 * dieselbe Stelle, aber bikosoc und HDCC pflegen den Deny-Hook in je eigenen
 * Repos. Wer zuletzt `install-hooks.sh` ausführte, gewann — und die Arbeit des
 * anderen war weg.
 *
 * Am selben Tag wäre es beinahe passiert: Die HDCC-Sitzung hatte den aktiven
 * Hook um 12:25 erweitert. Aufgefallen ist es nur, weil der Smoke-Test Drift
 * meldete und jemand nachsah. Darauf soll sich niemand verlassen müssen.
 *
 * Die Sperre arbeitet mit einer Marke neben dem Hook: der Prüfsumme dessen,
 * was bikosoc zuletzt selbst ausgespielt hat. Weicht der aktive Hook davon
 * ab, war ein anderer am Werk.
 *
 * Diese Tests fahren das echte Skript in einer Wegwerf-Umgebung mit eigenem
 * HOME. Der wichtigste Test ist nicht, dass der Abbruch kommt, sondern dass
 * beim Abbruch **nichts angefasst** wird.
 */
import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, writeFileSync, readFileSync, rmSync, mkdirSync, existsSync, appendFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';

const SKRIPT = resolve(import.meta.dir, '..', 'scripts', 'install-hooks.sh');
const REPO_HOOKS = resolve(import.meta.dir, '..', 'hooks');
const HOOK = 'deny-destructive.sh';

let heim: string;
let live: string;
let marke: string;

beforeEach(() => {
  heim = mkdtempSync(join(tmpdir(), 'hooksperre-'));
  live = join(heim, '.claude', 'hooks', HOOK);
  marke = join(heim, '.claude', 'hooks', `.${HOOK}.bikosoc-stand`);
});
afterEach(() => rmSync(heim, { recursive: true, force: true }));

function lauf(...args: string[]): { code: number; aus: string } {
  const r = spawnSync('bash', [SKRIPT, ...args], {
    env: { ...process.env, HOME: heim },
    encoding: 'utf-8',
  });
  return { code: r.status ?? -1, aus: `${r.stdout ?? ''}${r.stderr ?? ''}` };
}

const hash = (p: string) => createHash('sha256').update(readFileSync(p)).digest('hex');
/** Die Marke traegt einen abschliessenden Zeilenumbruch — sha256sum schreibt ihn. */
const markeLesen = () => readFileSync(marke, 'utf-8').trim();
const repoStand = () => readFileSync(join(REPO_HOOKS, HOOK), 'utf-8');

/** Einen aktiven Hook anlegen, wahlweise mit Marke. */
function vorbereiten(inhalt: string, mitMarke: boolean) {
  mkdirSync(join(heim, '.claude', 'hooks'), { recursive: true });
  writeFileSync(live, inhalt, { mode: 0o755 });
  if (mitMarke) writeFileSync(marke, hash(live));
}

describe('Erstinstallation', () => {
  test('ohne vorhandenen Hook wird ausgespielt und die Marke angelegt', () => {
    const r = lauf();
    expect(r.code).toBe(0);
    expect(r.aus).toContain('installed:');
    expect(existsSync(live)).toBe(true);
    expect(markeLesen()).toBe(hash(live));
  });

  test('die Marke ist nur für den Eigentümer lesbar', () => {
    lauf();
    expect(statSync(marke).mode & 0o777).toBe(0o600);
  });
});

describe('Marke fehlt', () => {
  test('bei Gleichstand wird sie einmalig angelegt', () => {
    /* Der erste Lauf nach dieser Änderung: Der aktive Hook stimmt mit dem
       Repo überein, also ist nichts strittig. */
    vorbereiten(repoStand(), false);

    const r = lauf();

    expect(r.code).toBe(0);
    expect(r.aus).toContain('unchanged:');
    expect(markeLesen()).toBe(hash(live));
  });

  test('bei Abweichung wird abgebrochen — raten ist hier falsch', () => {
    /* Ohne Marke und mit abweichendem Inhalt wissen wir NICHT, wer den
       aktiven Hook geschrieben hat. Dann nicht überschreiben. */
    vorbereiten(repoStand() + '\n# von irgendwem\n', false);

    const r = lauf();

    expect(r.code).toBe(4);
    expect(r.aus).toContain('keine Marke');
  });
});

describe('Eigener Stand', () => {
  test('wird anstandslos überschrieben', () => {
    /* Aktiver Hook = was bikosoc zuletzt ausgespielt hat, Repo ist weiter. */
    vorbereiten('#!/usr/bin/env bash\n# alter eigener Stand\n', true);

    const r = lauf();

    expect(r.code).toBe(0);
    expect(r.aus).toContain('updated:');
    expect(readFileSync(live, 'utf-8')).toBe(repoStand());
    expect(markeLesen()).toBe(hash(live));
  });

  test('bei Gleichstand bleibt alles, die Marke wird nachgezogen', () => {
    vorbereiten(repoStand(), true);
    const vorher = readFileSync(live, 'utf-8');

    const r = lauf();

    expect(r.code).toBe(0);
    expect(r.aus).toContain('unchanged:');
    expect(readFileSync(live, 'utf-8')).toBe(vorher);
  });
});

describe('Fremder Stand — der Fall, um den es geht', () => {
  function fremd() {
    vorbereiten(repoStand(), true);          // erst unser Stand, mit Marke
    appendFileSync(live, '\n# Erweiterung der HDCC-Sitzung\n');   // dann der andere
  }

  test('bricht ab', () => {
    fremd();
    expect(lauf().code).toBe(4);
  });

  test('fasst den aktiven Hook NICHT an', () => {
    /* Der eigentliche Zweck. Ein Abbruch, der vorher schon kopiert hat, wäre
       wertlos. */
    fremd();
    const vorher = readFileSync(live, 'utf-8');

    lauf();

    expect(readFileSync(live, 'utf-8')).toBe(vorher);
    expect(readFileSync(live, 'utf-8')).toContain('HDCC-Sitzung');
  });

  test('nennt beide Stände und den Weg', () => {
    fremd();
    const r = lauf();
    expect(r.aus).toContain('aktiv:');
    expect(r.aus).toContain('von bikosoc:');
    expect(r.aus).toContain('im Repo:');
    expect(r.aus).toContain('ERST uebernehmen, DANN ausspielen');
    expect(r.aus).toContain('cp ');                     // der konkrete Befehl
  });

  test('auch der zweite Hook bleibt unangetastet', () => {
    /* Zwei Durchgänge: Erst wird alles geprüft, dann erst gehandelt. Sonst
       bliebe bei einem Abbruch ein halb ausgespielter Zustand. */
    fremd();
    const zweiter = join(heim, '.claude', 'hooks', 'telegram-notify.sh');
    writeFileSync(zweiter, '#!/usr/bin/env bash\n# alt\n', { mode: 0o755 });

    lauf();

    expect(readFileSync(zweiter, 'utf-8')).toContain('# alt');
  });

  test('mit dem ausdrücklichen Schalter wird doch ausgespielt', () => {
    /* Der Weg für den Tag, an dem der fremde Stand verworfen werden SOLL.
       Unbequem benannt, damit er nicht aus Gewohnheit mitläuft. */
    fremd();
    const r = lauf('--fremden-stand-verwerfen');
    expect(r.code).toBe(0);
    expect(readFileSync(live, 'utf-8')).toBe(repoStand());
  });

  test('ein unbekanntes Argument spielt NICHTS aus', () => {
    fremd();
    const vorher = readFileSync(live, 'utf-8');
    const r = lauf('--force');
    expect(r.code).toBe(2);
    expect(readFileSync(live, 'utf-8')).toBe(vorher);
  });
});
