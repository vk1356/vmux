import { useEffect, useRef } from 'react';
import { useSessionStore } from '../store/sessions';
import { neighborInDirection } from '@shared/tree';
import type { Session } from '@shared/types';

interface DialogState {
  newSessionOpen: boolean;
  settingsOpen: boolean;
  paletteOpen: boolean;
  shortcutsOpen: boolean;
  notifsOpen: boolean;
  snippetsOpen: boolean;
  closeConfirmOpen: boolean;
  onboardingOpen: boolean;
}

interface DialogActions {
  setNewSessionOpen: (v: boolean) => void;
  setSettingsOpen: (v: boolean) => void;
  setPaletteOpen: (v: boolean) => void;
  setShortcutsOpen: (v: boolean) => void;
  setNotifsOpen: (v: boolean) => void;
  setSnippetsOpen: (v: boolean) => void;
  setCloseConfirm: (v: { sessionId: string; name: string } | null) => void;
  toggleSidebar: () => void;
}

interface Args {
  sessions: Session[];
  activeSessionId: string | null;
  dialogs: DialogState;
  actions: DialogActions;
}

/** True si l'élément actif est un input texte (covers contenteditable + role=textbox). */
function isInputLike(el: Element | null): boolean {
  if (!el) return false;
  const tag = el.tagName;
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'CANVAS') return true;
  if ((el as HTMLElement).isContentEditable === true) return true;
  return el.getAttribute('role') === 'textbox';
}

function anyDialogOpen(d: DialogState): boolean {
  return (
    d.newSessionOpen ||
    d.settingsOpen ||
    d.paletteOpen ||
    d.shortcutsOpen ||
    d.notifsOpen ||
    d.snippetsOpen ||
    d.closeConfirmOpen ||
    d.onboardingOpen
  );
}

function arrowKeyToDirection(key: string): 'left' | 'right' | 'up' | 'down' | null {
  switch (key) {
    case 'ArrowLeft':
      return 'left';
    case 'ArrowRight':
      return 'right';
    case 'ArrowUp':
      return 'up';
    case 'ArrowDown':
      return 'down';
    default:
      return null;
  }
}

/**
 * Tous les raccourcis globaux de l'application. Extrait d'App.tsx pour
 * cloisonner ~140 lignes de switch clavier.
 *
 * Court-circuit : si un dialog/overlay est déjà ouvert, on ne déclenche
 * PAS les raccourcis globaux (sauf Escape). Évite l'ouverture de 2 dialogs
 * en parallèle (ex: Ctrl+K dans Settings ouvrait la palette par-dessus).
 *
 * Single mount : le listener est attaché UNE fois (deps `[]`). Tous les
 * args dynamiques sont lus via refs live, et les actions Zustand via
 * `useSessionStore.getState()` (stables par référence Zustand 5).
 */
export function useGlobalKeybindings({
  sessions,
  activeSessionId,
  dialogs,
  actions
}: Args): void {
  // Refs live : sessions/activeSessionId/dialogs/actions sont des objets inline
  // créés à chaque render dans App.tsx, donc dep-array les inclure tearait
  // l'event listener à chaque render — fenêtre brève sans keybindings active +
  // overhead. On lit depuis les refs dans le handler stable.
  const sessionsRef = useRef(sessions);
  const activeSessionIdRef = useRef(activeSessionId);
  const dialogsRef = useRef(dialogs);
  const actionsRef = useRef(actions);
  sessionsRef.current = sessions;
  activeSessionIdRef.current = activeSessionId;
  dialogsRef.current = dialogs;
  actionsRef.current = actions;

  useEffect(() => {
    const ac = new AbortController();

    const onKey = (e: KeyboardEvent): void => {
      const dialogs = dialogsRef.current;
      const actions = actionsRef.current;
      const sessions = sessionsRef.current;
      const activeSessionId = activeSessionIdRef.current;

      if (anyDialogOpen(dialogs) && e.key !== 'Escape') return;

      const ctrl = e.ctrlKey || e.metaKey;
      const session = sessions.find((s) => s.id === activeSessionId);
      const activePaneId = session?.activePaneId;
      const key = e.key.toLowerCase();

      // === Ctrl-only ===
      if (ctrl && !e.shiftKey) {
        if (key === 'n') {
          e.preventDefault();
          actions.setNewSessionOpen(true);
          return;
        }
        if (key === 'k') {
          e.preventDefault();
          actions.setPaletteOpen(true);
          return;
        }
        if (e.key === '/') {
          e.preventDefault();
          actions.setSnippetsOpen(true);
          return;
        }
        if (key === 'b') {
          e.preventDefault();
          actions.toggleSidebar();
          return;
        }
        if (e.key === ',') {
          e.preventDefault();
          actions.setSettingsOpen(true);
          return;
        }
        if (key === 'g' && session) {
          e.preventDefault();
          void window.cmux.panes.relayout(session.id, 'tiled');
          return;
        }
        if (key === 'w' && activeSessionId) {
          // Ferme la session entière — avec confirmation si un agent tourne.
          e.preventDefault();
          const sess = sessions.find((s) => s.id === activeSessionId);
          if (!sess) return;
          const hasRunning = Object.values(sess.panes).some(
            (p) => p.kind === 'terminal' && (p.status === 'running' || p.status === 'starting')
          );
          if (hasRunning) {
            actions.setCloseConfirm({ sessionId: sess.id, name: sess.name });
          } else {
            const { removeSession } = useSessionStore.getState();
            void window.cmux.sessions.remove(sess.id);
            removeSession(sess.id);
          }
          return;
        }
        if (/^[1-9]$/.test(e.key)) {
          // Ctrl+1..9 → switche à la Nème session.
          const idx = parseInt(e.key, 10) - 1;
          if (sessions[idx]) {
            e.preventDefault();
            useSessionStore.getState().setActiveSession(sessions[idx].id);
          }
          return;
        }
      }

      // === Ctrl+Shift ===
      if (ctrl && e.shiftKey) {
        if (key === 's' && session) {
          e.preventDefault();
          useSessionStore.getState().toggleSync(session.id);
          return;
        }
        if (key === 'd' && session && activePaneId) {
          // "Add pane" — ajoute un terminal ET retile en grid 2D auto.
          e.preventDefault();
          void window.cmux.panes
            .split({ sessionId: session.id, paneId: activePaneId, direction: 'horizontal' })
            .then(() => window.cmux.panes.relayout(session.id, 'tiled'));
          return;
        }
        if (key === 'e' && session && activePaneId) {
          // Split vertical manuel (sans retile — pour layout custom).
          e.preventDefault();
          void window.cmux.panes.split({
            sessionId: session.id,
            paneId: activePaneId,
            direction: 'vertical'
          });
          return;
        }
        if (key === 'w' && session && activePaneId) {
          e.preventDefault();
          void window.cmux.panes.close(session.id, activePaneId);
          return;
        }
      }

      // === Alt+arrow → focus pane voisin ===
      if (e.altKey && session && activePaneId) {
        const dir = arrowKeyToDirection(e.key);
        if (dir) {
          e.preventDefault();
          const target = neighborInDirection(session.tree, activePaneId, dir);
          if (target) void window.cmux.panes.focus(session.id, target);
          return;
        }
      }

      // === '?' = overlay raccourcis (hors input/dialog) ===
      if (
        e.key === '?' &&
        !ctrl &&
        !dialogs.newSessionOpen &&
        !dialogs.settingsOpen &&
        !dialogs.paletteOpen &&
        !isInputLike(document.activeElement)
      ) {
        e.preventDefault();
        actions.setShortcutsOpen(true);
        return;
      }

      // === Escape : ferme le dialog le plus haut ===
      if (e.key === 'Escape') {
        if (dialogs.shortcutsOpen) actions.setShortcutsOpen(false);
        else if (dialogs.snippetsOpen) actions.setSnippetsOpen(false);
        else if (dialogs.notifsOpen) actions.setNotifsOpen(false);
        else if (dialogs.paletteOpen) actions.setPaletteOpen(false);
        else if (dialogs.newSessionOpen) actions.setNewSessionOpen(false);
        else if (dialogs.settingsOpen) actions.setSettingsOpen(false);
      }
    };

    window.addEventListener('keydown', onKey, { signal: ac.signal });
    return () => ac.abort();
    // Mount-once : tous les args dynamiques passent par refs ; actions Zustand
    // (removeSession/toggleSync/setActiveSession) lues via getState() — stables.
  }, []);
}
