#!/usr/bin/env bun
/**
 * verify-commands.ts — CI guard for Telegram command registration.
 *
 * Extracts all api.registerCommand({ name: '...' }) handlers from source files
 * and cross-checks bidirectionally against the REGISTERED_COMMANDS set in index.ts.
 *
 * Direction A: Handler registered but NOT in REGISTERED_COMMANDS → AI agent
 *   will respond to the command instead of staying silent.
 * Direction B: Entry in REGISTERED_COMMANDS but NO handler found → dead entry,
 *   user gets NO_REPLY with no handler to respond.
 *
 * Exit 0 = clean, Exit 1 = findings.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

const ROOT = path.resolve(import.meta.dir, '..');

// ── 1. Extract REGISTERED_COMMANDS from index.ts ────────────────────────────

function extractRegisteredCommands(): Set<string> {
  const indexSrc = fs.readFileSync(path.join(ROOT, 'index.ts'), 'utf-8');

  // Match the full REGISTERED_COMMANDS = new Set([ ... ]) block
  const match = indexSrc.match(
    /REGISTERED_COMMANDS\s*=\s*new\s+Set\(\[\s*([\s\S]*?)\]\)/,
  );
  if (!match) {
    console.error('ERROR: Could not find REGISTERED_COMMANDS set in index.ts');
    process.exit(2);
  }

  const body = match[1];
  const names = new Set<string>();
  for (const m of body.matchAll(/'([a-zA-Z0-9_]+)'/g)) {
    names.add(m[1].toLowerCase());
  }
  return names;
}

// ── 2. Extract all registerCommand name values from source ──────────────────

interface HandlerEntry {
  name: string;
  file: string;   // relative to ROOT
  line: number;
}

function extractHandlers(): HandlerEntry[] {
  const entries: HandlerEntry[] = [];

  // Source files to scan (all .ts in src/modules/*/commands.ts + index.ts)
  const candidates = [
    'index.ts',
    ...findCommandFiles(path.join(ROOT, 'src')),
  ];

  for (const relPath of candidates) {
    const absPath = path.isAbsolute(relPath) ? relPath : path.join(ROOT, relPath);
    if (!fs.existsSync(absPath)) continue;

    const src = fs.readFileSync(absPath, 'utf-8');
    const lines = src.split('\n');
    const rel = path.relative(ROOT, absPath);

    for (let i = 0; i < lines.length; i++) {
      if (!lines[i].includes('registerCommand(')) continue;

      // Look at current line and up to 3 following lines for name: '...'
      const window = lines.slice(i, i + 4).join('\n');
      const nameMatch = window.match(/name:\s*['"]([a-zA-Z0-9_]+)['"]/);
      if (nameMatch) {
        // Find the actual line number of the name: property
        for (let j = i; j < Math.min(i + 4, lines.length); j++) {
          if (lines[j].includes(`name:`) && lines[j].includes(nameMatch[1])) {
            entries.push({ name: nameMatch[1].toLowerCase(), file: rel, line: j + 1 });
            break;
          }
        }
      }
    }
  }

  return entries;
}

function findCommandFiles(dir: string): string[] {
  const results: string[] = [];
  if (!fs.existsSync(dir)) return results;

  const walk = (d: string) => {
    for (const entry of fs.readdirSync(d, { withFileTypes: true })) {
      if (entry.name.startsWith('.')) continue;
      if (entry.name.includes('.bak') || entry.name.includes('.work') || entry.name.includes('.repair')) continue;
      const full = path.join(d, entry.name);
      if (entry.isDirectory()) {
        // Skip __tests__, node_modules, dist, archive
        if (['__tests__', 'node_modules', 'dist', 'archive', 'migrations'].includes(entry.name)) continue;
        walk(full);
      } else if (entry.name === 'commands.ts') {
        results.push(full);
      }
    }
  };
  walk(dir);
  return results;
}

// ── 3. Cross-check ──────────────────────────────────────────────────────────

function run(): void {
  const registered = extractRegisteredCommands();
  const handlers = extractHandlers();

  // Deduplicate handler names (fleetlink appears in both fleet and sharepoint)
  const handlerNames = new Set(handlers.map(h => h.name));

  // Direction A: handler exists but NOT in REGISTERED_COMMANDS
  const directionA: HandlerEntry[] = [];
  for (const h of handlers) {
    if (!registered.has(h.name)) {
      directionA.push(h);
    }
  }

  // Direction B: REGISTERED_COMMANDS entry but NO handler
  const directionB: string[] = [];
  for (const cmd of registered) {
    if (!handlerNames.has(cmd)) {
      directionB.push(cmd);
    }
  }

  // ── Output ──

  console.log('');
  console.log('🔍 Command Registration Guard');
  console.log('═'.repeat(72));
  console.log(`   Handlers found:              ${handlers.length}`);
  console.log(`   Unique handler names:         ${handlerNames.size}`);
  console.log(`   REGISTERED_COMMANDS entries:   ${registered.size}`);
  console.log('');

  if (directionA.length === 0 && directionB.length === 0) {
    console.log('✅ All commands are bidirectionally consistent.');
    console.log('');
    process.exit(0);
  }

  let findings = 0;

  if (directionA.length > 0) {
    console.log('── Direction A: Handler WITHOUT REGISTERED_COMMANDS entry ──────────');
    console.log('   (AI agent will respond to these commands instead of staying silent)');
    console.log('');
    console.log('   Command             File                                        Line');
    console.log('   ─────────────────── ─────────────────────────────────────────── ────');
    for (const h of directionA) {
      const cmd = h.name.padEnd(20);
      const file = h.file.padEnd(44);
      console.log(`   ${cmd}${file}${h.line}`);
    }
    console.log('');
    findings += directionA.length;
  }

  if (directionB.length > 0) {
    console.log('── Direction B: REGISTERED_COMMANDS entry WITHOUT handler ──────────');
    console.log('   (User gets NO_REPLY with no handler to respond — dead entry)');
    console.log('');
    for (const cmd of directionB.sort()) {
      console.log(`   ${cmd}`);
    }
    console.log('');
    findings += directionB.length;
  }

  console.log(`❌ ${findings} finding(s). Fix before commit.`);
  console.log('');
  process.exit(1);
}

run();
