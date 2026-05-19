import path from 'node:path';
import type {
  AppSettings,
  CreateSessionInput,
  McpServer,
  PtySize,
  Snippet,
  SplitDirection,
  SplitPaneInput
} from '@shared/types';
import type { TreePath } from '@shared/tree';
import type { LayoutPreset } from '@shared/layouts';

// ============================================================
// Validation helpers (IPC boundary = security perimeter)
// ============================================================

/** Cap commun pour toute string scalaire passée par IPC. Évite qu'un renderer
 *  bogué (ou compromis) ne nous balance des chaînes multi-MB qu'on ferait
 *  trainer en mémoire ou dans des stores. 4 KiB couvre largement les paths,
 *  noms de session, URLs, labels, etc. */
export const MAX_STRING_LEN = 4096;

/** Cap dédié pour `clipboard:write` — paste cli, snippets : 1 MiB max. */
export const MAX_CLIPBOARD_LEN = 1024 * 1024;

/** Cap des IDs (paneId, sessionId, snippet.id) — UUID = 36 chars, on laisse
 *  de la marge pour des IDs custom. */
export const MAX_ID_LEN = 128;

/** Cap pour les labels affichés (renamePane, renameSession). Le pty-manager
 *  re-trim de toute façon, mais on évite de transporter 4 KiB pour 60 chars
 *  utiles. */
export const MAX_LABEL_LEN = 200;

export function isNonEmptyString(v: unknown, max = MAX_STRING_LEN): v is string {
  return typeof v === 'string' && v.length > 0 && v.length <= max && v.indexOf('\0') === -1;
}

export function isString(v: unknown, max = MAX_STRING_LEN): v is string {
  return typeof v === 'string' && v.length <= max && v.indexOf('\0') === -1;
}

export function isId(v: unknown): v is string {
  return isNonEmptyString(v, MAX_ID_LEN);
}

/** Validation de PtySize venu du renderer — rejette les valeurs non finies ou
 *  négatives qui feraient crasher node-pty.resize(). */
export function isValidPtySize(s: unknown): s is PtySize {
  if (!s || typeof s !== 'object') return false;
  const o = s as Record<string, unknown>;
  return (
    typeof o.cols === 'number' &&
    typeof o.rows === 'number' &&
    Number.isFinite(o.cols) &&
    Number.isFinite(o.rows) &&
    o.cols > 0 &&
    o.rows > 0 &&
    o.cols <= 10000 &&
    o.rows <= 10000
  );
}

/** Rejette une string qui contient un NUL byte, des séquences traversantes
 *  ou des préfixes Windows dangereux. Retourne `true` si le chemin EST unsafe. */
export function isUnsafePath(p: unknown): boolean {
  if (typeof p !== 'string' || !p) return true;
  if (p.length > MAX_STRING_LEN) return true;
  if (p.indexOf('\0') !== -1) return true;
  if (process.platform === 'win32') {
    // \\server\share, \\.\device, \\?\
    if (p.startsWith('\\\\')) return true;
    // /dev/ etc. n'existe pas sur Windows mais on les rejette quand même.
    if (/^\/+(?:dev|proc|sys)\//i.test(p)) return true;
  }
  return false;
}

/** Normalise + valide un chemin reçu du renderer. Retourne le chemin résolu
 *  absolu, ou `null` si invalide. Mutualise les checks `isUnsafePath` +
 *  `path.resolve` pour ne pas oublier le second à un endroit. */
export function safePath(p: unknown): string | null {
  if (isUnsafePath(p)) return null;
  try {
    const resolved = path.resolve(p as string);
    if (resolved.indexOf('\0') !== -1) return null;
    return resolved;
  } catch {
    return null;
  }
}

/** Validation stricte d'URL http(s) côté IPC — bloque javascript:/file:/data:/etc. */
export function isHttpUrl(u: unknown): u is string {
  if (typeof u !== 'string' || u.length === 0 || u.length > MAX_STRING_LEN) return false;
  if (!/^https?:\/\//i.test(u)) return false;
  // Refuse les NUL et autres ctrl chars qui peuvent masquer le scheme.
  // eslint-disable-next-line no-control-regex
  if (/[\x00-\x1f\x7f]/.test(u)) return false;
  try {
    // URL parser valide la structure (host non vide, port valide…). Sans ça,
    // `http://` passerait le regex mais serait inutile.
    const parsed = new URL(u);
    if (!parsed.host) return false;
    return true;
  } catch {
    return false;
  }
}

export function isSplitDirection(d: unknown): d is SplitDirection {
  return d === 'horizontal' || d === 'vertical';
}

/** Liste blanche des clés AppSettings — empêche les attaques prototype-pollution
 *  (`__proto__`, `constructor`, `prototype`) et la fuite de clés inconnues vers
 *  electron-conf. */
export const ALLOWED_SETTINGS_KEYS = new Set<keyof AppSettings>([
  'theme', 'language', 'fontFamily', 'fontSize', 'defaultShell', 'scrollback',
  'cursorBlink', 'copyOnSelection', 'pasteOnRightClick', 'webglRenderer',
  'sidebarWidth', 'previewToastEnabled', 'previewAutoOpen', 'notificationsEnabled',
  'notificationSound', 'notificationSoundPath', 'autoLaunch', 'previewDefaultSplit',
  'agentOverrides', 'onboardingCompleted', 'autoRestoreOnBoot',
  'lastActiveSessionId', 'cdpEnabled', 'cdpPort', 'claudeCommandsEnabled'
]);

export function sanitizeSettingsPatch(patch: unknown): Partial<AppSettings> {
  if (!patch || typeof patch !== 'object') return {};
  const out: Record<string, unknown> = {};
  for (const k of Object.keys(patch)) {
    if (!ALLOWED_SETTINGS_KEYS.has(k as keyof AppSettings)) continue;
    out[k] = (patch as Record<string, unknown>)[k];
  }
  return out as Partial<AppSettings>;
}

/** Validation structurelle d'un McpServer venu du renderer. Le command/args/env
 *  ne sont pas filtrés sémantiquement (l'user peut légitimement configurer
 *  n'importe quel serveur MCP) mais on vérifie shape/limites pour éviter qu'un
 *  bug renderer écrive du JSON corrompu dans `~/.claude.json`. */
export function isValidMcpServer(s: unknown): s is McpServer {
  if (!s || typeof s !== 'object') return false;
  const o = s as Record<string, unknown>;
  if (typeof o.name !== 'string' || o.name.length === 0 || o.name.length > 80) return false;
  if (o.name.indexOf('\0') !== -1 || /[/\\]/.test(o.name)) return false;
  if (o.type !== 'stdio' && o.type !== 'http' && o.type !== 'sse') return false;
  if (o.command !== undefined) {
    if (typeof o.command !== 'string' || o.command.length > 2048) return false;
    if (o.command.indexOf('\0') !== -1) return false;
  }
  if (o.args !== undefined) {
    if (!Array.isArray(o.args) || o.args.length > 64) return false;
    for (const a of o.args) {
      if (typeof a !== 'string' || a.length > MAX_STRING_LEN || a.indexOf('\0') !== -1) return false;
    }
  }
  if (o.env !== undefined) {
    if (!o.env || typeof o.env !== 'object' || Array.isArray(o.env)) return false;
    const env = o.env as Record<string, unknown>;
    const keys = Object.keys(env);
    if (keys.length > 64) return false;
    for (const k of keys) {
      if (k === '__proto__' || k === 'constructor' || k === 'prototype') return false;
      if (k.length > 128 || k.indexOf('\0') !== -1) return false;
      const v = env[k];
      if (typeof v !== 'string' || v.length > MAX_STRING_LEN || v.indexOf('\0') !== -1) return false;
    }
  }
  if (o.url !== undefined) {
    if (typeof o.url !== 'string' || o.url.length > MAX_STRING_LEN) return false;
    if (o.type !== 'stdio' && !isHttpUrl(o.url)) return false;
  }
  if (o.disabled !== undefined && typeof o.disabled !== 'boolean') return false;
  return true;
}

export function isValidSnippet(s: unknown): s is Snippet {
  if (!s || typeof s !== 'object') return false;
  const o = s as Record<string, unknown>;
  if (typeof o.id !== 'string' || o.id.length === 0 || o.id.length > MAX_ID_LEN) return false;
  if (typeof o.name !== 'string' || o.name.length === 0 || o.name.length > MAX_LABEL_LEN) return false;
  if (typeof o.content !== 'string' || o.content.length > 64 * 1024) return false;
  if (typeof o.createdAt !== 'number' || !Number.isFinite(o.createdAt)) return false;
  if (o.tags !== undefined) {
    if (!Array.isArray(o.tags) || o.tags.length > 32) return false;
    for (const t of o.tags) {
      if (typeof t !== 'string' || t.length > 64) return false;
    }
  }
  return true;
}

export function isValidCreateSessionInput(v: unknown): v is CreateSessionInput {
  if (!v || typeof v !== 'object') return false;
  const o = v as Record<string, unknown>;
  if (typeof o.name !== 'string' || o.name.length > MAX_LABEL_LEN) return false;
  if (typeof o.agentId !== 'string' || o.agentId.length === 0 || o.agentId.length > 64) return false;
  if (typeof o.cwd !== 'string' || isUnsafePath(o.cwd)) return false;
  if (o.initialInput !== undefined) {
    if (typeof o.initialInput !== 'string' || o.initialInput.length > 64 * 1024) return false;
  }
  if (o.newWorktree !== undefined) {
    if (!o.newWorktree || typeof o.newWorktree !== 'object') return false;
    const w = o.newWorktree as Record<string, unknown>;
    if (typeof w.branch !== 'string' || w.branch.length === 0 || w.branch.length > MAX_LABEL_LEN) return false;
    if (w.base !== undefined && (typeof w.base !== 'string' || w.base.length > MAX_LABEL_LEN)) return false;
    if (w.parentDir !== undefined && (typeof w.parentDir !== 'string' || isUnsafePath(w.parentDir))) return false;
  }
  return true;
}

export function isValidSplitPaneInput(v: unknown): v is SplitPaneInput {
  if (!v || typeof v !== 'object') return false;
  const o = v as Record<string, unknown>;
  if (!isId(o.sessionId) || !isId(o.paneId)) return false;
  if (!isSplitDirection(o.direction)) return false;
  if (o.agentId !== undefined && (typeof o.agentId !== 'string' || o.agentId.length > 64)) return false;
  if (o.cwd !== undefined && (typeof o.cwd !== 'string' || isUnsafePath(o.cwd))) return false;
  if (o.url !== undefined && !isHttpUrl(o.url)) return false;
  if (o.followsPaneId !== undefined && !isId(o.followsPaneId)) return false;
  return true;
}

export function isValidTreePath(v: unknown): v is TreePath {
  if (!Array.isArray(v) || v.length > 64) return false;
  for (const n of v) {
    if (typeof n !== 'number' || !Number.isInteger(n) || n < 0 || n > 1024) return false;
  }
  return true;
}

export function isValidSizesArray(v: unknown): v is number[] {
  if (!Array.isArray(v) || v.length === 0 || v.length > 16) return false;
  for (const n of v) {
    if (typeof n !== 'number' || !Number.isFinite(n) || n < 0 || n > 100) return false;
  }
  return true;
}

export const VALID_LAYOUT_PRESETS = new Set<LayoutPreset>([
  'tiled', 'even-horizontal', 'even-vertical', 'main-stack'
]);
export function isValidLayoutPreset(v: unknown): v is LayoutPreset {
  return typeof v === 'string' && VALID_LAYOUT_PRESETS.has(v as LayoutPreset);
}
