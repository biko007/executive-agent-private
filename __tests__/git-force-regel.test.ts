/**
 * Die harte Regel gegen die erzwungene Übertragung.
 *
 * ANLASS (Owner, 16.10.2026): Die Regel lautete sinngemäß „ein `push`
 * irgendwo, ein `-f` irgendwo dahinter" — über Semikolons und Pipes hinweg.
 * Damit blockierte sie
 *
 *     … arm-vormerken.ts "…" push …; test -f ~/.armed-bikosoc
 *
 * an einem `test -f`, das mit Git nichts zu tun hat. Die Regel ist **hart**
 * und nicht armbar; ein Fehlalarm lässt sich also nicht wegdrücken.
 *
 * Mein erster Vorschlag war `git\\s+push\\s+…` — der Owner hat ihn zu Recht
 * verworfen: Er hätte `git -C /abs/pfad push --force` nicht mehr erfasst,
 * also ausgerechnet den Ausweg, den der Hook selbst empfiehlt, wenn das
 * Push-Ziel nicht bestimmbar ist.
 *
 * Jetzt gilt die Regel innerhalb EINES Befehlssegments. Diese Tests prüfen
 * beide Richtungen, und die zweite ist die wichtigere: Eine Regel, die zu
 * viel durchlässt, wäre schlimmer als der Fehlalarm, den sie behebt.
 */
import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

const HOOK = resolve(import.meta.dir, '..', 'hooks', 'deny-destructive.sh');

/* Zusammengesetzt, damit das blosse Lesen dieser Datei durch ein Werkzeug
   nicht den Hook ausloest — dieselbe Vorsicht wie im Verankerungstest. */
const P = 'p' + 'ush';
const FL = '--' + 'force';
const FK = '-' + 'f';

let heim: string;
let conf: string;

beforeAll(() => {
  heim = mkdtempSync(join(tmpdir(), 'gitforce-'));
  mkdirSync(join(heim, '.config', 'openclaw'), { recursive: true });
  conf = join(heim, '.config', 'openclaw', 'red-zone.conf');
  /* Leere Rote Zone: Hier geht es allein um die harten Regeln. */
  writeFileSync(conf, '[red-paths]\n\n[red-commands]\n');

  /* Ein vollstaendiges Repo samt ERREICHBAREM Gegenstueck. Beides ist noetig:
     Ohne Repo waere das Push-Ziel unbestimmbar, und ohne erreichbares
     Gegenstueck schlaegt die Diff-Pruefung des Hooks fehl. In beiden Faellen
     geht er fail-closed und blockiert JEDEN Push — auch den harmlosen. Die
     Tests wuerden dann gruen oder rot aus dem falschen Grund. */
  const fern = join(heim, 'fern.git');
  spawnSync('git', ['init', '-q', '--bare', '-b', 'master', fern]);
  for (const argv of [
    ['init', '-q', '-b', 'master'],
    ['config', 'user.email', 'test@example.invalid'],
    ['config', 'user.name', 'Test'],
    ['remote', 'add', 'origin', fern],
  ]) spawnSync('git', ['-C', heim, ...argv]);
  writeFileSync(join(heim, 'datei.txt'), 'inhalt\n');
  spawnSync('git', ['-C', heim, 'add', 'datei.txt']);
  spawnSync('git', ['-C', heim, 'commit', '-q', '-m', 'erster']);
  /* Einmal uebertragen, damit ein Upstream existiert und `git diff` einen
     Vergleichspunkt hat. Laeuft an Claude Code vorbei, also am Hook vorbei. */
  spawnSync('git', ['-C', heim, 'push', '-q', '-u', 'origin', 'master']);
});

afterAll(() => rmSync(heim, { recursive: true, force: true }));

function pruefe(command: string, armed = false): number {
  const flagge = join(heim, '.armed-bikosoc');
  if (armed) writeFileSync(flagge, 'armed by test\n');
  else rmSync(flagge, { force: true });
  const r = spawnSync('bash', [HOOK], {
    input: JSON.stringify({ tool_name: 'Bash', tool_input: { command }, cwd: heim }),
    env: { ...process.env, HOME: heim, RED_ZONE_CONF: conf, HOOK_LOG: join(heim, 'hooks.log') },
    encoding: 'utf-8',
  });
  return r.status ?? -1;
}

const blockiert = (c: string) => pruefe(c) === 2;

describe('Erzwungene Übertragung bleibt in jeder Schreibweise gesperrt', () => {
  const rot: Array<[string, string]> = [
    ['schlicht, lange Form', `git ${P} ${FL}`],
    ['schlicht, kurze Form', `git ${P} ${FK}`],
    ['mit Lease', `git ${P} --force-with-lease`],
    ['Lease mit Wert', `git ${P} --force-with-lease=master:abc123`],
    ['mit -C und absolutem Pfad', `git -C /home/biko/repo ${P} ${FL}`],
    ['mit -C und kurzer Form', `git -C /home/biko/repo ${P} ${FK}`],
    ['mit -c Konfigurationswert', `git -c user.name=x ${P} ${FK}`],
    ['mit --git-dir und --work-tree', `git --git-dir=/x/.git --work-tree=/x ${P} ${FK}u`],
    ['kombinierte Kurzflags, f zuerst', `git ${P} ${FK}u origin master`],
    ['kombinierte Kurzflags, f hinten', `git ${P} -uf origin master`],
    ['Flag nach dem Ziel', `git ${P} origin master ${FL}`],
    ['Refspec mit führendem Plus', `git ${P} origin +master`],
    ['Refspec mit Plus und Doppelpunkt', `git ${P} origin +master:master`],
    ['nach &&', `npm test && git ${P} ${FL}`],
    ['nach einem Semikolon', `cd /repo; git ${P} ${FK}`],
    ['mit --no-pager davor', `git --no-pager ${P} ${FL}`],
  ];

  for (const [name, befehl] of rot) {
    test(name, () => {
      expect(blockiert(befehl), befehl).toBe(true);
    });
  }

  test('auch mit Freigabe gesperrt — harte Regeln sind nicht armbar', () => {
    expect(pruefe(`git -C /home/biko/repo ${P} ${FL}`, true)).toBe(2);
    expect(pruefe(`git ${P} origin +master`, true)).toBe(2);
  });
});

describe('Harmlose Befehle laufen wieder durch', () => {
  /* WICHTIG fuer das Verstaendnis dieser Liste: Eine Uebertragung OHNE
     aufloesbaren Repo-Pfad ist in diesem Projekt seit jeher fail-closed —
     der Hook verlangt `git -C /abs/pfad` oder ein vorangestelltes
     `cd /abs/pfad`. Das ist Absicht und hier nicht das Thema. Die harmlosen
     Faelle stehen deshalb in der Form, die im Betrieb wirklich benutzt wird.

     Die Befehle entstehen erst im Test: Beim Einsammeln der Testfaelle ist
     das Wegwerf-Verzeichnis noch nicht angelegt. */
  const gruen: Array<[string, (h: string) => string]> = [
    ['der Fall, der den Auftrag ausgelöst hat',
      () => `bun run scripts/arm-vormerken.ts "drei Commits" ${P}; test ${FK} ~/.armed-bikosoc`],
    ['test -f in einem anderen Segment',
      (h) => `git -C ${h} ${P} origin master; test ${FK} /tmp/x && echo da`],
    ['normale Übertragung mit -C',
      (h) => `git -C ${h} ${P} origin master`],
    ['normale Übertragung nach cd',
      (h) => `cd ${h}; git ${P} origin master`],
    ['Übertragung mit Upstream',
      (h) => `git -C ${h} ${P} -u origin master`],
    ['Übertragung mit Tags',
      (h) => `git -C ${h} ${P} --follow-tags origin master`],
    ['rm -f in einem anderen Segment',
      (h) => `git -C ${h} ${P} origin master | cat; rm ${FK} /tmp/datei`],
    ['ein Wort push ohne git',
      () => `bun run scripts/arm-vormerken.ts "etwas" ${P}`],
    ['find mit -f-ähnlichem Schalter nach einer Pipe',
      (h) => `git -C ${h} ${P} origin master | grep -q ok; find /tmp -type f`],
  ];

  for (const [name, bauen] of gruen) {
    test(name, () => {
      const befehl = bauen(heim);
      expect(blockiert(befehl), befehl).toBe(false);
    });
  }

  test('eine Übertragung ohne Pfad bleibt fail-closed — unverändert', () => {
    /* Nicht Gegenstand dieser Aenderung, aber festgehalten: Wer den Pfad
       weglaesst, wird blockiert, mit dem Hinweis, ihn nachzureichen. */
    expect(blockiert(`git ${P} origin master`)).toBe(true);
  });
});

/* Auf Owner-Wunsch vom 16.10.2026 bekamen auch diese beiden dieselbe
   Fassung wie die Uebertragung: innerhalb EINES Befehlssegments und mit
   `git` davor. Vorher genuegte das Wortpaar irgendwo im Befehlstext. */
const R = 're' + 'set';
const H = '--' + 'hard';
const CL = 'cl' + 'ean';

describe('Zurücksetzen und Aufräumen — segmentweise gefasst', () => {
  const rot: Array<[string, (h: string) => string]> = [
    ['zurücksetzen, schlicht', () => `git ${R} ${H}`],
    ['zurücksetzen auf eine Marke', () => `git ${R} ${H} origin/main`],
    ['zurücksetzen mit -C', (h) => `git -C ${h} ${R} ${H}`],
    ['zurücksetzen nach &&', () => `npm test && git ${R} ${H}`],
    ['zurücksetzen nach einem Semikolon', (h) => `cd ${h}; git ${R} ${H}`],
    ['aufräumen, kurze Form', () => `git ${CL} ${FK}`],
    ['aufräumen, lange Form', () => `git ${CL} ${FL}`],
    ['aufräumen mit kombinierten Flags', () => `git ${CL} -fd`],
    ['aufräumen, f hinten', () => `git ${CL} -df`],
    ['aufräumen mit -C und drei Flags', (h) => `git -C ${h} ${CL} -fdx`],
  ];
  for (const [name, bauen] of rot) {
    test(name, () => {
      const b = bauen(heim);
      expect(blockiert(b), b).toBe(true);
    });
  }

  test('auch mit Freigabe gesperrt — es sind harte Regeln', () => {
    expect(pruefe(`git ${R} ${H}`, true)).toBe(2);
    expect(pruefe(`git ${CL} -fd`, true)).toBe(2);
  });

  const gruen: Array<[string, (h: string) => string]> = [
    ['der Probelauf von aufräumen', () => `git ${CL} -n`],
    ['Probelauf, lange Form', () => `git ${CL} --dry-run`],
    ['zurücksetzen ohne die harte Form', () => `git ${R} HEAD~1`],
    ['sanftes Zurücksetzen', () => `git ${R} --soft HEAD~1`],
    ['gemischtes Zurücksetzen', () => `git ${R} --mixed HEAD~1`],
    ['das Wortpaar in einem anderen Segment',
      () => `git status; echo "${R} ${H} waere schlecht"`],
    ['ein Pfad, der mit f beginnt', () => `git ${CL} -n -- fixtures/`],
  ];
  for (const [name, bauen] of gruen) {
    test(name, () => {
      const b = bauen(heim);
      expect(blockiert(b), b).toBe(false);
    });
  }
});

describe('Die übrigen harten Regeln sind unverändert', () => {
  test('rekursives Löschen bleibt gesperrt', () => {
    expect(blockiert('r' + 'm -rf /tmp/irgendwas')).toBe(true);
  });

  test('Auschecken des ganzen Baums bleibt gesperrt', () => {
    expect(blockiert('git checkout .')).toBe(true);
  });
});
