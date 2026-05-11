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

/**
 * Tous les raccourcis globaux de l'application. Extrait d'App.tsx pour
 * cloisonner ~140 lignes de switch clavier.
 *
 * Court-circuit : si un dialog/overlay est déjà ouvert, on ne déclenche
 * PAS les raccourcis globaux (sauf Escape). Évite l'ouverture de 2 dialogs
 * en parallèle (ex: Ctrl+K dans Settings ouvrait la palette par-dessus).
 */
export function useGlobalKeybindings({
  sessions,
  activeSessionId,
  dialogs,
  actions
}: Args): void {
  const toggleSync = useSessionStore((s) => s.toggleSync);
  const removeSession = useSessionStore((s) => s.removeSession);

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
    const onKey = (e: KeyboardEvent): void => {
      const dialogs = dialogsRef.current;
      const actions = actionsRef.current;
      const sessions = sessionsRef.current;
      const activeSessionId = activeSessionIdRef.current;

      const aDialogIsOpen =
        dialogs.newSessionOpen ||
        dialogs.settingsOpen ||
        dialogs.paletteOpen ||
        dialogs.shortcutsOpen ||
        dialogs.notifsOpen ||
        dialogs.snippetsOpen ||
        dialogs.closeConfirmOpen ||
        dialogs.onboardingOpen;
      if (aDialogIsOpen && e.key !== 'Escape') return;

      const ctrl = e.ctrlKey || e.metaKey;
      const session = sessions.find((s) => s.id === activeSessionId);
      const activePaneId = session?.activePaneId;

      if (ctrl && !e.shiftKey && e.key.toLowerCase() === 'n') {
        e.preventDefault();
        actions.setNewSessionOpen(true);
      } else if (ctrl && !e.shiftKey && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        actions.setPaletteOpen(true);
      } else if (ctrl && !e.shiftKey && e.key === '/') {
        e.preventDefault();
        actions.setSnippetsOpen(true);
      } else if (ctrl && !e.shiftKey && e.key.toLowerCase() === 'b') {
        // Toggle sidebar (style VS Code).
        e.preventDefault();
        actions.toggleSidebar();
      } else if (ctrl && !e.shiftKey && /^[1-9]$/.test(e.key)) {
        // Ctrl+1..9 → switche à la Nème session.
        const idx = parseInt(e.key, 10) - 1;
        if (sessions[idx]) {
          e.preventDefault();
          useSessionStore.getState().setActiveSession(sessions[idx].id);
        }
      } else if (
        e.key === '?' &&
        !ctrl &&
        !dialogs.newSessionOpen &&
        !dialogs.settingsOpen &&
        !dialogs.paletteOpen
      ) {
        // ? = ouvrir l'overlay de raccourcis (uniquement si on n'est pas déjà
        // dans un dialog ou un input — couvre contenteditable + role=textbox).
        const ae = document.activeElement as HTMLElement | null;
        const inInput =
          !!ae &&
          (ae.tagName === 'INPUT' ||
            ae.tagName === 'TEXTAREA' ||
            ae.tagName === 'CANVAS' ||
            ae.isContentEditable === true ||
            ae.getAttribute('role') === 'textbox');
        if (!inInput) {
          e.preventDefault();
          actions.setShortcutsOpen(true);
        }
      } else if (ctrl && e.shiftKey && e.key.toLowerCase() === 's' && session) {
        e.preventDefault();
        toggleSync(session.id);
      } else if (ctrl && !e.shiftKey && e.key === ',') {
        e.preventDefault();
        actions.setSettingsOpen(true);
      } else if (ctrl && e.shiftKey && e.key.toLowerCase() === 'd' && session && activePaneId) {
        // "Add pane" — ajoute un terminal ET retile en grid 2D auto.
        e.preventDefault();
        void window.cmux.panes
          .split({
            sessionId: session.id,
            paneId: activePaneId,
            direction: 'horizontal'
          })
          .then(() => window.cmux.panes.relayout(session.id, 'tiled'));
      } else if (ctrl && e.shiftKey && e.key.toLowerCase() === 'e' && session && activePaneId) {
        // Split vertical manuel (sans retile — pour layout custom).
        e.preventDefault();
        void window.cmux.panes.split({
          sessionId: session.id,
          paneId: activePaneId,
          direction: 'vertical'
        });
      } else if (ctrl && !e.shiftKey && e.key.toLowerCase() === 'g' && session) {
        // Re-tile la session courante en grid auto.
        e.preventDefault();
        void window.cmux.panes.relayout(session.id, 'tiled');
      } else if (ctrl && e.shiftKey && e.key.toLowerCase() === 'w' && session && activePaneId) {
        // Ferme le pane actif.
        e.preventDefault();
        void window.cmux.panes.close(session.id, activePaneId);
      } else if (ctrl && !e.shiftKey && e.key.toLowerCase() === 'w' && activeSessionId) {
        // Ferme la session entière — avec confirmation si un agent tourne.
        e.preventDefault();
        const sess = sessions.find((s) => s.id === activeSessionId);
        const hasRunning = sess
          ? Object.values(sess.panes).some(
              (p) => p.kind === 'terminal' && (p.status === 'running' || p.status === 'starting')
            )
          : false;
        if (hasRunning && sess) {
          actions.setCloseConfirm({ sessionId: sess.id, name: sess.name });
        } else if (sess) {
          void window.cmux.sessions.remove(sess.id);
          removeSession(sess.id);
        }
      } else if (e.altKey && session && activePaneId) {
        const dir =
          e.key === 'ArrowLeft'
            ? 'left'
            : e.key === 'ArrowRight'
              ? 'right'
              : e.key === 'ArrowUp'
                ? 'up'
                : e.key === 'ArrowDown'
                  ? 'down'
                  : null;
        if (dir) {
          e.preventDefault();
          const target = neighborInDirection(session.tree, activePaneId, dir);
          if (target) void window.cmux.panes.focus(session.id, target);
        }
      } else if (e.key === 'Escape') {
        if (dialogs.shortcutsOpen) actions.setShortcutsOpen(false);
        else if (dialogs.snippetsOpen) actions.setSnippetsOpen(false);
        else if (dialogs.notifsOpen) actions.setNotifsOpen(false);
        else if (dialogs.paletteOpen) actions.setPaletteOpen(false);
        else if (dialogs.newSessionOpen) actions.setNewSessionOpen(false);
        else if (dialogs.settingsOpen) actions.setSettingsOpen(false);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
    // Deps minimal — sessions/activeSessionId/dialogs/actions lus via refs.
    // toggleSync/removeSession sont des actions Zustand stables par référence.
  }, [removeSession, toggleSync]);
}
