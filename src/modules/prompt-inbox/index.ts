import fs from 'node:fs';
import path from 'node:path';
import { sendPromptToBikosocTmux, type TmuxRunner } from '../cc-prompt-dispatch/index.js';

export interface PromptInboxResult {
  sourcePath: string;
  donePath: string;
  reportPath: string;
}

export function sanitizeDoneName(name: string): string {
  return name.replace(/[^a-zA-Z0-9._-]/g, '_');
}

function formatBerlinDate(date: Date): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Europe/Berlin',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(date);
}

function formatReportTimestamp(date: Date): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Europe/Berlin',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  }).formatToParts(date);
  const value = (type: string) => parts.find((part) => part.type === type)?.value ?? '00';
  return `${value('year')}${value('month')}${value('day')}-${value('hour')}${value('minute')}${value('second')}`;
}

export function processPromptInboxOnce(opts: {
  homeDir: string;
  inboxDir?: string;
  reportDir?: string;
  now?: Date;
  runner?: TmuxRunner;
}): PromptInboxResult[] {
  const homeDir = opts.homeDir;
  const inboxDir = opts.inboxDir ?? path.join(homeDir, 'inbox');
  const doneDir = path.join(inboxDir, 'done');
  const reportDir = opts.reportDir ?? path.join(homeDir, 'bikosoc-spec');
  const now = opts.now ?? new Date();

  fs.mkdirSync(inboxDir, { recursive: true });
  fs.mkdirSync(doneDir, { recursive: true });
  fs.mkdirSync(reportDir, { recursive: true });

  const names = fs.readdirSync(inboxDir)
    .filter((name) => name.endsWith('.txt') && !name.startsWith('.'))
    .sort();

  const results: PromptInboxResult[] = [];
  for (const name of names) {
    const sourcePath = path.join(inboxDir, name);
    const st = fs.statSync(sourcePath);
    if (!st.isFile()) continue;

    const text = fs.readFileSync(sourcePath, 'utf-8');
    sendPromptToBikosocTmux(text, { runner: opts.runner });

    const stamp = now.toISOString().replace(/[:.]/g, '-');
    const donePath = path.join(doneDir, `${stamp}-${sanitizeDoneName(name)}`);
    fs.renameSync(sourcePath, donePath);

    const reportDate = formatBerlinDate(now);
    const reportStamp = formatReportTimestamp(now);
    const reportPath = path.join(reportDir, `report-prompt-inbox-${reportStamp}.md`);
    const body = [
      `# Prompt-Inbox ${reportDate}`,
      '',
      '## Übergabe',
      '',
      `- Datei: ${name}`,
      `- Verschoben nach: ${donePath}`,
      '- Status: Prompt uebergeben.',
      '',
      '## Nutzung',
      '',
      '- Telegram: `/do <text>`',
      '- Datei-Drop: `.txt` nach `~/inbox/` legen; Verarbeitung per systemd-user-Timer.',
      '',
    ].join('\n');
    fs.writeFileSync(reportPath, body);

    results.push({ sourcePath, donePath, reportPath });
  }

  return results;
}
