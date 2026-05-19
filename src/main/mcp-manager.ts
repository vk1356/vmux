import { promises as fsp } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
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

/** Borne dure sur la taille de `~/.claude.json` qu'on accepte de parser.
 *  Le fichier réel chez un user actif fait ~quelques centaines de Ko (projets,
 *  history). 32 Mo couvre tous les cas légitimes et empêche une corruption ou
 *  un fichier maliceux pointé par symlink de spinner le main process. */
const MAX_CONFIG_BYTES = 32 * 1024 * 1024;

/** Sérialisation des opérations d'écriture pour éviter les races read-modify-write.
 *  Tous les handlers IPC qui mutent `~/.claude.json` (add/remove/toggle) passent
 *  par cette chaîne ; lectures pures (`listServers` sans write) peuvent court-
 *  circuiter — `readConfig` est tolérant aux écritures concurrentes côté Claude
 *  Code grâce au rename atomique. */
let writeQueue: Promise<unknown> = Promise.resolve();
function withWriteLock<T>(fn: () => Promise<T>): Promise<T> {
  const next = writeQueue.then(fn, fn);
  // On garde la chaîne en vie même en cas d'erreur — sinon une exception
  // briserait la sérialisation des opérations suivantes.
  writeQueue = next.catch(() => undefined);
  return next;
}

/** JSON.parse reviver qui drop `__proto__` / `constructor` / `prototype` —
 *  défense contre prototype pollution si l'user (ou un outil tiers) édite
 *  `.claude.json` à la main avec ces clés. */
function safeReviver(key: string, value: unknown): unknown {
  if (key === '__proto__' || key === 'constructor' || key === 'prototype') return undefined;
  return value;
}

async function readConfig(): Promise<ClaudeConfigShape> {
  const p = getClaudeConfigPath();
  try {
    // On lit via stat + readFile plutôt qu'un readFile direct pour pouvoir
    // refuser un fichier trop gros avant de tenter de l'avaler en RAM.
    const st = await fsp.stat(p);
    if (!st.isFile()) {
      log.warn('[mcp] config path is not a regular file, ignoring');
      return {};
    }
    if (st.size > MAX_CONFIG_BYTES) {
      log.warn(`[mcp] config too large (${st.size} bytes), refusing to parse`);
      return {};
    }
    const raw = await fsp.readFile(p, 'utf8');
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw, safeReviver);
    } catch (parseErr) {
      // Fichier corrompu — on refuse de l'écraser. Le caller listServers verra
      // une liste vide mais ne pourra pas écrire (le prochain writeConfig ne
      // sera jamais appelé tant qu'on ne récupère pas un objet valide).
      log.error('[mcp] config parse failed, refusing to clobber existing file', parseErr);
      throw new Error('Claude config file is corrupted (invalid JSON). Fix or remove ~/.claude.json before using vMux MCP manager.', { cause: parseErr });
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    return parsed as ClaudeConfigShape;
  } catch (err: unknown) {
    const code = (err as NodeJS.ErrnoException)?.code;
    if (code === 'ENOENT') return {};
    if (err instanceof Error && err.message.startsWith('Claude config file is corrupted')) {
      throw err;
    }
    log.warn('[mcp] read config failed', err);
    return {};
  }
}

/** Écriture atomique : tmp + rename. Sur Windows comme sur POSIX, rename sur le
 *  même volume est atomique, donc même si vMux crashe entre l'écriture et le
 *  rename, le fichier original reste intact.
 *
 *  Le suffixe du tmp inclut un nonce random (pid + 8 bytes) pour que deux
 *  vMux concurrents ou un crash précédent ne se marchent pas dessus.
 *  Best-effort fsync + cleanup du tmp en cas d'échec. */
async function writeConfig(cfg: ClaudeConfigShape): Promise<void> {
  const target = getClaudeConfigPath();
  const nonce = randomBytes(8).toString('hex');
  const tmp = `${target}.vmux.${process.pid}.${nonce}.tmp`;
  const json = JSON.stringify(cfg, null, 2);

  // Préserver le mode du fichier existant (Claude Code peut l'avoir créé avec
  // 0o600 sur POSIX pour cacher des tokens). Sur Windows, mode est ignoré.
  let mode: number | undefined;
  try {
    const st = await fsp.stat(target);
    mode = st.mode & 0o777;
  } catch {
    /* fichier absent → on prend le défaut */
  }

  let handle: import('node:fs').promises.FileHandle | null = null;
  try {
    handle = await fsp.open(tmp, 'w', mode ?? 0o600);
    await handle.writeFile(json, 'utf8');
    // fsync pour garantir que le contenu est sur disque avant le rename —
    // sinon un crash kernel/OS pourrait laisser un tmp valide mais vide
    // pointé par le rename. Best-effort : certains FS (FAT) n'implémentent
    // pas fsync, on swallow l'erreur.
    try {
      await handle.sync();
    } catch {
      /* ignore */
    }
    await handle.close();
    handle = null;
    await fsp.rename(tmp, target);
  } catch (err) {
    if (handle) {
      try { await handle.close(); } catch { /* ignore */ }
    }
    // Cleanup best-effort du tmp orphelin.
    try { await fsp.unlink(tmp); } catch { /* ignore */ }
    throw err;
  }
}

function isRawEntry(raw: unknown): raw is RawServerEntry {
  return !!raw && typeof raw === 'object' && !Array.isArray(raw);
}

/** Coerce une entrée brute lue sur disque vers un McpServer "sain". On rejette
 *  silencieusement les champs malformés au lieu de jeter — un user/outil tiers
 *  peut avoir édité `.claude.json` avec des trucs bizarres et on ne veut pas
 *  que ça crashe la liste entière. */
function entryToServer(name: string, raw: RawServerEntry, disabled: boolean): McpServer | null {
  const command = typeof raw.command === 'string' ? raw.command : undefined;
  const url = typeof raw.url === 'string' ? raw.url : undefined;
  const rawType = raw.type;
  const inferredType: McpServerType =
    rawType === 'stdio' || rawType === 'http' || rawType === 'sse'
      ? rawType
      : command
        ? 'stdio'
        : url
          ? 'http'
          : 'stdio';

  // args: filtrer les non-string (defensive).
  let args: string[] | undefined;
  if (Array.isArray(raw.args)) {
    args = raw.args.filter((a): a is string => typeof a === 'string');
    if (args.length === 0) args = undefined;
  }

  // env: drop clés dangereuses + valeurs non-string.
  let env: Record<string, string> | undefined;
  if (raw.env && typeof raw.env === 'object' && !Array.isArray(raw.env)) {
    const sanitized: Record<string, string> = {};
    for (const [k, v] of Object.entries(raw.env as Record<string, unknown>)) {
      if (k === '__proto__' || k === 'constructor' || k === 'prototype') continue;
      if (typeof v === 'string') sanitized[k] = v;
    }
    if (Object.keys(sanitized).length > 0) env = sanitized;
  }

  return {
    name,
    type: inferredType,
    command,
    args,
    env,
    url,
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

function collectServers(cfg: ClaudeConfigShape): McpServer[] {
  const out: McpServer[] = [];
  const active = cfg.mcpServers;
  if (active && typeof active === 'object' && !Array.isArray(active)) {
    for (const [name, raw] of Object.entries(active)) {
      if (!isRawEntry(raw)) continue;
      const s = entryToServer(name, raw, false);
      if (s) out.push(s);
    }
  }
  const disabled = cfg.vmuxDisabledMcpServers;
  if (disabled && typeof disabled === 'object' && !Array.isArray(disabled)) {
    for (const [name, raw] of Object.entries(disabled)) {
      if (!isRawEntry(raw)) continue;
      const s = entryToServer(name, raw, true);
      if (s) out.push(s);
    }
  }
  out.sort((a, b) => a.name.localeCompare(b.name));
  return out;
}

export async function listServers(): Promise<McpServer[]> {
  const cfg = await readConfig();
  return collectServers(cfg);
}

/** Validation du nom de serveur côté write (en plus de la validation IPC).
 *  Regex restreinte pour éviter qu'un nom contenant `..` ou `/` ne soit
 *  interprété comme un chemin par un futur consumer. Le nom ne touche jamais
 *  le filesystem chez nous, mais c'est de la defense-in-depth. */
function validateServer(s: McpServer): void {
  if (!s.name || typeof s.name !== 'string') throw new Error('Server name required');
  if (s.name.length > 80) throw new Error('Server name too long (max 80 chars)');
  if (!/^[a-zA-Z0-9_.@-]{1,80}$/.test(s.name)) {
    throw new Error('Invalid server name (use letters, digits, ._-@, max 80 chars)');
  }
  if (s.name === '__proto__' || s.name === 'constructor' || s.name === 'prototype') {
    throw new Error('Reserved server name');
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
    throw new Error(`Unknown server type: ${String(s.type)}`);
  }
}

/** Add ou update un serveur. Si le nom existe déjà (actif ou disabled), il est
 *  remplacé. Le nouveau serveur va dans `mcpServers` (actif), sauf si
 *  `disabled === true` auquel cas il va dans `vmuxDisabledMcpServers`. */
export async function addServer(s: McpServer): Promise<McpServer[]> {
  validateServer(s);
  return withWriteLock(async () => {
    const cfg = await readConfig();
    const entry = serverToEntry(s);

    if (cfg.mcpServers && Object.prototype.hasOwnProperty.call(cfg.mcpServers, s.name)) {
      const next = { ...cfg.mcpServers };
      delete next[s.name];
      cfg.mcpServers = next;
    }
    if (
      cfg.vmuxDisabledMcpServers &&
      Object.prototype.hasOwnProperty.call(cfg.vmuxDisabledMcpServers, s.name)
    ) {
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
    return collectServers(cfg);
  });
}

export async function removeServer(name: string): Promise<McpServer[]> {
  if (!name || typeof name !== 'string') throw new Error('name required');
  if (name.length > 80) throw new Error('name too long');
  return withWriteLock(async () => {
    const cfg = await readConfig();
    let changed = false;
    if (cfg.mcpServers && Object.prototype.hasOwnProperty.call(cfg.mcpServers, name)) {
      const next = { ...cfg.mcpServers };
      delete next[name];
      cfg.mcpServers = next;
      changed = true;
    }
    if (
      cfg.vmuxDisabledMcpServers &&
      Object.prototype.hasOwnProperty.call(cfg.vmuxDisabledMcpServers, name)
    ) {
      const next = { ...cfg.vmuxDisabledMcpServers };
      delete next[name];
      cfg.vmuxDisabledMcpServers = next;
      changed = true;
    }
    if (changed) await writeConfig(cfg);
    return collectServers(cfg);
  });
}

/** Toggle l'état d'un serveur entre `mcpServers` et `vmuxDisabledMcpServers`. */
export async function toggleServer(name: string): Promise<McpServer[]> {
  if (!name || typeof name !== 'string') throw new Error('name required');
  if (name.length > 80) throw new Error('name too long');
  return withWriteLock(async () => {
    const cfg = await readConfig();
    if (cfg.mcpServers && Object.prototype.hasOwnProperty.call(cfg.mcpServers, name)) {
      const entry = cfg.mcpServers[name];
      const nextActive = { ...cfg.mcpServers };
      delete nextActive[name];
      cfg.mcpServers = nextActive;
      cfg.vmuxDisabledMcpServers = { ...(cfg.vmuxDisabledMcpServers ?? {}), [name]: entry };
    } else if (
      cfg.vmuxDisabledMcpServers &&
      Object.prototype.hasOwnProperty.call(cfg.vmuxDisabledMcpServers, name)
    ) {
      const entry = cfg.vmuxDisabledMcpServers[name];
      const nextDisabled = { ...cfg.vmuxDisabledMcpServers };
      delete nextDisabled[name];
      cfg.vmuxDisabledMcpServers = nextDisabled;
      cfg.mcpServers = { ...(cfg.mcpServers ?? {}), [name]: entry };
    } else {
      return collectServers(cfg);
    }
    await writeConfig(cfg);
    return collectServers(cfg);
  });
}

export function getConfigPath(): string {
  return getClaudeConfigPath();
}
