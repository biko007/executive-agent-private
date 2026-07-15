import { execFileSync } from 'node:child_process';

export type TmuxRunner = (file: string, args: string[], options?: { timeout?: number }) => void;

const DEFAULT_TMUX_TARGET = 'bikosoc';

function defaultRunner(file: string, args: string[], options?: { timeout?: number }): void {
  execFileSync(file, args, {
    stdio: 'ignore',
    timeout: options?.timeout,
  });
}

export function sendPromptToBikosocTmux(
  text: string,
  opts: { runner?: TmuxRunner; target?: string; timeoutMs?: number } = {},
): void {
  if (!text.trim()) {
    throw new Error('Prompt ist leer.');
  }

  const runner = opts.runner ?? defaultRunner;
  const target = opts.target ?? DEFAULT_TMUX_TARGET;
  const timeout = opts.timeoutMs ?? 5000;
  runner('tmux', ['send-keys', '-t', target, '--', text, 'Enter'], { timeout });
}
