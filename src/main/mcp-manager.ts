import { promises as fsp } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import log from 'electron-log/main';
import type { McpServer, McpServerType } from '@shared/types';

/** Chemin du fichier de config Claude Code utilisateur. C'est là que
 *  `claude mcp add -s user` écrit ses serveurs MCP. */
function getClaudeConfigPath(): string {
  return path.join(os.homedir(), '.claude.json');
}

/** Forme attendue dans `~/.claude.json`. On garde tout le reste du fichier
 *  intact lors d'une réécriture (Claude Code y stocke d'autres champs : projets,
 *  history, etc.) — on ne touche QUE `mcpServers` et `vmuxDisabledMcpServers`. */
interface ClaudeConfigShape {
  mcpServers?: Record<string, RawServerEntry>;
  /** Notre champ propriétaire : on y déplace les serveurs disabled pour ne pas
   *  les perdre. Claude Code ignore les champs inconnus. */
  vmuxDisabledMcpServers?: Record<string, RawServerEntry>;
  [key: string]: unknown;
}

interface RawServerEntry {
  type?: McpServerType;
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  url?: string;
}

async function readConfig(): Promise<ClaudeConfigShape> {
  const p = getClaudeConfigPath();
  try {
    const raw = await fsp.readFile(p, 'utf8');
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return {};
    return parsed as ClaudeConfigShape;
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException)?.code === 'ENOENT') return {};
    log.warn('[mcp] read config failed', err);
    return {};
  }
}

/** Écriture atomique : tmp + rename. Sur Windows, rename est atomique sur le
 *  même volume, donc même si vMux crashe entre l'écriture et le rename, le
 *  fichier original reste intact. */
async function writeConfig(cfg: ClaudeConfigShape): Promise<void> {
  const target = getClaudeConfigPath();
  const tmp = `${target}.vmux.tmp`;
  const json = JSON.stringify(cfg, null, 2);
  await fsp.writeFile(tmp, json, 'utf8');
  await fsp.rename(tmp, target);
}

function entryToServer(name: string, raw: RawServerEntry, disabled: boolean): McpServer {
  // Type par défaut : si command présente → stdio, sinon http (best-effort).
  const inferredType: McpServerType =
    raw.type ?? (raw.command ? 'stdio' : raw.url ? 'http' : 'stdio');
  return {
    name,
    type: inferredType,
    command: raw.command,
    args: raw.args,
    env: raw.env,
    url: raw.url,
    disabled
  };
}

function serverToEntry(s: McpServer): RawServerEntry {
  const entry: RawServerEntry = { type: s.type };
  if (s.command) entry.command = s.command;
  if (s.args && s.args.length > 0) entry.args = s.args;
  if (s.env && Object.keys(s.env).length > 0) entry.env = s.env;
  if (s.url) entry.url = s.url;
  return entry;
}

export async function listServers(): Promise<McpServer[]> {
  const cfg = await readConfig();
  const out: McpServer[] = [];
  for (const [name, raw] of Object.entries(cfg.mcpServers ?? {})) {
    if (!raw || typeof raw !== 'object') continue;
    out.push(entryToServer(name, raw, false));
  }
  for (const [name, raw] of Object.entries(cfg.vmuxDisabledMcpServers ?? {})) {
    if (!raw || typeof raw !== 'object') continue;
    out.push(entryToServer(name, raw, true));
  }
  out.sort((a, b) => a.name.localeCompare(b.name));
  return out;
}

function validateServer(s: McpServer): void {
  if (!s.name || typeof s.name !== 'string') throw new Error('Server name required');
  if (!/^[a-zA-Z0-9_.@\-/]{1,64}$/.test(s.name)) {
    throw new Error('Invalid server name (use letters, digits, ._-@/, max 64 chars)');
  }
  if (s.type === 'stdio') {
    if (!s.command || typeof s.command !== 'string') {
      throw new Error('stdio server requires a command');
    }
  } else if (s.type === 'http' || s.type === 'sse') {
    if (!s.url || !/^https?:\/\//i.test(s.url)) {
      throw new Error(`${s.type} server requires an http(s) URL`);
    }
  } else {
    throw new Error(`Unknown server type: ${s.type}`);
  }
}

/** Add ou update un serveur. Si le nom existe déjà (actif ou disabled), il est
 *  remplacé. Le nouveau serveur va dans `mcpServers` (actif), sauf si
 *  `disabled === true` auquel cas il va dans `vmuxDisabledMcpServers`. */
export async function addServer(s: McpServer): Promise<McpServer[]> {
  validateServer(s);
  const cfg = await readConfig();
  const entry = serverToEntry(s);

  // Drop l'éventuelle entrée existante des deux maps avant de réécrire.
  if (cfg.mcpServers && s.name in cfg.mcpServers) {
    const next = { ...cfg.mcpServers };
    delete next[s.name];
    cfg.mcpServers = next;
  }
  if (cfg.vmuxDisabledMcpServers && s.name in cfg.vmuxDisabledMcpServers) {
    const next = { ...cfg.vmuxDisabledMcpServers };
    delete next[s.name];
    cfg.vmuxDisabledMcpServers = next;
  }

  if (s.disabled) {
    cfg.vmuxDisabledMcpServers = { ...(cfg.vmuxDisabledMcpServers ?? {}), [s.name]: entry };
  } else {
    cfg.mcpServers = { ...(cfg.mcpServers ?? {}), [s.name]: entry };
  }
  await writeConfig(cfg);
  return listServers();
}

export async function removeServer(name: string): Promise<McpServer[]> {
  if (!name || typeof name !== 'string') throw new Error('name required');
  const cfg = await readConfig();
  let changed = false;
  if (cfg.mcpServers && name in cfg.mcpServers) {
    const next = { ...cfg.mcpServers };
    delete next[name];
    cfg.mcpServers = next;
    changed = true;
  }
  if (cfg.vmuxDisabledMcpServers && name in cfg.vmuxDisabledMcpServers) {
    const next = { ...cfg.vmuxDisabledMcpServers };
    delete next[name];
    cfg.vmuxDisabledMcpServers = next;
    changed = true;
  }
  if (changed) await writeConfig(cfg);
  return listServers();
}

/** Toggle l'état d'un serveur entre `mcpServers` et `vmuxDisabledMcpServers`. */
export async function toggleServer(name: string): Promise<McpServer[]> {
  if (!name || typeof name !== 'string') throw new Error('name required');
  const cfg = await readConfig();
  if (cfg.mcpServers && name in cfg.mcpServers) {
    const entry = cfg.mcpServers[name];
    const nextActive = { ...cfg.mcpServers };
    delete nextActive[name];
    cfg.mcpServers = nextActive;
    cfg.vmuxDisabledMcpServers = { ...(cfg.vmuxDisabledMcpServers ?? {}), [name]: entry };
  } else if (cfg.vmuxDisabledMcpServers && name in cfg.vmuxDisabledMcpServers) {
    const entry = cfg.vmuxDisabledMcpServers[name];
    const nextDisabled = { ...cfg.vmuxDisabledMcpServers };
    delete nextDisabled[name];
    cfg.vmuxDisabledMcpServers = nextDisabled;
    cfg.mcpServers = { ...(cfg.mcpServers ?? {}), [name]: entry };
  } else {
    return listServers();
  }
  await writeConfig(cfg);
  return listServers();
}

export function getConfigPath(): string {
  return getClaudeConfigPath();
}
