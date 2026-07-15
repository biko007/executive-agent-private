import { describe, expect, test } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dir, '../..');

function read(rel: string): string {
  return fs.readFileSync(path.join(ROOT, rel), 'utf-8');
}

describe('telegram binding static guards', () => {
  test('source owner gates do not depend on the legacy Telegram id', () => {
    const files = [
      'index.ts',
      'src/modules/memory/extract.ts',
      'src/modules/memory/store.ts',
      'scripts/smoke-test.ts',
      'scripts/verify-schema-versions.ts',
      'scripts/openclaw-backup',
      'scripts/instagram-spike-forensic.ts',
    ];

    for (const file of files) {
      expect(read(file), file).not.toContain('133260792');
    }
  });

  test('/ccgo is registered in source command set and handler', () => {
    const source = read('index.ts');
    expect(source).toContain("'ccgo'");
    expect(source).toContain("name: 'ccgo'");
  });

  test('/do is registered and uses the binding owner guard before tmux dispatch', () => {
    const source = read('index.ts');
    expect(source).toContain("'do'");
    expect(source).toContain("name: 'do'");
    expect(source).toContain('const guard = await assertBoundOwner(ctx);');
    expect(source).toContain('sendPromptToBikosocTmux(prompt);');
  });

  test('plans watcher accepts arbitrary markdown slugs without prefix filter', () => {
    const source = read('index.ts');
    expect(source).toContain('REPORT_PLANS_DIR');
    expect(source).toContain('plan:${name}');
    expect(source).toContain("if (!name.endsWith('.md') || name.startsWith('.')) continue;");
    expect(source).not.toContain("name.startsWith('report-plan-')");
    expect(source).not.toContain("name.startsWith('plan-')");
  });

  test('memdrop callback fails closed without explicit chat id', () => {
    const source = read('index.ts');
    expect(source).toContain('const chatId = memdropCb.chatId;');
    expect(source).toContain('const senderId = memdropCb.senderId;');
    expect(source).toContain('if (!chatId || !senderId)');
    expect(source).toContain('const guard = await assertBoundOwner({ chatId, senderId });');
    expect(source).not.toContain('assertBoundOwner({ metadata: { senderId: chatId }, senderId: chatId })');
  });
});
