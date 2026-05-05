import { useEffect, useRef, type JSX } from 'react';
import { AlertTriangle, X } from 'lucide-react';

interface Props {
  open: boolean;
  title: string;
  message: string;
  confirmLabel?: string;
  cancelLabel?: string;
  danger?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}

export function ConfirmDialog({
  open,
  title,
  message,
  confirmLabel = 'Confirmer',
  cancelLabel = 'Annuler',
  danger = false,
  onConfirm,
  onCancel
}: Props): JSX.Element | null {
  const cancelRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (open) requestAnimationFrame(() => cancelRef.current?.focus());
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        e.preventDefault();
        onCancel();
      } else if (e.key === 'Enter') {
        e.preventDefault();
        onConfirm();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onCancel, onConfirm]);

  if (!open) return null;

  return (
    <div className="dialog-backdrop" onClick={onCancel}>
      <div
        className="dialog confirm-dialog"
        onClick={(e) => e.stopPropagation()}
        role="alertdialog"
      >
        <div className="dialog-header">
          <div className="dialog-title">
            <AlertTriangle
              size={14}
              style={{ verticalAlign: '-2px', marginRight: 6, color: 'var(--warn)' }}
            />
            {title}
          </div>
          <button className="btn-icon" onClick={onCancel} aria-label="Fermer">
            <X size={14} />
          </button>
        </div>
        <div className="dialog-body">
          <p style={{ margin: 0, color: 'var(--text-muted)', lineHeight: 1.5 }}>{message}</p>
        </div>
        <div className="dialog-footer">
          <button ref={cancelRef} className="btn ghost" onClick={onCancel}>
            {cancelLabel}
          </button>
          <button
            className={`btn ${danger ? 'danger' : 'primary'}`}
            onClick={onConfirm}
          >
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
