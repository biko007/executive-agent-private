/**
 * cue-delegation — /cue_setup: Key-Pruefung, Hans-Auflösung, Zweitform,
 * Key-Redaktion.
 *
 * HTTP ist vollstaendig gemockt, geschrieben wird nur in eine Temp-Datei —
 * nie in die echte ~/.config/openclaw/env und nie gegen die echte API.
 */
import { describe, test, expect, afterEach } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  runCueSetup, validateApiKey, resolveHansAgent, formatAgentList, shortAgentRef,
} from '../setup.js';
import { ManusError } from '../manus-client.js';
import type { ManusAgent, ManusClient } from '../manus-client.js';
import { parseEnvFile } from '../config.js';

const KEY = 'sk-manus-geheim-0123456789';

const FIXTURE = [
  'OPENAI_API_KEY=sk-fremd-nicht-anfassen',
  'CUE_DELEGATION_ENABLED=false',
  'MANUS_API_KEY=CHANGEME',
  'MANUS_CUE_AGENT_ID=CHANGEME',
  '',
].join('\n');

const verzeichnisse: string[] = [];

function tempEnv(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cue-setup-'));
  const p = path.join(dir, 'env');
  fs.writeFileSync(p, FIXTURE, { mode: 0o600 });
  verzeichnisse.push(dir);
  return p;
}

afterEach(() => {
  while (verzeichnisse.length) {
    fs.rmSync(verzeichnisse.pop()!, { recursive: true, force: true });
  }
});

function agent(id: string, nickname?: string): ManusAgent {
  return { id, task_id: `task-${id}`, nickname };
}

/** Client-Attrappe; `uebergabe` haelt fest, mit welchem Key gearbeitet wurde. */
function fakeClient(opts: {
  agents?: ManusAgent[];
  listError?: Error;
  detailError?: Error;
  uebergabe?: { key?: string };
}) {
  return (key: string): ManusClient => {
    if (opts.uebergabe) opts.uebergabe.key = key;
    return {
      listAgents: async () => {
        if (opts.listError) throw opts.listError;
        return opts.agents ?? [];
      },
      getAgent: async (id) => {
        if (opts.detailError) throw opts.detailError;
        const gefunden = (opts.agents ?? []).find((a) => a.id === id);
        if (!gefunden) throw new ManusError('not_found', `Agent ${id} nicht gefunden`);
        return gefunden;
      },
      getTask: async (taskId) => ({
        id: taskId, status: 'stopped', hasRunningBackgroundJobs: false, taskType: 'standard', title: null,
      }),
      sendMessage: async (taskId) => ({ taskId, requestId: null }),
      listMessages: async (taskId) => ({ taskId, messages: [], hasMore: false, nextCursor: null }),
    };
  };
}

// ── Key-Pruefung ───────────────────────────────────────────────────────────

describe('validateApiKey', () => {
  test('ein plausibler Key wird angenommen und getrimmt', () => {
    const res = validateApiKey(`  ${KEY}  `);
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.key).toBe(KEY);
  });

  test('leer, Leerzeichen, zu kurz, Platzhalter und Steuerzeichen werden abgewiesen', () => {
    for (const schlecht of ['', '   ', 'sk-a b-cdefghijklmnop', 'kurz', 'CHANGEME', '<api-key>', `sk-${'ä'.repeat(20)}`]) {
      expect(validateApiKey(schlecht).ok).toBe(false);
    }
  });
});

// ── Hans-Auflösung ────────────────────────────────────────────────────────

describe('resolveHansAgent', () => {
  test('exakter Nickname-Treffer ist eindeutig', () => {
    const treffer = resolveHansAgent([agent('a1', 'Hans'), agent('a2', 'Greta')]);
    expect(treffer.kind).toBe('unique');
    if (treffer.kind === 'unique') expect(treffer.agent.id).toBe('a1');
  });

  test('Gross-/Kleinschreibung und Leerzeichen spielen keine Rolle', () => {
    const treffer = resolveHansAgent([agent('a1', '  hAnS  ')]);
    expect(treffer.kind).toBe('unique');
  });

  test('ein einziger Teiltreffer gilt ebenfalls als eindeutig', () => {
    const treffer = resolveHansAgent([agent('a1', 'Cue Hans'), agent('a2', 'Greta')]);
    expect(treffer.kind).toBe('unique');
    if (treffer.kind === 'unique') expect(treffer.agent.id).toBe('a1');
  });

  test('zwei exakte Treffer sind mehrdeutig', () => {
    const treffer = resolveHansAgent([agent('a1', 'Hans'), agent('a2', 'hans')]);
    expect(treffer.kind).toBe('ambiguous');
    if (treffer.kind === 'ambiguous') expect(treffer.candidates.length).toBe(2);
  });

  test('zwei Teiltreffer sind mehrdeutig und liefern die ganze Liste', () => {
    const treffer = resolveHansAgent([agent('a1', 'Hans Dampf'), agent('a2', 'Hansi'), agent('a3', 'Greta')]);
    expect(treffer.kind).toBe('ambiguous');
    if (treffer.kind === 'ambiguous') expect(treffer.candidates.map((a) => a.id)).toEqual(['a1', 'a2', 'a3']);
  });

  test('kein Treffer ist mehrdeutig', () => {
    const treffer = resolveHansAgent([agent('a1', 'Greta')]);
    expect(treffer.kind).toBe('ambiguous');
  });

  test('leere Liste ist mehrdeutig', () => {
    expect(resolveHansAgent([]).kind).toBe('ambiguous');
  });

  test('Agenten ohne Namen werden nicht verwechselt', () => {
    const treffer = resolveHansAgent([agent('a1'), agent('a2', 'Hans')]);
    expect(treffer.kind).toBe('unique');
    if (treffer.kind === 'unique') expect(treffer.agent.id).toBe('a2');
  });

  test('formatAgentList und shortAgentRef sind owner-lesbar', () => {
    expect(formatAgentList([agent('a1', 'Hans')])).toContain('a1 — Hans');
    expect(formatAgentList([agent('a1')])).toContain('(ohne Namen)');
    expect(formatAgentList([])).toContain('keine Agenten');
    expect(shortAgentRef('kurz')).toBe('kurz');
    expect(shortAgentRef('abcdefghijklmnopqrst')).toBe('abcdefgh…qrst');
  });
});

// ── Gesamtablauf ──────────────────────────────────────────────────────────

describe('runCueSetup', () => {
  test('Erfolg: beide Schluessel geschrieben, Hauptschalter an, fremde Zeilen unberuehrt', async () => {
    const envPath = tempEnv();
    const uebergabe: { key?: string } = {};
    const angewendet: Record<string, string> = {};

    const res = await runCueSetup({ apiKey: KEY }, {
      envPath,
      createClient: fakeClient({ agents: [agent('a1', 'Hans'), agent('a2', 'Greta')], uebergabe }),
      applyToProcess: (u) => Object.assign(angewendet, u),
    });

    expect(res.status).toBe('ok');
    expect(res.agentId).toBe('a1');
    expect(res.agentName).toBe('Hans');
    expect(res.message).toContain('Eingerichtet: Agent Hans');
    expect(res.envWritten).toBe(true);

    // Der neue Key wird verwendet, nicht der gespeicherte Platzhalter.
    expect(uebergabe.key).toBe(KEY);

    const werte = parseEnvFile(fs.readFileSync(envPath, 'utf-8'));
    expect(werte.MANUS_API_KEY).toBe(KEY);
    expect(werte.CUE_DELEGATION_ENABLED).toBe('true');
    expect(werte.MANUS_CUE_AGENT_ID).toBe('a1');
    expect(werte.OPENAI_API_KEY).toBe('sk-fremd-nicht-anfassen');

    // process.env wird ueber den injizierten Weg nachgezogen.
    expect(angewendet.MANUS_API_KEY).toBe(KEY);
    expect(angewendet.MANUS_CUE_AGENT_ID).toBe('a1');

    // Genau eine Sicherung pro Lauf, keine Temp-Reste.
    const dateien = fs.readdirSync(path.dirname(envPath)).sort();
    expect(dateien.filter((n) => n.includes('.bak-cuesetup-')).length).toBe(1);
    expect(dateien.filter((n) => n.includes('.tmp-'))).toEqual([]);
  });

  test('ungueltiger Key: es wird nichts geschrieben', async () => {
    const envPath = tempEnv();
    const vorher = fs.readFileSync(envPath, 'utf-8');
    const res = await runCueSetup({ apiKey: 'kurz' }, { envPath, createClient: fakeClient({}) });
    expect(res.status).toBe('error');
    expect(res.envWritten).toBe(false);
    expect(fs.readFileSync(envPath, 'utf-8')).toBe(vorher);
    expect(fs.readdirSync(path.dirname(envPath))).toEqual(['env']);
  });

  test('mehrdeutig: Key ist gesichert, agent_id bleibt offen, Liste wird geliefert', async () => {
    const envPath = tempEnv();
    const res = await runCueSetup({ apiKey: KEY }, {
      envPath,
      createClient: fakeClient({ agents: [agent('a1', 'Hans Dampf'), agent('a2', 'Hansi')] }),
      applyToProcess: () => {},
    });

    expect(res.status).toBe('ambiguous');
    expect(res.message).toContain('a1 — Hans Dampf');
    expect(res.message).toContain('/cue_setup <api-key> <agent_id>');
    expect(res.agents?.length).toBe(2);

    const werte = parseEnvFile(fs.readFileSync(envPath, 'utf-8'));
    expect(werte.MANUS_API_KEY).toBe(KEY);
    expect(werte.CUE_DELEGATION_ENABLED).toBe('true');
    expect(werte.MANUS_CUE_AGENT_ID).toBe('CHANGEME');
  });

  test('Zweitform mit agent_id prueft die ID und schreibt sie', async () => {
    const envPath = tempEnv();
    const res = await runCueSetup({ apiKey: KEY, agentId: 'a2' }, {
      envPath,
      createClient: fakeClient({ agents: [agent('a1', 'Hans'), agent('a2', 'Greta')] }),
      applyToProcess: () => {},
    });
    expect(res.status).toBe('ok');
    expect(res.agentId).toBe('a2');
    expect(res.agentName).toBe('Greta');
    expect(parseEnvFile(fs.readFileSync(envPath, 'utf-8')).MANUS_CUE_AGENT_ID).toBe('a2');
  });

  test('Zweitform mit unbekannter agent_id meldet den Fehler', async () => {
    const envPath = tempEnv();
    const res = await runCueSetup({ apiKey: KEY, agentId: 'gibtsnicht' }, {
      envPath,
      createClient: fakeClient({ agents: [agent('a1', 'Hans')] }),
      applyToProcess: () => {},
    });
    expect(res.status).toBe('error');
    expect(res.message).toContain('agent_id nicht verwendbar');
    expect(res.message).toContain('not_found');
    expect(parseEnvFile(fs.readFileSync(envPath, 'utf-8')).MANUS_CUE_AGENT_ID).toBe('CHANGEME');
  });

  test('nicht abrufbare Agentenliste meldet den Fehlercode', async () => {
    const envPath = tempEnv();
    const res = await runCueSetup({ apiKey: KEY }, {
      envPath,
      createClient: fakeClient({ listError: new ManusError('unauthenticated', 'missing authentication') }),
      applyToProcess: () => {},
    });
    expect(res.status).toBe('error');
    expect(res.message).toContain('Agentenliste nicht abrufbar');
    expect(res.message).toContain('unauthenticated');
  });

  test('nicht schreibbare env-Datei meldet den Fehler und schreibt nichts', async () => {
    const res = await runCueSetup({ apiKey: KEY }, {
      envPath: '/nicht/vorhanden/env',
      createClient: fakeClient({ agents: [agent('a1', 'Hans')] }),
      applyToProcess: () => {},
    });
    expect(res.status).toBe('error');
    expect(res.message).toContain('env-Datei nicht schreibbar');
    expect(res.envWritten).toBe(false);
  });
});

// ── Key-Redaktion ─────────────────────────────────────────────────────────

describe('runCueSetup — Key erscheint in keiner Meldung', () => {
  test('ein in der API-Fehlermeldung gespiegelter Key wird unkenntlich gemacht', async () => {
    const envPath = tempEnv();
    // So wuerde der echte Client den Text liefern: bereits redigiert.
    const res = await runCueSetup({ apiKey: KEY }, {
      envPath,
      createClient: () => ({
        listAgents: async () => { throw new ManusError('invalid_argument', 'bad key *** supplied'); },
        getAgent: async () => { throw new ManusError('invalid_argument', 'bad key *** supplied'); },
        getTask: async (t) => ({
          id: t, status: 'stopped', hasRunningBackgroundJobs: false, taskType: 'standard', title: null,
        }),
        sendMessage: async (t) => ({ taskId: t, requestId: null }),
        listMessages: async (t) => ({ taskId: t, messages: [], hasMore: false, nextCursor: null }),
      }),
      applyToProcess: () => {},
    });
    expect(res.status).toBe('error');
    expect(res.message).not.toContain(KEY);
  });

  test('kein Rueckgabefeld traegt den Key', async () => {
    const envPath = tempEnv();
    const res = await runCueSetup({ apiKey: KEY }, {
      envPath,
      createClient: fakeClient({ agents: [agent('a1', 'Hans')] }),
      applyToProcess: () => {},
    });
    expect(JSON.stringify(res)).not.toContain(KEY);
  });

  test('ein ungueltiger Key wird nicht in der Begruendung wiederholt', async () => {
    const res = await runCueSetup({ apiKey: 'zu-kurz' }, { envPath: tempEnv(), createClient: fakeClient({}) });
    expect(res.message).not.toContain('zu-kurz');
  });
});
