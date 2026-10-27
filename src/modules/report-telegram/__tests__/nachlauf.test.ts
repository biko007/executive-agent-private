/**
 * Nachlauf des Report-Watchers (Owner-Freigabe 27.10.2026, Kontrollfläche C7).
 *
 * Geprüft wird zweierlei: der Planer selbst (ein Timer, nie zwei; Wartezeit
 * eingehalten) und eine Nachbildung der Watcher-Schleife mit falscher Uhr —
 * kein Doppelversand, Reihenfolge bleibt, das Rate-Limit bleibt wirksam. Eine
 * statische Prüfung hält fest, dass index.ts den Nachlauf genau so benutzt.
 */
import { describe, test, expect } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import { erzeugeNachlauf } from '../index.js';

/** Falsche Uhr mit Timern, die nur beim Vorspulen feuern. */
function uhr() {
  let t = 0;
  let id = 0;
  const timer = new Map<number, { at: number; f: () => void }>();
  return {
    jetzt: () => t,
    setze: (f: () => void, ms: number) => { const h = ++id; timer.set(h, { at: t + ms, f }); return h; },
    loesche: (h: unknown) => { timer.delete(h as number); },
    offen: () => timer.size,
    async vor(ms: number) {
      const ende = t + ms;
      for (;;) {
        const naechster = [...timer.entries()].sort((a, b) => a[1].at - b[1].at)[0];
        if (!naechster || naechster[1].at > ende) break;
        t = naechster[1].at;
        timer.delete(naechster[0]);
        naechster[1].f();
        await new Promise((r) => setTimeout(r, 0));
        await new Promise((r) => setTimeout(r, 0));
      }
      t = ende;
    },
  };
}

describe('Planer', () => {
  test('plant genau einen Scan nach Wartezeit plus Puffer', async () => {
    const u = uhr();
    let scans = 0;
    const n = erzeugeNachlauf({ scan: () => { scans++; }, jetzt: u.jetzt, setzeTimer: u.setze, loescheTimer: u.loesche, pufferMs: 2000 });
    expect(n.plane(30_000)).toBe(true);
    await u.vor(31_999);
    expect(scans).toBe(0);
    await u.vor(1);
    expect(scans).toBe(1);
    expect(n.geplant()).toBe(false);
  });

  test('nie zwei Timer: ein späterer Wunsch ändert nichts, ein früherer ersetzt', async () => {
    const u = uhr();
    let scans = 0;
    const n = erzeugeNachlauf({ scan: () => { scans++; }, jetzt: u.jetzt, setzeTimer: u.setze, loescheTimer: u.loesche, pufferMs: 0 });
    n.plane(10_000);
    expect(n.plane(50_000)).toBe(false);
    expect(u.offen()).toBe(1);
    expect(n.plane(5_000)).toBe(true);
    expect(u.offen()).toBe(1);
    await u.vor(60_000);
    expect(scans).toBe(1);
  });

  test('stopp verwirft den Timer', async () => {
    const u = uhr();
    let scans = 0;
    const n = erzeugeNachlauf({ scan: () => { scans++; }, jetzt: u.jetzt, setzeTimer: u.setze, loescheTimer: u.loesche });
    n.plane(1000);
    n.stopp();
    await u.vor(10_000);
    expect(scans).toBe(0);
  });

  test('ein Fehler im Scan bricht den Planer nicht', async () => {
    const u = uhr();
    let scans = 0;
    const n = erzeugeNachlauf({ scan: async () => { scans++; throw new Error('kaputt'); }, jetzt: u.jetzt, setzeTimer: u.setze, loescheTimer: u.loesche, pufferMs: 0 });
    n.plane(100);
    await u.vor(200);
    expect(n.plane(100)).toBe(true);
    await u.vor(200);
    expect(scans).toBe(2);
  });
});

describe('Nachbildung der Watcher-Schleife', () => {
  /** Dieselbe Logik wie scanAndDeliverReports, auf das Wesentliche reduziert. */
  function watcher(u: ReturnType<typeof uhr>, dateien: Array<{ name: string; mtime: number }>) {
    const RATE = 60_000;
    let letzter = 0;
    const gesendet = new Map<string, number>();
    const log: Array<{ name: string; at: number }> = [];
    let laeuft = false;
    let erneut = false;
    const nachlauf = erzeugeNachlauf({ scan: () => scan(), jetzt: u.jetzt, setzeTimer: u.setze, loescheTimer: u.loesche });
    async function scan(): Promise<void> {
      if (laeuft) { erneut = true; return; }
      laeuft = true;
      erneut = false;
      try {
        const offen = dateien.filter((d) => (gesendet.get(d.name) ?? -1) < d.mtime).sort((a, b) => a.mtime - b.mtime);
        for (const d of offen) {
          if (letzter && u.jetzt() - letzter < RATE) { nachlauf.plane(RATE - (u.jetzt() - letzter)); break; }
          await Promise.resolve();          // Zustellung dauert — wie Telegram/Dropbox
          log.push({ name: d.name, at: u.jetzt() });
          gesendet.set(d.name, d.mtime);
          letzter = u.jetzt();
        }
      } finally {
        laeuft = false;
        if (erneut) { erneut = false; nachlauf.plane(0); }
      }
    }
    return { scan, log, nachlauf };
  }

  test('zwei Reports kurz hintereinander: beide kommen an, der zweite nach der Minute, ohne touch', async () => {
    const u = uhr();
    await u.vor(1000);
    const w = watcher(u, [{ name: 'report-a.md', mtime: 1 }, { name: 'report-b.md', mtime: 2 }]);
    await w.scan();                       // ein einziges Dateiereignis
    expect(w.log.map((l) => l.name)).toEqual(['report-a.md']);
    await u.vor(10 * 60_000);             // kein weiteres Ereignis
    expect(w.log.map((l) => l.name)).toEqual(['report-a.md', 'report-b.md']);
    expect(w.log[1].at - w.log[0].at).toBeGreaterThanOrEqual(60_000);
  });

  test('kein Doppelversand: weitere Ereignisse und der Nachlauf liefern nichts zweimal', async () => {
    const u = uhr();
    await u.vor(1000);
    const w = watcher(u, [{ name: 'a', mtime: 1 }, { name: 'b', mtime: 2 }, { name: 'c', mtime: 3 }]);
    await w.scan(); await w.scan(); await w.scan();
    await u.vor(30_000); await w.scan();
    await u.vor(10 * 60_000);
    expect(w.log.map((l) => l.name)).toEqual(['a', 'b', 'c']);
  });

  test('Reihenfolge bleibt chronologisch und das Rate-Limit wirkt zwischen allen', async () => {
    const u = uhr();
    await u.vor(1000);
    const w = watcher(u, [{ name: 'spaet', mtime: 30 }, { name: 'frueh', mtime: 10 }, { name: 'mitte', mtime: 20 }]);
    await w.scan();
    await u.vor(10 * 60_000);
    expect(w.log.map((l) => l.name)).toEqual(['frueh', 'mitte', 'spaet']);
    for (let i = 1; i < w.log.length; i++) expect(w.log[i].at - w.log[i - 1].at).toBeGreaterThanOrEqual(60_000);
  });

  test('Auslöser während eines laufenden Scans geht nicht verloren', async () => {
    const u = uhr();
    await u.vor(1000);
    const w = watcher(u, [{ name: 'a', mtime: 1 }]);
    const erster = w.scan();
    await w.scan();                       // trifft auf den laufenden Scan
    await erster;
    expect(w.nachlauf.geplant()).toBe(true);
  });
});

describe('index.ts benutzt den Nachlauf wie geprüft', () => {
  const quelle = fs.readFileSync(path.resolve(import.meta.dir, '..', '..', '..', '..', 'index.ts'), 'utf-8');
  const start = quelle.indexOf('async function scanAndDeliverReports()');
  const ende = quelle.indexOf('// Seed BEFORE starting watchers', start);
  const block = quelle.slice(start, ende);

  test('Rate-Limit-Zweig plant den Rest der Minute und bricht weiter ab', () => {
    const zweig = block.slice(block.indexOf('if (now - reportLastAutoSendAt < REPORT_RATE_MS)'));
    expect(zweig).toContain('const restMs = REPORT_RATE_MS - (now - reportLastAutoSendAt);');
    expect(zweig).toContain('reportNachlauf.plane(restMs)');
    expect(zweig.slice(0, zweig.indexOf('// Inhalt lesen'))).toContain('break;');
  });

  test('Rate-Limit unverändert: 1 Datei je Minute', () => {
    expect(quelle).toContain('const REPORT_RATE_MS = 60_000;');
  });

  test('Doppelschutz unverändert: sentMap vor dem Zeitstempel gesetzt', () => {
    expect(block.indexOf('sentMap.set(file.key, file.mtimeMs);')).toBeGreaterThan(-1);
    expect(block.indexOf('sentMap.set(file.key, file.mtimeMs);')).toBeLessThan(block.indexOf('reportLastAutoSendAt = Date.now();'));
  });

  test('scheitert das Speichern der Versandliste, wird der Nachlauf angehalten (kein Doppelversand)', () => {
    expect(block).toMatch(/if \(!saveReportSentMap\(sentMap, standBeimLaden\)\) \{\s*reportNachlauf\.stopp\(\);\s*reportScanErneut = false;/);
    expect(quelle).toMatch(/function saveReportSentMap\([\s\S]*?\): boolean \{/);
  });

  test('Fehler im Nachlauf-Scan werden protokolliert', () => {
    expect(quelle).toContain("scan: () => scanAndDeliverReports().catch((e: any) =>");
  });

  test('laufender Scan: Auslöser wird vermerkt und im finally nachgeholt', () => {
    expect(block).toContain('if (reportScanInProgress) { reportScanErneut = true; return; }');
    expect(block).toMatch(/finally \{\s*reportScanInProgress = false;\s*if \(reportScanErneut\) \{\s*reportScanErneut = false;\s*reportNachlauf\.plane\(0\);/);
  });
});
