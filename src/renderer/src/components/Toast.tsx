import { useEffect, type JSX } from 'react';
import { Globe, Rocket, CheckCircle2, XCircle, FlaskConical, Sparkles, Bell, X } from 'lucide-react';
import type { DetectedEventKind } from '@shared/types';
import { useSessionStore, type ToastItem } from '../store/sessions';
import { translate, useT } from '../i18n';
import type { Lang } from '@shared/types';

const TOAST_TIMEOUT = 6000;

export function ToastContainer(): JSX.Element {
  const toasts = useSessionStore((s) => s.toasts);
  const removeToast = useSessionStore((s) => s.removeToast);

  return (
    <div className="toast-container">
      {toasts.map((t) => (
        <Toast key={t.id} toast={t} onClose={() => removeToast(t.id)} />
      ))}
    </div>
  );
}

interface Props {
  toast: ToastItem;
  onClose: () => void;
}

function Toast({ toast, onClose }: Props): JSX.Element {
  const t = useT();
  useEffect(() => {
    const handle = window.setTimeout(onClose, TOAST_TIMEOUT);
    return () => window.clearTimeout(handle);
  }, [onClose]);

  return (
    <div className={`toast toast-${toast.kind}`}>
      <div className="toast-icon">{iconFor(toast)}</div>
      <div className="toast-body">
        <div className="toast-title">{toast.title}</div>
        {toast.body && <div className="toast-sub">{toast.body}</div>}
        {toast.kind === 'url' && toast.url && toast.sessionId && toast.paneId && (
          <div className="toast-actions">
            <button
              className="btn primary"
              onClick={() => {
                if (!toast.sessionId || !toast.paneId || !toast.url) return;
                void window.cmux.panes.openPreview(toast.sessionId, toast.paneId, toast.url);
                onClose();
              }}
            >
              {t('toastOpenPreview')}
            </button>
            <button
              className="btn ghost"
              onClick={() => {
                if (toast.url) void window.cmux.dialog.openExternal(toast.url);
                onClose();
              }}
            >
              {t('toastInBrowser')}
            </button>
          </div>
        )}
      </div>
      <button className="btn-icon toast-close" onClick={onClose} aria-label={t('toastClose')}>
        <X size={12} />
      </button>
    </div>
  );
}

function iconFor(t: ToastItem): JSX.Element {
  if (t.kind === 'url') return <Globe size={16} />;
  // Pour les events, on utilise `eventKind` (fiable, language-agnostic) plutôt
  // qu'inférer via le texte du titre traduit.
  switch (t.eventKind) {
    case 'server-ready':
      return <Rocket size={16} color="#22c55e" />;
    case 'build-success':
    case 'agent-done':
      return <CheckCircle2 size={16} color="#22c55e" />;
    case 'build-error':
      return <XCircle size={16} color="#ef4444" />;
    case 'test-results':
      return <FlaskConical size={16} color="#3b82f6" />;
    case 'notify':
      return <Bell size={16} color="#f97316" />;
    default:
      return <Sparkles size={16} />;
  }
}

/** Renvoie le titre traduit d'un event détecté. Appelé depuis App.tsx au moment
 *  où on push un toast — la lang est lue dans le store via translate(). */
export function eventTitleFor(kind: DetectedEventKind, lang: Lang = 'en'): string {
  switch (kind) {
    case 'server-ready':
      return `🚀 ${translate(lang, 'notifKindServerReady')}`;
    case 'build-success':
      return `✓ ${translate(lang, 'notifKindBuildSuccess')}`;
    case 'build-error':
      return `✗ ${translate(lang, 'notifKindBuildError')}`;
    case 'test-results':
      return `🧪 ${translate(lang, 'notifKindTests')}`;
    case 'agent-done':
      return `✓ ${translate(lang, 'notifKindAgentDone')}`;
    case 'notify':
      return `🔔 ${translate(lang, 'notifKindNotify')}`;
  }
}
