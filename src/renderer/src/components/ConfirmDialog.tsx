import { useEffect, useId, useRef, type JSX } from 'react';
import { AlertTriangle, X } from 'lucide-react';

// Injection idempotente du style ::backdrop (blur + fade) — on ne touche pas
// au CSS du repo (hors scope), on attache ce style depuis JS au 1er import.
ensureDialogBackdropStyle();

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

/**
 * ConfirmDialog — native <dialog> + showModal().
 *
 * Pourquoi le natif : Chromium gère focus-trap, restore-focus à l'opener,
 * Esc → `cancel`, inerte du reste de la page, top layer (au-dessus de tout
 * peu importe le z-index ancestor). On retire useFocusTrap entièrement.
 */
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
  const titleId = useId();
  const ref = useRef<HTMLDialogElement>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);

  // Drive open/close via showModal()/close().
  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (open && !d.open) {
      d.showModal();
      // Focus cancel par défaut (UX : Enter = confirm, mais focus initial sûr).
      requestAnimationFrame(() => cancelRef.current?.focus());
    } else if (!open && d.open) {
      d.close();
    }
  }, [open]);

  // Enter = confirm. Esc est natif (déclenche `cancel` event → onCancel).
  useEffect(() => {
    if (!open) return;
    const d = ref.current;
    if (!d) return;
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Enter') {
        e.preventDefault();
        onConfirm();
      }
    };
    d.addEventListener('keydown', onKey);
    return () => d.removeEventListener('keydown', onKey);
  }, [open, onConfirm]);

  if (!open) return null;

  // Clic sur backdrop : avec <dialog>, clics sur ::backdrop ciblent l'élément
  // dialog lui-même (pas un enfant). On checke target === currentTarget.
  const onBackdropClick = (e: React.MouseEvent<HTMLDialogElement>): void => {
    if (e.target === e.currentTarget) onCancel();
  };

  return (
    <dialog
      ref={ref}
      className="dialog confirm-dialog vmux-dialog"
      style={dialogResetStyle}
      onCancel={(e) => {
        e.preventDefault(); // empêche fermeture native sans appel parent
        onCancel();
      }}
      onClick={onBackdropClick}
      aria-labelledby={titleId}
    >
      <div className="dialog-header">
        <div className="dialog-title" id={titleId}>
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
        <button className={`btn ${danger ? 'danger' : 'primary'}`} onClick={onConfirm}>
          {confirmLabel}
        </button>
      </div>
    </dialog>
  );
}

/** Reset des styles UA du <dialog>. */
const dialogResetStyle: React.CSSProperties = {
  padding: 0,
  border: 0,
  background: 'transparent',
  maxWidth: 'unset',
  maxHeight: 'unset',
  overflow: 'visible',
  color: 'inherit'
};

/**
 * Injecte une fois `dialog.vmux-dialog::backdrop { … }` dans le head pour
 * conserver le visuel blur + fade qu'on avait avec .dialog-backdrop.
 *
 * Idempotent : guard par id sur l'élément <style>. Safe en SSR (no-op si
 * pas de document) et en re-render React (module-level mais wrappé en func).
 */
function ensureDialogBackdropStyle(): void {
  if (typeof document === 'undefined') return;
  const id = 'vmux-dialog-backdrop-style';
  if (document.getElementById(id)) return;
  const el = document.createElement('style');
  el.id = id;
  el.textContent = `
dialog.vmux-dialog {
  /* dialog est par défaut display:block, mais aussi positionné absolument
     en top-layer quand showModal(). Reset margin auto pour centrer. */
  margin: auto;
  inset: 0;
}
dialog.vmux-dialog::backdrop {
  background: rgba(0, 0, 0, 0.5);
  backdrop-filter: blur(4px);
  animation: vmuxDialogBackdropFadeIn 120ms ease-out;
}
@keyframes vmuxDialogBackdropFadeIn { from { opacity: 0; } }
`;
  document.head.appendChild(el);
}
