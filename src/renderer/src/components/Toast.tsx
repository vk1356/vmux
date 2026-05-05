import { useEffect, type JSX } from 'react';
import { Globe, Rocket, CheckCircle2, XCircle, FlaskConical, Sparkles, X } from 'lucide-react';
import type { DetectedEventKind } from '@shared/types';
import { useSessionStore, type ToastItem } from '../store/sessions';

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
              Ouvrir le preview
            </button>
            <button
              className="btn ghost"
              onClick={() => {
                if (toast.url) void window.cmux.dialog.openExternal(toast.url);
                onClose();
              }}
            >
              Dans le navigateur
            </button>
          </div>
        )}
      </div>
      <button className="btn-icon toast-close" onClick={onClose} aria-label="Fermer">
        <X size={12} />
      </button>
    </div>
  );
}

function iconFor(t: ToastItem): JSX.Element {
  if (t.kind === 'url') return <Globe size={16} />;
  // Pour les events, on encode le kind dans le `body` ou via une convention.
  // Ici on infère via le title.
  const title = t.title.toLowerCase();
  if (title.includes('serveur')) return <Rocket size={16} color="#22c55e" />;
  if (title.includes('build réussi') || title.includes('terminé')) return <CheckCircle2 size={16} color="#22c55e" />;
  if (title.includes('erreur') || title.includes('failed')) return <XCircle size={16} color="#ef4444" />;
  if (title.includes('test')) return <FlaskConical size={16} color="#3b82f6" />;
  return <Sparkles size={16} />;
}

export function eventTitleFor(kind: DetectedEventKind): string {
  switch (kind) {
    case 'server-ready':
      return '🚀 Serveur prêt';
    case 'build-success':
      return '✓ Build réussi';
    case 'build-error':
      return '✗ Build en erreur';
    case 'test-results':
      return '🧪 Tests terminés';
    case 'agent-done':
      return '✓ Agent terminé';
  }
}
