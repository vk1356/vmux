import { BrowserWindow, Notification, app, nativeImage } from 'electron';
import log from 'electron-log/main';
import { promises as fsp } from 'node:fs';
import path from 'node:path';
import { IPC, type DetectedEvent, type Lang, type PaneId } from '@shared/types';
import { DEFAULT_AGENTS } from '@shared/agents';
import { attentionBody, notifBundle } from '@shared/notif-i18n';
import { getSettings } from './settings-store';
import { ptyManager } from './pty-manager';

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

    try {
      const silent = settings.notificationSound !== 'default';
      const notif = new Notification({
        title: baseTitle,
        body,
        icon: getNotificationIcon(),
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
        // Demande au renderer de switcher sur la session+pane émetteur. Sans
        // ça l'user atterrit sur la session active courante, pas celle qui a
        // crié — ce qui annule le bénéfice de la notif en multi-agent.
        if (ctx.sessionId) {
          safeSend(IPC.sessionFocusRequest, ctx.sessionId, event.paneId);
        }
      });
      notif.show();
      if (settings.notificationSound === 'custom' && settings.notificationSoundPath) {
        safeSend(IPC.notifPlaySound, settings.notificationSoundPath);
      }
    } catch (err) {
      log.warn('[notif] failed to show', err);
    }
  }

  return { notifyAttention, notifyEvent };
}
