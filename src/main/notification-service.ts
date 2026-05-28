import { BrowserWindow, Notification, app, nativeImage } from 'electron';
import log from 'electron-log/main';
import { promises as fsp } from 'node:fs';
import path from 'node:path';
import { IPC, type DetectedEvent, type Lang, type PaneId } from '@shared/types';
import { DEFAULT_AGENTS } from '@shared/agents';
import { attentionBody, notifBundle } from '@shared/notif-i18n';
import { getSettings } from './settings-store';
// IMPORTANT: import the live host-client proxy, NOT './pty-manager'. The latter's
// module-level `ptyManager` singleton runs in the MAIN process and is always
// empty — the real PTYs/sessions live in the PTY-host utilityProcess, reachable
// only through this proxy. Importing './pty-manager' here forked a second, empty
// PtyManager (so lookupPaneContext saw zero sessions → generic notif titles +
// broken click-to-focus) and registered a duplicate unhandledRejection handler.
import { ptyManager } from './pty-host-client-singleton';

/** Lookup contextuel pour les notifs : trouve la session/pane/agent depuis un paneId.
 *  `sessionId` est inclus pour que le click handler de la notif puisse demander
 *  au renderer de focuser exactement la bonne session+pane (multi-agent UX). */
interface PaneContext {
  sessionId?: string;
  sessionName: string;
  agentLabel: string;
}

function lookupPaneContext(paneId: PaneId): PaneContext {
  const all = ptyManager.list();
  for (const s of all) {
    const p = s.panes[paneId];
    if (!p) continue;
    const agentLabel =
      p.kind === 'terminal'
        ? (DEFAULT_AGENTS.find((a) => a.id === p.agentId)?.label ?? p.agentId)
        : '';
    return { sessionId: s.id, sessionName: s.name, agentLabel };
  }
  return { sessionName: 'Agent', agentLabel: '' };
}

// ============================================================
// Cache de l'icône de notif
// ============================================================
// Résolu une fois au boot — évite l'accessSync en hot path.

let cachedNativeIcon: Electron.NativeImage | undefined;

export async function preloadNotificationIcon(): Promise<void> {
  const candidates = [
    path.join(process.resourcesPath, 'icon.png'),
    path.join(app.getAppPath(), 'build', 'icon.png'),
    path.join(app.getAppPath(), '..', 'build', 'icon.png')
  ];
  for (const p of candidates) {
    try {
      await fsp.access(p);
      cachedNativeIcon = nativeImage.createFromPath(p);
      return;
    } catch {
      /* candidate absent, try next */
    }
  }
  log.debug('[notif] no icon candidate found, using OS default');
}

function getNotificationIcon(): Electron.NativeImage | undefined {
  return cachedNativeIcon;
}

// ============================================================
// Coalescing : 1 notif max / 300ms par session (ou par paneId si pas de session).
// ============================================================
// Un agent qui spam `notify` (OSC 9 répétés, build qui flap…) ne doit pas
// inonder le centre de notifs Windows. On coalesce sur une fenêtre glissante
// par session : si une notif est en cours pour cette session, on drop la
// suivante. Le centre de notif Windows lui-même cap à 20 toasts/app, donc
// sans ce gate on perd silencieusement les notifs anciennes au lieu d'écraser
// les nouvelles redondantes.

const COALESCE_WINDOW_MS = 300;
const lastNotifAt = new Map<string, number>();

function shouldEmit(key: string): boolean {
  const now = Date.now();
  const last = lastNotifAt.get(key) ?? 0;
  if (now - last < COALESCE_WINDOW_MS) return false;
  lastNotifAt.set(key, now);
  // Sweep léger : si la map dépasse 256 entries, on droppe les entrées stale.
  // 256 sessions actives simultanées est largement au-delà de l'usage réel.
  if (lastNotifAt.size > 256) {
    const cutoff = now - COALESCE_WINDOW_MS * 10;
    for (const [k, v] of lastNotifAt) {
      if (v < cutoff) lastNotifAt.delete(k);
    }
  }
  return true;
}

// ============================================================
// Retention des Notification objects
// ============================================================
// Sur Windows, si l'object `Notification` est GC avant que l'user clique, le
// click handler ne se déclenche jamais (le binding natif a été libéré). On
// retient les notifs vivantes dans un Set et on les drop sur `close` (event
// Electron 42 : userCanceled / applicationHidden / timedOut).

const liveNotifs = new Set<Notification>();

function retain(notif: Notification): void {
  liveNotifs.add(notif);
  const release = (): void => {
    liveNotifs.delete(notif);
    notif.removeAllListeners();
  };
  notif.once('close', release);
  // Filet de sécurité : si l'OS n'émet jamais `close` (linux/macos pour
  // certains drivers), on libère après 60s — bien au-delà du timeout natif.
  setTimeout(release, 60_000).unref();
}

// ============================================================
// API publique
// ============================================================

/** Service de notification : factorise toute la logique notif (system, sound,
 *  flashFrame) hors d'ipc.ts. Construit avec une closure sur getMainWindow et
 *  safeSend pour rester découplé d'ipc.ts. */
export interface NotificationService {
  notifyAttention(paneId: PaneId, level: 'activity' | 'alert' | 'needs-input'): void;
  notifyEvent(event: DetectedEvent): void;
  /** Cleanup explicite (app quit) : ferme toutes les notifs vivantes pour
   *  qu'elles ne traînent pas dans le centre de notifs après quit. */
  shutdown(): void;
}

export function createNotificationService(
  getMainWindow: () => BrowserWindow | null,
  safeSend: (channel: string, ...args: unknown[]) => void
): NotificationService {
  function focusMain(w: BrowserWindow): void {
    if (w.isDestroyed()) return;
    if (w.isMinimized()) w.restore();
    w.show();
    w.focus();
    try {
      w.flashFrame(false);
    } catch {
      /* ignore */
    }
  }

  /** needs-input → notification push system + flashFrame Windows. */
  function notifyAttention(
    paneId: PaneId,
    level: 'activity' | 'alert' | 'needs-input'
  ): void {
    if (level !== 'needs-input') return;
    const w = getMainWindow();
    const settings = getSettings();
    if (!settings.notificationsEnabled) return;
    const lang = settings.language as Lang;
    const bundle = notifBundle(lang);
    const ctx = lookupPaneContext(paneId);

    // Coalesce par session (ou paneId si pas de session). Un agent qui spam
    // OSC 9 ne déclenche pas N toasts.
    const coalesceKey = `attn:${ctx.sessionId ?? paneId}`;
    if (!shouldEmit(coalesceKey)) return;

    if (w && !w.isFocused()) {
      // flashFrame : Windows fait clignoter l'icône dans la barre des tâches
      // jusqu'à ce que l'user clique. No-op sur autres OS.
      try {
        w.flashFrame(true);
      } catch (err) {
        log.debug('[notif] flashFrame failed', err);
      }
    }

    if (!Notification.isSupported()) return;
    try {
      const silent = settings.notificationSound !== 'default';
      const notif = new Notification({
        title: `${bundle.attentionTitlePrefix} — ${ctx.sessionName}`,
        body: attentionBody(lang, ctx.agentLabel || undefined),
        icon: getNotificationIcon(),
        urgency: 'critical',
        silent,
        timeoutType: 'default'
      });
      notif.on('click', () => {
        const win = getMainWindow();
        if (win) focusMain(win);
      });
      retain(notif);
      notif.show();
      // Custom sound : on demande au renderer de jouer le .wav/.mp3 choisi.
      if (settings.notificationSound === 'custom' && settings.notificationSoundPath) {
        safeSend(IPC.notifPlaySound, settings.notificationSoundPath);
      }
    } catch (err) {
      log.warn('[notif] paneAttention show failed', err);
    }
  }

  /** Event détecté → notif system uniquement si fenêtre en arrière-plan.
   *
   *  Multi-agent UX : le titre porte le nom custom de l'event (OSC `notify`)
   *  ou le titre i18n du `kind`. Le body inclut le couple `<session> · <agent>`
   *  pour que l'user identifie d'un coup d'œil quel agent a déclenché la notif
   *  parmi N qui tournent en parallèle. Click → focus la window + demande au
   *  renderer de switcher sur la session+pane qui a émis l'event. */
  function notifyEvent(event: DetectedEvent): void {
    const w = getMainWindow();
    const settings = getSettings();
    if (!settings.notificationsEnabled) return;
    if (!w || w.isFocused()) return;
    if (!Notification.isSupported()) return;
    const lang = settings.language as Lang;
    const bundle = notifBundle(lang);

    // Pour `notify` (OSC) : l'agent fournit son propre titre via event.title.
    // Pour les autres kinds : titre i18n hard-codé.
    const baseTitle = event.title?.trim() || bundle.eventTitle[event.kind];
    const ctx = lookupPaneContext(event.paneId);
    const sessionLabel = ctx.agentLabel
      ? `${ctx.sessionName} · ${ctx.agentLabel}`
      : ctx.sessionName;
    const body = event.message
      ? `${sessionLabel}\n${event.message}`
      : sessionLabel;

    // Coalesce par session + kind : un build qui flap ne génère qu'1 toast/300ms.
    const coalesceKey = `evt:${ctx.sessionId ?? event.paneId}:${event.kind}`;
    if (!shouldEmit(coalesceKey)) return;

    try {
      const silent = settings.notificationSound !== 'default';
      const notif = new Notification({
        title: baseTitle,
        body,
        icon: getNotificationIcon(),
        silent,
        timeoutType: 'default'
      });
      notif.on('click', () => {
        const win = getMainWindow();
        if (!win) return;
        focusMain(win);
        // Demande au renderer de switcher sur la session+pane émetteur. Sans
        // ça l'user atterrit sur la session active courante, pas celle qui a
        // crié — ce qui annule le bénéfice de la notif en multi-agent.
        if (ctx.sessionId) {
          safeSend(IPC.sessionFocusRequest, ctx.sessionId, event.paneId);
        }
      });
      retain(notif);
      notif.show();
      if (settings.notificationSound === 'custom' && settings.notificationSoundPath) {
        safeSend(IPC.notifPlaySound, settings.notificationSoundPath);
      }
    } catch (err) {
      log.warn('[notif] failed to show', err);
    }
  }

  function shutdown(): void {
    for (const n of liveNotifs) {
      try {
        n.close();
      } catch {
        /* ignore — already closed */
      }
      n.removeAllListeners();
    }
    liveNotifs.clear();
    lastNotifAt.clear();
  }

  return { notifyAttention, notifyEvent, shutdown };
}
