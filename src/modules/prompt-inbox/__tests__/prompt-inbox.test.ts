import { afterEach, describe, expect, test } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { processPromptInboxOnce } from '../index.js';
import type { TmuxRunner } from '../../cc-prompt-dispatch/index.js';

const tmpRoots: string[] = [];

afterEach(() => {
  for (const root of tmpRoots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

describe('prompt inbox', () => {
  test('dispatches txt file to tmux, moves it to done, and writes watcher report', () => {
    const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'prompt-inbox-'));
    tmpRoots.push(homeDir);
    const inboxDir = path.join(homeDir, 'inbox');
    fs.mkdirSync(inboxDir, { recursive: true });
    fs.writeFileSync(path.join(inboxDir, 'auftrag eins.txt'), 'Bitte Status pruefen.');

    const calls: Array<{ file: string; args: string[] }> = [];
    const runner: TmuxRunner = (file, args) => {
      calls.push({ file, args });
    };

    const results = processPromptInboxOnce({
      homeDir,
      now: new Date('2026-07-15T08:00:00.000Z'),
      runner,
    });

    expect(calls).toEqual([
      {
        file: 'tmux',
        args: ['send-keys', '-t', 'bikosoc', '--', 'Bitte Status pruefen.', 'Enter'],
      },
    ]);
    expect(results).toHaveLength(1);
    expect(fs.existsSync(path.join(inboxDir, 'auftrag eins.txt'))).toBe(false);
    expect(results[0].donePath).toContain('/inbox/done/2026-07-15T08-00-00-000Z-auftrag_eins.txt');
    expect(fs.existsSync(results[0].donePath)).toBe(true);
    expect(path.basename(results[0].reportPath)).toBe('report-prompt-inbox-20260715-100000.md');
    expect(fs.readFileSync(results[0].reportPath, 'utf-8')).toContain('Prompt uebergeben.');
  });
});
