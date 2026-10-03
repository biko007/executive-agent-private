import { describe, expect, test } from 'bun:test';
import { sendPromptToBikosocTmux, type TmuxRunner } from '../index.js';

describe('cc prompt dispatch', () => {
  test('sends prompt to tmux bikosoc without shell interpolation', () => {
    const calls: Array<{ file: string; args: string[] }> = [];
    const runner: TmuxRunner = (file, args) => {
      calls.push({ file, args });
    };

    sendPromptToBikosocTmux('echo "hi"; $(touch nope)', { runner, enterDelayMs: 0 });

    // Zwei getrennte Aufrufe: Text, dann Enter. Begruendung siehe
    // cc-prompt-dispatch/index.ts — ein gemeinsamer Aufruf kommt bei der
    // Oberflaeche als Einfuegevorgang an und schickt nicht ab.
    expect(calls).toEqual([
      {
        file: 'tmux',
        args: ['send-keys', '-t', 'bikosoc', '--', 'echo "hi"; $(touch nope)'],
      },
      {
        file: 'tmux',
        args: ['send-keys', '-t', 'bikosoc', 'Enter'],
      },
    ]);
  });

  test('Enter ist ein EIGENER Aufruf — der Defekt vom 2026-10-03', () => {
    // Regressionstest. Bis 2026-10-03 steckten Text und Enter in einem
    // send-keys-Aufruf; Datei-Drops und /do trugen den Auftrag ins Eingabefeld
    // ein, schickten ihn aber nicht ab. Dieser Test wird rot, sobald der
    // Zweischritt wieder zu einem Aufruf zusammengelegt wird.
    const calls: Array<{ file: string; args: string[] }> = [];
    const runner: TmuxRunner = (file, args) => { calls.push({ file, args }); };

    sendPromptToBikosocTmux('Auftragstext', { runner, enterDelayMs: 0 });

    expect(calls).toHaveLength(2);
    // Der erste Aufruf traegt den Text und KEIN Enter.
    expect(calls[0].args).not.toContain('Enter');
    expect(calls[0].args.at(-1)).toBe('Auftragstext');
    // Der zweite Aufruf traegt NUR das Enter und keinen Text.
    expect(calls[1].args).toEqual(['send-keys', '-t', 'bikosoc', 'Enter']);
  });

  test('der --Trenner steht vor dem Text, auch wenn er mit - beginnt', () => {
    // Injektionsschutz: ohne `--` wuerde tmux "-x" als Option deuten.
    const calls: Array<{ file: string; args: string[] }> = [];
    const runner: TmuxRunner = (file, args) => { calls.push({ file, args }); };

    sendPromptToBikosocTmux('-X boeser Schalter', { runner, enterDelayMs: 0 });

    expect(calls[0].args).toEqual([
      'send-keys', '-t', 'bikosoc', '--', '-X boeser Schalter',
    ]);
  });

  test('eigenes Ziel wird in beiden Aufrufen verwendet', () => {
    const calls: Array<{ file: string; args: string[] }> = [];
    const runner: TmuxRunner = (file, args) => { calls.push({ file, args }); };

    sendPromptToBikosocTmux('x', { runner, target: 'andere', enterDelayMs: 0 });

    expect(calls[0].args).toContain('andere');
    expect(calls[1].args).toContain('andere');
    expect(calls.every((c) => !c.args.includes('bikosoc'))).toBe(true);
  });

  test('fails on empty prompt before calling tmux', () => {
    const calls: Array<{ file: string; args: string[] }> = [];
    const runner: TmuxRunner = (file, args) => {
      calls.push({ file, args });
    };

    expect(() => sendPromptToBikosocTmux('   ', { runner })).toThrow('Prompt ist leer.');
    expect(calls).toEqual([]);
  });
});
