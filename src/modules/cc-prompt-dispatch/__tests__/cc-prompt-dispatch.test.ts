import { describe, expect, test } from 'bun:test';
import { sendPromptToBikosocTmux, type TmuxRunner } from '../index.js';

describe('cc prompt dispatch', () => {
  test('sends prompt to tmux bikosoc without shell interpolation', () => {
    const calls: Array<{ file: string; args: string[] }> = [];
    const runner: TmuxRunner = (file, args) => {
      calls.push({ file, args });
    };

    sendPromptToBikosocTmux('echo "hi"; $(touch nope)', { runner });

    expect(calls).toEqual([
      {
        file: 'tmux',
        args: ['send-keys', '-t', 'bikosoc', '--', 'echo "hi"; $(touch nope)', 'Enter'],
      },
    ]);
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
