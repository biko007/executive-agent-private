/**
 * E2E-Test der Prompt-Inbox über die echte Kette:
 *   Datei-Drop → Poller → echtes tmux → Empfänger führt den Auftrag aus
 *
 * Kein eingehängter Runner — der Test benutzt den echten `execFileSync`-Pfad
 * und eine echte tmux-Sitzung. Nur so ist nachgewiesen, dass der Auftrag
 * tatsächlich **abgeschickt** und nicht bloß ins Eingabefeld eingetragen wird.
 *
 * **Der Empfänger ist eine Nachbildung, kein echtes Claude Code.** Er
 * unterscheidet genau das Merkmal, an dem der Defekt vom 2026-10-03 hing, und
 * dieses Merkmal ist am 2026-10-03 im Rohmodus nachgemessen worden:
 *
 *   ein send-keys-Aufruf   → ein Leseschub:  "PROMPT\r"
 *   zwei send-keys-Aufrufe → zwei Schübe:    "PROMPT", dann "\r"
 *
 * Die Nachbildung führt den Auftrag nur aus, wenn der Wagenrücklauf in einem
 * eigenen Schub ankommt — wie eine TUI, die einen Schub aus Text und
 * Wagenrücklauf als Einfügevorgang behandelt. Gegen eine Shell wäre beides
 * gleichwertig; genau deshalb hat die alte Testlage den Fehler nicht gesehen.
 *
 * Der Test enthält eine Gegenprobe: derselbe Empfänger, mit dem alten
 * Ein-Aufruf-Muster beschickt, führt NICHT aus. Damit ist belegt, dass der
 * Test den Unterschied wirklich messen kann.
 */
import { describe, expect, test, beforeAll, afterAll } from 'bun:test';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, existsSync, rmSync, readFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { processPromptInboxOnce } from '../index.js';

/** tmux vorhanden? Ohne tmux ist der Test nicht aussagekräftig. */
function tmuxVorhanden(): boolean {
  const r = spawnSync('tmux', ['-V'], { stdio: 'ignore' });
  return r.status === 0;
}

const HAT_TMUX = tmuxVorhanden();

/**
 * Empfänger-Nachbildung: liest im Rohmodus und schreibt eine Markierungsdatei,
 * sobald ein Auftrag tatsächlich abgeschickt wurde.
 *
 * Regeln, der TUI nachempfunden:
 *  - Ein Schub, der Text UND Wagenrücklauf enthält, ist ein Einfügevorgang:
 *    der Text landet im Puffer, der Umbruch wird als Zeilenumbruch behandelt,
 *    es wird NICHT abgeschickt.
 *  - Ein Schub, der nur aus dem Wagenrücklauf besteht, ist ein Tastendruck:
 *    der Puffer wird abgeschickt (Markierungsdatei wird geschrieben).
 */
const EMPFAENGER_QUELLE = `
import { writeFileSync, appendFileSync } from "node:fs";
const marker = process.argv[2];
const protokoll = process.argv[3];
let puffer = "";
writeFileSync(protokoll, "");
process.stdin.setRawMode?.(true);
process.stdin.on("data", (b) => {
  const s = b.toString("utf-8");
  appendFileSync(protokoll, JSON.stringify({ bytes: b.length, data: s }) + "\\n");
  const istNurWagenruecklauf = s === "\\r" || s === "\\n" || s === "\\r\\n";
  if (istNurWagenruecklauf) {
    if (puffer.trim()) writeFileSync(marker, puffer);   // abgeschickt
    puffer = "";
    return;
  }
  // Einfuegevorgang: Text uebernehmen, enthaltene Umbrueche NICHT als
  // Abschicken deuten.
  puffer += s.replace(/\\r|\\n/g, " ");
});
`;

let arbeitsVerzeichnis: string;
let empfaengerPfad: string;
const SITZUNG = `inbox-e2e-${process.pid}`;

beforeAll(() => {
  arbeitsVerzeichnis = mkdtempSync(join(tmpdir(), 'inbox-e2e-'));
  empfaengerPfad = join(arbeitsVerzeichnis, 'empfaenger.mjs');
  writeFileSync(empfaengerPfad, EMPFAENGER_QUELLE);
});

afterAll(() => {
  if (HAT_TMUX) {
    spawnSync('tmux', ['kill-session', '-t', SITZUNG], { stdio: 'ignore' });
  }
  rmSync(arbeitsVerzeichnis, { recursive: true, force: true });
});

/** Eine tmux-Sitzung mit der Empfänger-Nachbildung starten. */
function sitzungStarten(marker: string, protokoll: string): void {
  spawnSync('tmux', ['kill-session', '-t', SITZUNG], { stdio: 'ignore' });
  execFileSync('tmux', [
    'new-session', '-d', '-s', SITZUNG, '-x', '200', '-y', '50',
    `node ${empfaengerPfad} ${marker} ${protokoll}`,
  ], { stdio: 'ignore' });
  // Dem Empfänger Zeit geben, den Rohmodus zu aktivieren.
  warte(900);
}

function warte(ms: number): void {
  const shared = new Int32Array(new SharedArrayBuffer(4));
  Atomics.wait(shared, 0, 0, ms);
}

describe('Prompt-Inbox E2E über echtes tmux', () => {
  test.if(HAT_TMUX)('Datei-Drop wird tatsächlich ausgeführt, nicht nur eingetragen', () => {
    const marker = join(arbeitsVerzeichnis, 'ausgefuehrt.txt');
    const protokoll = join(arbeitsVerzeichnis, 'schuebe-fix.txt');
    rmSync(marker, { force: true });
    sitzungStarten(marker, protokoll);

    // Echte Inbox-Struktur anlegen und eine Auftragsdatei ablegen.
    const homeDir = join(arbeitsVerzeichnis, 'home-fix');
    const inboxDir = join(homeDir, 'inbox');
    mkdirSync(inboxDir, { recursive: true });
    const auftrag = 'AUTO — Wiki-Import fortsetzen und Report schreiben.';
    writeFileSync(join(inboxDir, 'auftrag.txt'), auftrag);

    // Der echte Poller, mit dem echten tmux-Pfad (kein eingehängter Runner),
    // nur auf die Testsitzung umgelenkt.
    const ergebnis = processPromptInboxOnce({
      homeDir,
      runner: (file, args, options) => {
        const umgelenkt = args.map((a) => (a === 'bikosoc' ? SITZUNG : a));
        execFileSync(file, umgelenkt, { stdio: 'ignore', timeout: options?.timeout });
      },
    });

    expect(ergebnis).toHaveLength(1);
    // Datei wurde nach done/ verschoben — das tat der Poller auch im Defektfall.
    expect(existsSync(ergebnis[0].donePath)).toBe(true);

    // Der entscheidende Nachweis: der Empfänger hat den Auftrag ABGESCHICKT.
    warte(1200);
    expect(existsSync(marker)).toBe(true);
    expect(readFileSync(marker, 'utf-8')).toContain('Wiki-Import fortsetzen');

    // Belegstelle: der Wagenrücklauf kam als eigener Schub an.
    const schuebe = readFileSync(protokoll, 'utf-8').trim().split('\n')
      .filter(Boolean).map((l) => JSON.parse(l) as { data: string });
    expect(schuebe.length).toBeGreaterThanOrEqual(2);
    expect(schuebe.some((s) => s.data === '\r' || s.data === '\n')).toBe(true);
  });

  test.if(HAT_TMUX)('Gegenprobe: das alte Ein-Aufruf-Muster führt NICHT aus', () => {
    // Beweist, dass der Test oben den Unterschied wirklich messen kann und
    // nicht ohnehin grün wäre.
    const marker = join(arbeitsVerzeichnis, 'alt-ausgefuehrt.txt');
    const protokoll = join(arbeitsVerzeichnis, 'schuebe-alt.txt');
    rmSync(marker, { force: true });
    sitzungStarten(marker, protokoll);

    // Genau der Aufruf, der bis 2026-10-03 im Code stand.
    execFileSync('tmux', [
      'send-keys', '-t', SITZUNG, '--', 'AUTO — alter Pfad', 'Enter',
    ], { stdio: 'ignore' });

    warte(1200);
    expect(existsSync(marker)).toBe(false);

    // Belegstelle: Text und Wagenrücklauf kamen in EINEM Schub.
    const schuebe = readFileSync(protokoll, 'utf-8').trim().split('\n')
      .filter(Boolean).map((l) => JSON.parse(l) as { data: string });
    expect(schuebe.length).toBe(1);
    expect(schuebe[0].data).toContain('alter Pfad');
    expect(schuebe[0].data.endsWith('\r')).toBe(true);
  });
});
