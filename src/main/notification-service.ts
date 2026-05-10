import { BrowserWindow, Notification, app, nativeImage } from 'electron';
import log from 'electron-log/main';
import { promises as fsp } from 'node:fs';
import path from 'node:path';
import { IPC, type DetectedEvent, type Lang, type PaneId } from '@shared/types';
import { DEFAULT_AGENTS } from '@shared/agents';
import { attentionBody, notifBundle } from '@shared/notif-i18n';
import { getSettings } from './settings-store';
import { ptyManager } from './pty-manager';

/** Lookup contextuel pour les notifs : trouve la session/pane/agent depuis un paneId. */
interface PaneContext {
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
    return { sessionName: s.name, agentLabel };
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
}

function getNotificationIcon(): Electron.NativeImage | undefined {
  return cachedNativeIcon;
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
}

export function createNotificationService(
  getMainWindow: () => BrowserWindow | null,
  safeSend: (channel: string, ...args: unknown[]) => void
): NotificationService {
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
        silent
      });
      notif.on('click', () => {
        if (!w || w.isDestroyed()) return;
        if (w.isMinimized()) w.restore();
        w.show();
        w.focus();
        try {
          w.flashFrame(false);
        } catch {
          /* ignore */
        }
      });
      notif.show();
      // Custom sound : on demande au renderer de jouer le .wav/.mp3 choisi.
      if (settings.notificationSound === 'custom' && settings.notificationSoundPath) {
        safeSend(IPC.notifPlaySound, settings.notificationSoundPath);
      }
    } catch (err) {
      log.warn('[notif] paneAttention show failed', err);
    }
  }

  /** Event détecté → notif system uniquement si fenêtre en arrière-plan. */
  function notifyEvent(event: DetectedEvent): void {
    const w = getMainWindow();
    const settings = getSettings();
    if (!settings.notificationsEnabled) return;
    if (!w || w.isFocused()) return;
    if (!Notification.isSupported()) return;
    const lang = settings.language as Lang;
    const bundle = notifBundle(lang);
    const title = bundle.eventTitle[event.kind];
    try {
      const silent = settings.notificationSound !== 'default';
      new Notification({
        title,
        body: event.message,
        icon: getNotificationIcon(),
        silent
      }).show();
      if (settings.notificationSound === 'custom' && settings.notificationSoundPath) {
        safeSend(IPC.notifPlaySound, settings.notificationSoundPath);
      }
    } catch (err) {
      log.warn('[notif] failed to show', err);
    }
  }

  return { notifyAttention, notifyEvent };
}
