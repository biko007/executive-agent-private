/**
 * Non-Owner-Negativtests für die Kontrollfläche Prompt-Übergabe (C7).
 *
 * C7 verlangt für jede Änderung an `/do`, der Prompt-Inbox und verwandten
 * Kontrollflächen Negativtests gegen Missbrauchsfälle. Der Fix vom 2026-10-03
 * (Enter als eigener Tastendruck) ändert genau diese Fläche, deshalb sind die
 * Zusicherungen hier festgeschrieben.
 *
 * Geprüft wird in zwei Ebenen:
 *  1. Verhalten des Dispatch-Helfers selbst (Injektionsschutz, Parallelität).
 *  2. Statische Guards gegen `index.ts` — das Owner-Gate muss VOR jeder Wirkung
 *     stehen, und der Helfer darf nicht umgangen oder nachgebaut werden.
 */
import { describe, expect, test } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import { sendPromptToBikosocTmux, type TmuxRunner } from '../index.js';

const ROOT = path.resolve(import.meta.dir, '../../../..');
const quelle = fs.readFileSync(path.join(ROOT, 'index.ts'), 'utf-8');

function sammle(): { calls: Array<{ file: string; args: string[] }>; runner: TmuxRunner } {
  const calls: Array<{ file: string; args: string[] }> = [];
  const runner: TmuxRunner = (file, args) => { calls.push({ file, args }); };
  return { calls, runner };
}

describe('Injektionsschutz des Dispatch-Helfers', () => {
  test('kein Shell-Aufruf: Argumente gehen als argv, nie als Kommandozeile', () => {
    const { calls, runner } = sammle();
    sendPromptToBikosocTmux('x; rm -rf /tmp/beweis; echo $(whoami)', { runner, enterDelayMs: 0 });
    // Der gefährliche Text steht als EIN Argument da, nicht als Shell-Zeile.
    expect(calls[0].args.at(-1)).toBe('x; rm -rf /tmp/beweis; echo $(whoami)');
    expect(calls[0].file).toBe('tmux');
  });

  test('Backticks und Dollar-Klammern bleiben unausgewertet', () => {
    const { calls, runner } = sammle();
    const boese = '`touch /tmp/nope` und $(touch /tmp/nope2)';
    sendPromptToBikosocTmux(boese, { runner, enterDelayMs: 0 });
    expect(calls[0].args.at(-1)).toBe(boese);
  });

  test('ein Text, der mit - beginnt, wird nicht als tmux-Option gelesen', () => {
    const { calls, runner } = sammle();
    sendPromptToBikosocTmux('-X -t andere-sitzung', { runner, enterDelayMs: 0 });
    const args = calls[0].args;
    // Der --Trenner steht unmittelbar vor dem Text.
    expect(args[args.length - 2]).toBe('--');
    expect(args.at(-1)).toBe('-X -t andere-sitzung');
  });

  test('ein Text, der wie eine Taste aussieht, landet trotzdem als Text', () => {
    // Ohne den --Trenner würde tmux "Enter" als Tastennamen deuten und den
    // Prompt abschicken, ohne ihn eingetragen zu haben.
    const { calls, runner } = sammle();
    sendPromptToBikosocTmux('Enter', { runner, enterDelayMs: 0 });
    expect(calls[0].args).toEqual(['send-keys', '-t', 'bikosoc', '--', 'Enter']);
    expect(calls[1].args).toEqual(['send-keys', '-t', 'bikosoc', 'Enter']);
  });

  test('mehrzeiliger Text bleibt ein einziges Argument', () => {
    const { calls, runner } = sammle();
    sendPromptToBikosocTmux('Zeile eins\nZeile zwei', { runner, enterDelayMs: 0 });
    expect(calls[0].args.at(-1)).toBe('Zeile eins\nZeile zwei');
    expect(calls).toHaveLength(2);
  });

  test('leerer und nur-Leerraum-Prompt erreicht tmux nie', () => {
    for (const leer of ['', '   ', '\n', '\t\t']) {
      const { calls, runner } = sammle();
      expect(() => sendPromptToBikosocTmux(leer, { runner, enterDelayMs: 0 }))
        .toThrow('Prompt ist leer.');
      expect(calls).toEqual([]);
    }
  });

  test('das Enter wird nie ohne vorherigen Text gesendet', () => {
    // Sonst bestätigte ein leerer Aufruf, was gerade im Eingabefeld steht.
    const { calls, runner } = sammle();
    try { sendPromptToBikosocTmux('  ', { runner, enterDelayMs: 0 }); } catch { /* erwartet */ }
    expect(calls.some((c) => c.args.includes('Enter'))).toBe(false);
  });
});

describe('statische Guards: Owner-Gate und Helfernutzung in index.ts', () => {
  const doBlock = quelle.slice(
    quelle.indexOf("    name: 'do',"),
    quelle.indexOf("    name: 'do',") + 1400,
  );

  test('/do prüft den Owner VOR der Übergabe', () => {
    const gate = doBlock.indexOf('assertBoundOwner');
    const dispatch = doBlock.indexOf('sendPromptToBikosocTmux');
    expect(gate).toBeGreaterThanOrEqual(0);
    expect(dispatch).toBeGreaterThanOrEqual(0);
    expect(gate).toBeLessThan(dispatch);
  });

  test('/do bricht bei fremdem Sender ab, ohne zu übergeben', () => {
    expect(doBlock).toContain('if (!guard.ok)');
    expect(doBlock).toContain('Dieser Befehl ist nur fuer den Owner verfuegbar.');
    const abbruch = doBlock.indexOf('nur fuer den Owner');
    expect(abbruch).toBeLessThan(doBlock.indexOf('sendPromptToBikosocTmux'));
  });

  test('der Dispatch-Helfer wird importiert, nicht nachgebaut', () => {
    expect(quelle).toContain(
      "import { sendPromptToBikosocTmux } from './src/modules/cc-prompt-dispatch/index.js';",
    );
  });

  test('index.ts baut keinen eigenen send-keys-Aufruf für Prompts', () => {
    // Zulässig bleiben die beiden Sonderpfade C-c (Kill-Switch) und die
    // Bypass-Option — beide senden Tasten, keine Prompttexte. Ein weiterer
    // send-keys mit `--` wäre ein Nachbau des Helfers und damit ein Weg um
    // dessen Prüfungen herum.
    const eigene = [...quelle.matchAll(/send-keys[^\n]*--/g)];
    expect(eigene).toHaveLength(0);
  });

  test('der Zweischritt-Pfad der Bypass-Option bleibt erhalten', () => {
    // Belegt, dass das Muster „Taste, Pause, Enter" im Bestand bereits
    // etabliert war — die Prompt-Übergabe hatte es nur nicht übernommen.
    expect(quelle).toContain('tmux send-keys -t bikosoc ${bypassOptionNum}');
    expect(quelle).toContain('sleep 0.3 && tmux send-keys -t bikosoc Enter');
  });
});

describe('statische Guards: Prompt-Inbox', () => {
  const inboxQuelle = fs.readFileSync(
    path.join(ROOT, 'src/modules/prompt-inbox/index.ts'), 'utf-8',
  );

  test('die Inbox nutzt denselben Helfer wie /do', () => {
    expect(inboxQuelle).toContain(
      "import { sendPromptToBikosocTmux, type TmuxRunner } from '../cc-prompt-dispatch/index.js';",
    );
  });

  test('die Inbox baut keinen eigenen tmux-Aufruf', () => {
    expect(inboxQuelle).not.toContain('send-keys');
    expect(inboxQuelle).not.toContain('execFileSync');
    expect(inboxQuelle).not.toContain('execSync');
  });

  test('nur .txt-Dateien werden verarbeitet, keine versteckten', () => {
    expect(inboxQuelle).toContain(".endsWith('.txt')");
    expect(inboxQuelle).toContain("!name.startsWith('.')");
  });

  test('der Dateiname wird für das Ablegen bereinigt', () => {
    // Verhindert, dass ein Dateiname wie ../../etc/x.txt aus done/ ausbricht.
    expect(inboxQuelle).toContain('sanitizeDoneName');
    expect(inboxQuelle).toContain("replace(/[^a-zA-Z0-9._-]/g, '_')");
  });
});
