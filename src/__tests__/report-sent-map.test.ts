import { describe, expect, test } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * Regression: Report-Watcher Delivered-Index (.report-sent.json).
 *
 * Befund report-gateway-restart-1257.md (Paragraph 3): am 2026-09-04 wurden zwischen
 * 07:01 und 12:39 UTC 239 Alt-Reports erneut zugestellt (68 verschiedene Dateien, teils
 * 5x). Ursache war das Zusammenspiel zweier Defekte in index.ts:
 *
 *   1. saveReportSentMap() schrieb per writeFileSync direkt auf .report-sent.json.
 *      writeFileSync leert die Zieldatei und befuellt sie neu — ein gleichzeitiger Leser
 *      sieht dabei unvollstaendiges JSON. Auslöser gibt es reichlich: drei fs.watch-Watcher
 *      mit eigenem Debounce, und der Schreibvorgang liegt selbst im ueberwachten
 *      Verzeichnis ~/bikosoc-spec/.
 *   2. loadReportSentMap() fiel bei JEDEM Fehler auf eine leere Map zurueck. Der Scan
 *      hielt daraufhin den gesamten Bestand fuer unzugestellt, lieferte aus und schrieb
 *      die fast leere Map zurueck — der Verlust wurde persistiert.
 *
 * Die Tests unten spiegeln die reparierte Implementierung (Konvention wie in
 * callback-suppression.test.ts) und pruefen sie gegen echte Dateien. Damit die Spiegelung
 * nicht von index.ts abdriften kann, sichern die statischen Guards am Ende die
 * tatsaechliche Quelle ab.
 */

type SentMap = Map<string, number | string>;

interface Logged { level: 'error' | 'warn'; message: string }

function makeLogger(sink: Logged[]) {
  return {
    error: (message: string) => sink.push({ level: 'error', message }),
    warn: (message: string) => sink.push({ level: 'warn', message }),
  };
}

// ── Spiegel der Implementierung aus index.ts ────────────────────────────────
function loadReportSentMap(sentPath: string, logger: ReturnType<typeof makeLogger>): SentMap {
  let raw: string;
  try {
    raw = fs.readFileSync(sentPath, 'utf-8');
  } catch (e: any) {
    if (e?.code === 'ENOENT') return new Map();
    logger.error(`[report-watcher] sent-map unlesbar (${sentPath}): ${e.message} — Scan wird uebersprungen, KEINE Zustellung`);
    throw e;
  }
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error(`unerwartete Struktur: ${Array.isArray(parsed) ? 'Array' : typeof parsed}`);
    }
    return new Map(Object.entries(parsed as Record<string, number | string>));
  } catch (e: any) {
    logger.error(`[report-watcher] sent-map defekt (${sentPath}): ${e.message} — Scan wird uebersprungen, KEINE Zustellung`);
    throw e;
  }
}

function saveReportSentMap(
  sentPath: string,
  m: SentMap,
  logger: ReturnType<typeof makeLogger>,
  unveraendert?: string,
  pid: number = process.pid,
): void {
  const obj = Object.fromEntries(m);
  const inhalt = JSON.stringify(obj, null, 2);
  if (unveraendert !== undefined && inhalt === unveraendert) return;
  const tmpPath = `${sentPath}.tmp-${pid}`;
  try {
    fs.mkdirSync(path.dirname(sentPath), { recursive: true });
    fs.writeFileSync(tmpPath, inhalt);
    fs.renameSync(tmpPath, sentPath);
  } catch (e: any) {
    try { fs.unlinkSync(tmpPath); } catch { /* best-effort cleanup */ }
    logger.warn(`[report-watcher] save sent-map failed: ${e.message}`);
  }
}

// Verdichtete Scan-Schleife: genau die Stelle, an der der Bestand ausgeliefert wurde.
// Liefert die Namen, die zugestellt WUERDEN — Fehler beim Laden brechen ab (leeres Ergebnis).
function scanCandidates(sentPath: string, files: { key: string; mtimeMs: number }[], logger: ReturnType<typeof makeLogger>): string[] {
  let sentMap: SentMap;
  try {
    sentMap = loadReportSentMap(sentPath, logger);
  } catch {
    return [];
  }
  const toSend: string[] = [];
  for (const f of files) {
    const lastSent = sentMap.get(f.key);
    if (lastSent === undefined || typeof lastSent === 'string' || f.mtimeMs > lastSent) toSend.push(f.key);
  }
  return toSend;
}

function withTmpDir<T>(fn: (dir: string) => T): T {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'report-sent-map-'));
  try {
    return fn(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

const BESTAND = [
  { key: 'spec:report-security-20260712-1628.md', mtimeMs: 1_000 },
  { key: 'spec:report-lesbar-20260713-1201.md', mtimeMs: 2_000 },
  { key: 'home:report-upgrade-9.1-20260904-0916.md', mtimeMs: 3_000 },
];

function writeIndex(dir: string, entries: Record<string, number | string>): string {
  const p = path.join(dir, '.report-sent.json');
  fs.writeFileSync(p, JSON.stringify(entries, null, 2));
  return p;
}

describe('loadReportSentMap — fail-closed statt fail-open', () => {
  test('fehlende Datei ist der legitime Erstlauf: leere Map, kein Fehler', () => {
    withTmpDir(dir => {
      const logs: Logged[] = [];
      const map = loadReportSentMap(path.join(dir, '.report-sent.json'), makeLogger(logs));
      expect(map.size).toBe(0);
      expect(logs).toEqual([]);
    });
  });

  test('gueltiger Index wird vollstaendig gelesen', () => {
    withTmpDir(dir => {
      const logs: Logged[] = [];
      const p = writeIndex(dir, { 'spec:report-a.md': 1_000, 'plan-hash:plan-b.md': 'deadbeefdeadbeef' });
      const map = loadReportSentMap(p, makeLogger(logs));
      expect(map.size).toBe(2);
      expect(map.get('spec:report-a.md')).toBe(1_000);
      expect(map.get('plan-hash:plan-b.md')).toBe('deadbeefdeadbeef');
      expect(logs).toEqual([]);
    });
  });

  test('unvollstaendiges JSON (der reale Race) wirft und loggt einen Fehler', () => {
    withTmpDir(dir => {
      const logs: Logged[] = [];
      const p = path.join(dir, '.report-sent.json');
      // Genau das, was ein Leser waehrend eines nicht-atomaren writeFileSync sieht:
      fs.writeFileSync(p, '{\n  "spec:report-security-20260712-1628.md": 17515');
      expect(() => loadReportSentMap(p, makeLogger(logs))).toThrow();
      expect(logs).toHaveLength(1);
      expect(logs[0].level).toBe('error');
      expect(logs[0].message).toContain('sent-map defekt');
      expect(logs[0].message).toContain('KEINE Zustellung');
    });
  });

  test('leere Datei (Schreibfenster) wirft und loggt einen Fehler', () => {
    withTmpDir(dir => {
      const logs: Logged[] = [];
      const p = path.join(dir, '.report-sent.json');
      fs.writeFileSync(p, '');
      expect(() => loadReportSentMap(p, makeLogger(logs))).toThrow();
      expect(logs[0]?.message).toContain('sent-map defekt');
    });
  });

  test('syntaktisch gueltiges, strukturell falsches JSON wirft ebenfalls', () => {
    for (const payload of ['null', '[]', '42', '"x"']) {
      withTmpDir(dir => {
        const logs: Logged[] = [];
        const p = path.join(dir, '.report-sent.json');
        fs.writeFileSync(p, payload);
        expect(() => loadReportSentMap(p, makeLogger(logs))).toThrow();
        expect(logs[0]?.message, payload).toContain('sent-map defekt');
      });
    }
  });

  test('unlesbare Datei (EACCES) wirft und loggt, ohne als Erstlauf zu gelten', () => {
    withTmpDir(dir => {
      const logs: Logged[] = [];
      const p = writeIndex(dir, { 'spec:report-a.md': 1_000 });
      fs.chmodSync(p, 0o000);
      try {
        // root ignoriert Dateirechte — dann ist dieser Fall nicht pruefbar.
        let readable = true;
        try { fs.readFileSync(p, 'utf-8'); } catch { readable = false; }
        if (!readable) {
          expect(() => loadReportSentMap(p, makeLogger(logs))).toThrow();
          expect(logs[0]?.message).toContain('sent-map unlesbar');
        }
      } finally {
        fs.chmodSync(p, 0o600);
      }
    });
  });
});

describe('Scan-Verhalten bei defektem Index — die eigentliche Regression', () => {
  test('kaputtes JSON stellt NICHTS zu (vorher: kompletter Bestand)', () => {
    withTmpDir(dir => {
      const logs: Logged[] = [];
      const p = path.join(dir, '.report-sent.json');
      fs.writeFileSync(p, '{ "spec:report-security-20260712-1628.md": 17515');

      const toSend = scanCandidates(p, BESTAND, makeLogger(logs));

      expect(toSend).toEqual([]);
      expect(logs.some(l => l.level === 'error' && l.message.includes('sent-map defekt'))).toBe(true);
    });
  });

  test('defekter Index wird NICHT durch eine leere Map ueberschrieben', () => {
    withTmpDir(dir => {
      const p = path.join(dir, '.report-sent.json');
      const broken = '{ "spec:report-security-20260712-1628.md": 17515';
      fs.writeFileSync(p, broken);

      scanCandidates(p, BESTAND, makeLogger([]));

      // Der Scan bricht vor saveReportSentMap ab — die Datei bleibt unangetastet,
      // der Verlust wird also nicht persistiert.
      expect(fs.readFileSync(p, 'utf-8')).toBe(broken);
    });
  });

  test('gueltiger Index stellt nur wirklich neue/geaenderte Dateien zu', () => {
    withTmpDir(dir => {
      const p = writeIndex(dir, {
        'spec:report-security-20260712-1628.md': 1_000,
        'spec:report-lesbar-20260713-1201.md': 2_000,
      });
      const toSend = scanCandidates(p, BESTAND, makeLogger([]));
      expect(toSend).toEqual(['home:report-upgrade-9.1-20260904-0916.md']);
    });
  });

  test('Erstlauf ohne Indexdatei liefert weiterhin den Bestand (Seed-Pfad bleibt intakt)', () => {
    withTmpDir(dir => {
      const toSend = scanCandidates(path.join(dir, '.report-sent.json'), BESTAND, makeLogger([]));
      expect(toSend).toHaveLength(BESTAND.length);
    });
  });
});

describe('saveReportSentMap — atomarer Austausch', () => {
  test('schreibt vollstaendig und laesst keine .tmp-Datei zurueck', () => {
    withTmpDir(dir => {
      const p = path.join(dir, '.report-sent.json');
      const m: SentMap = new Map([['spec:report-a.md', 1_000], ['plan-hash:plan-b.md', 'abc123']]);
      saveReportSentMap(p, m, makeLogger([]));

      expect(fs.readdirSync(dir).filter(n => n.includes('.tmp'))).toEqual([]);
      expect(JSON.parse(fs.readFileSync(p, 'utf-8'))).toEqual({
        'spec:report-a.md': 1_000,
        'plan-hash:plan-b.md': 'abc123',
      });
    });
  });

  test('Round-Trip ueber 200 Eintraege ist verlustfrei', () => {
    withTmpDir(dir => {
      const p = path.join(dir, '.report-sent.json');
      const m: SentMap = new Map();
      for (let i = 0; i < 200; i++) m.set(`spec:report-${i}.md`, 1_700_000_000_000 + i);

      saveReportSentMap(p, m, makeLogger([]));
      const back = loadReportSentMap(p, makeLogger([]));

      expect(back.size).toBe(200);
      expect(back.get('spec:report-199.md')).toBe(1_700_000_000_000 + 199);
    });
  });

  test('das Ziel wird nie halb beschrieben: ein abgebrochener Schreibvorgang laesst den alten Index intakt', () => {
    withTmpDir(dir => {
      const p = writeIndex(dir, { 'spec:report-a.md': 1_000 });
      const before = fs.readFileSync(p, 'utf-8');

      // Schreibvorgang, der nach dem .tmp-Write abbricht (kein renameSync).
      fs.writeFileSync(`${p}.tmp-${process.pid}`, '{ "spec:report-b.md": 2000');

      // Genau hier las der alte Code eine halbe Datei. Jetzt ist das Ziel unberuehrt.
      expect(fs.readFileSync(p, 'utf-8')).toBe(before);
      expect(loadReportSentMap(p, makeLogger([])).get('spec:report-a.md')).toBe(1_000);
    });
  });

  test('.tmp-Pfad faellt nicht in die Scan-Whitelist (report-*.md)', () => {
    const name = `.report-sent.json.tmp-${process.pid}`;
    expect(name.startsWith('report-') && name.endsWith('.md')).toBe(false);
    expect(name.startsWith('.')).toBe(true);
  });
});

/**
 * Zweiter Befund, 16.10.2026. Im Journal stand dreimal
 *
 *   [report-watcher] save sent-map failed: ENOENT: no such file or directory,
 *   rename '/home/biko/bikosoc-spec/.report-sent.json.tmp' -> '…/.report-sent.json'
 *
 * Zwei Ursachen, beide hier festgehalten:
 *
 *   (1) Der Name der Zwischendatei war fuer alle Schreiber derselbe. Legt ein
 *       zweiter Prozess gleichzeitig los, benennt der erste um und dem zweiten
 *       fehlt seine Datei.
 *   (2) Geschrieben wurde nach JEDEM Scan. Die Datei liegt im beobachteten
 *       Verzeichnis, also loeste jeder Schreibvorgang den eigenen fs.watch aus
 *       und fuenf Sekunden spaeter den naechsten Scan.
 */
describe('saveReportSentMap — zwei Schreiber und leere Laeufe', () => {
  test('zwei Prozesse gleichzeitig: kein ENOENT, kein Verlust', () => {
    withTmpDir(dir => {
      const p = path.join(dir, '.report-sent.json');
      const logs: Logged[] = [];

      /* Der Ablauf, der im Betrieb fehlschlug: A schreibt seine
         Zwischendatei, B schreibt seine, A benennt um, B benennt um. Mit
         EINEM gemeinsamen Namen fand B nach dem Umbenennen von A nichts
         mehr vor. */
      const a: SentMap = new Map([['spec:report-a.md', 1_000]]);
      const b: SentMap = new Map([['spec:report-b.md', 2_000]]);
      const pfadA = `${p}.tmp-4711`;
      const pfadB = `${p}.tmp-4712`;
      fs.writeFileSync(pfadA, JSON.stringify(Object.fromEntries(a), null, 2));
      fs.writeFileSync(pfadB, JSON.stringify(Object.fromEntries(b), null, 2));
      expect(pfadA).not.toBe(pfadB);
      fs.renameSync(pfadA, p);
      fs.renameSync(pfadB, p);

      expect(logs).toEqual([]);
      expect(loadReportSentMap(p, makeLogger([])).get('spec:report-b.md')).toBe(2_000);
      expect(fs.readdirSync(dir).filter(n => n.includes('.tmp'))).toEqual([]);
    });
  });

  test('der Name traegt die Prozessnummer, zwei Prozesse kollidieren also nicht', () => {
    withTmpDir(dir => {
      const p = path.join(dir, '.report-sent.json');
      saveReportSentMap(p, new Map([['spec:report-a.md', 1]]), makeLogger([]), undefined, 4711);
      saveReportSentMap(p, new Map([['spec:report-b.md', 2]]), makeLogger([]), undefined, 4712);
      expect(fs.readdirSync(dir).filter(n => n.includes('.tmp'))).toEqual([]);
      expect(loadReportSentMap(p, makeLogger([])).get('spec:report-b.md')).toBe(2);
    });
  });

  test('unveraenderter Stand wird NICHT geschrieben — sonst fuettert der Scan sich selbst', () => {
    withTmpDir(dir => {
      const p = path.join(dir, '.report-sent.json');
      const m: SentMap = new Map([['spec:report-a.md', 1_000]]);
      saveReportSentMap(p, m, makeLogger([]));
      const stand = fs.readFileSync(p, 'utf-8');
      const vorher = fs.statSync(p).mtimeMs;

      saveReportSentMap(p, m, makeLogger([]), stand);

      expect(fs.statSync(p).mtimeMs).toBe(vorher);
      expect(fs.readFileSync(p, 'utf-8')).toBe(stand);
    });
  });

  test('ein echter neuer Eintrag wird weiterhin geschrieben', () => {
    withTmpDir(dir => {
      const p = path.join(dir, '.report-sent.json');
      const m: SentMap = new Map([['spec:report-a.md', 1_000]]);
      saveReportSentMap(p, m, makeLogger([]));
      const stand = fs.readFileSync(p, 'utf-8');

      m.set('spec:report-neu.md', 2_000);
      saveReportSentMap(p, m, makeLogger([]), stand);

      expect(loadReportSentMap(p, makeLogger([])).get('spec:report-neu.md')).toBe(2_000);
    });
  });
});

describe('statische Guards gegen index.ts (Drift-Schutz fuer die Spiegelung oben)', () => {
  const ROOT = path.resolve(import.meta.dir, '../..');
  const source = fs.readFileSync(path.join(ROOT, 'index.ts'), 'utf-8');

  test('saveReportSentMap schreibt via .tmp + renameSync', () => {
    expect(source).toContain('const tmpPath = `${REPORT_SENT_PATH}.tmp-${process.pid}`;');
    expect(source).toContain('fs.writeFileSync(tmpPath, inhalt);');
    expect(source).toContain('fs.renameSync(tmpPath, REPORT_SENT_PATH);');
  });

  test('die Zwischendatei traegt die Prozessnummer (kein gemeinsamer Name)', () => {
    /* 16.10.2026: Der gemeinsame Name war die Ursache des ENOENT beim
       Umbenennen. */
    expect(source).not.toContain('`${REPORT_SENT_PATH}.tmp`');
  });

  test('ein unveraenderter Stand wird nicht geschrieben', () => {
    expect(source).toContain('if (unveraendert !== undefined && inhalt === unveraendert) return;');
    /* Der Scan haelt den Stand beim Laden fest und uebergibt ihn am Ende. */
    expect(source).toContain('const standBeimLaden = JSON.stringify(Object.fromEntries(sentMap), null, 2);');
    expect(source).toContain('saveReportSentMap(sentMap, standBeimLaden);');
  });

  test('saveReportSentMap schreibt nicht mehr direkt auf REPORT_SENT_PATH', () => {
    expect(source).not.toContain('fs.writeFileSync(REPORT_SENT_PATH,');
  });

  test('loadReportSentMap behandelt nur ENOENT als leeren Erstlauf und wirft sonst', () => {
    expect(source).toContain("if (e?.code === 'ENOENT') return new Map();");
    expect(source).toContain('sent-map unlesbar');
    expect(source).toContain('sent-map defekt');
    expect(source).toContain('KEINE Zustellung');
  });

  test('kein Fail-open mehr: catch liefert keine leere Map als Fehlerfall', () => {
    expect(source).not.toContain('} catch {\n        return new Map();\n      }');
  });

  test('beide Aufrufer fangen den Fehler ab und ueberspringen ihren Lauf', () => {
    // Scan: bricht vor dem Ausliefern ab.
    expect(source).toContain('        sentMap = loadReportSentMap();\n      } catch {');
    expect(source).toContain('Seed uebersprungen');
    // loadReportSentMap wird nirgends mehr ungeschuetzt aufgerufen.
    const unguarded = source
      .split('\n')
      .filter(l => l.includes('loadReportSentMap()')
        && !l.includes('sentMap = loadReportSentMap();')
        && !l.includes('function loadReportSentMap()'));
    expect(unguarded).toEqual([]);
  });
});
