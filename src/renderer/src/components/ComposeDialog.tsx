import { useEffect, useId, useMemo, useRef, useState, type JSX } from 'react';
import { Send, X, AlignLeft } from 'lucide-react';
import type { Session, TerminalPane } from '@shared/types';
import { allPaneIds } from '@shared/tree';
import { useT } from '../i18n';

ensureDialogBackdropStyle();

interface Props {
  open: boolean;
  session: Session | null;
  onClose: () => void;
}

/** Compose mode : un textarea pleine page pour écrire/éditer un message
 *  multi-ligne. À l'envoi : on écrit dans le PTY actif avec \r entre lignes. */
export function ComposeDialog({ open, session, onClose }: Props): JSX.Element | null {
  const t = useT();
  const [text, setText] = useState('');
  const [target, setTarget] = useState<string>('');
  const taRef = useRef<HTMLTextAreaElement>(null);
  const dialogRef = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  const targetSelectId = useId();
  const textareaId = useId();

  // Liste des terminaux de la session — mémoïsée pour stable identity.
  const targets = useMemo(
    () =>
      session
        ? allPaneIds(session.tree)
            .map((id) => session.panes[id])
            .filter((p): p is TerminalPane => p?.kind === 'terminal')
        : [],
    [session]
  );

  useEffect(() => {
    const d = dialogRef.current;
    if (!d) return;
    if (open && !d.open) {
      d.showModal();
      setText('');
      const active = session?.activePaneId;
      if (active && session?.panes[active]?.kind === 'terminal') {
        setTarget(active);
      } else if (targets[0]) {
        setTarget(targets[0].id);
      }
      requestAnimationFrame(() => taRef.current?.focus());
    } else if (!open && d.open) {
      d.close();
    }
  }, [open, session?.activePaneId, session?.panes, targets]);

  if (!open || !session) return null;

  const send = (): void => {
    if (!text.trim() || !target) return;
    // On envoie ligne par ligne : \r entre les lignes (Enter dans le PTY),
    // et un \r final pour valider la commande.
    const lines = text.replace(/\r\n/g, '\n').split('\n');
    const payload = lines.join('\r') + '\r';
    window.cmux.panes.write(target, payload);
    onClose();
  };

  const onKey = (e: React.KeyboardEvent<HTMLTextAreaElement>): void => {
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      send();
    }
    // Esc → native cancel event sur <dialog>.
  };

  const onBackdropClick = (e: React.MouseEvent<HTMLDialogElement>): void => {
    if (e.target === e.currentTarget) onClose();
  };

  return (
    <dialog
      ref={dialogRef}
      className="compose vmux-dialog"
      style={dialogResetStyle}
      onCancel={(e) => {
        e.preventDefault();
        onClose();
      }}
      onClick={onBackdropClick}
      aria-labelledby={titleId}
    >
      <div className="compose-header">
        <div className="compose-title" id={titleId}>
          <AlignLeft size={14} /> Compose
        </div>
        <button className="btn-icon" onClick={onClose} aria-label={t('settingsClose')}>
          <X size={14} />
        </button>
      </div>
      <div className="compose-target">
        <label htmlFor={targetSelectId} className="field-label">
          {t('composeSendTo')}
        </label>
        <select
          id={targetSelectId}
          className="select"
          value={target}
          onChange={(e) => setTarget(e.target.value)}
        >
          {targets.map((tp) => (
            <option key={tp.id} value={tp.id}>
              {tp.label || tp.agentId}{' '}
              {tp.id === session.activePaneId ? `(${t('statusActive')})` : ''}
            </option>
          ))}
        </select>
      </div>
      <label htmlFor={textareaId} className="sr-only" style={visuallyHidden}>
        {t('composePlaceholder')}
      </label>
      <textarea
        id={textareaId}
        ref={taRef}
        className="compose-textarea"
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={onKey}
        placeholder={t('composePlaceholder')}
        spellCheck={false}
      />
      <div className="compose-footer">
        <span className="hint">
          <kbd>Ctrl+Enter</kbd> {t('composeSendHint')} · <kbd>Esc</kbd> {t('composeCancelHint')}
        </span>
        <button className="btn primary" onClick={send} disabled={!text.trim() || !target}>
          <Send size={13} /> {t('composeSendHint')}
        </button>
      </div>
    </dialog>
  );
}

const dialogResetStyle: React.CSSProperties = {
  padding: 0,
  border: 0,
  background: 'transparent',
  maxWidth: 'unset',
  maxHeight: 'unset',
  overflow: 'visible',
  color: 'inherit'
};

const visuallyHidden: React.CSSProperties = {
  position: 'absolute',
  width: 1,
  height: 1,
  padding: 0,
  margin: -1,
  overflow: 'hidden',
  clip: 'rect(0,0,0,0)',
  whiteSpace: 'nowrap',
  border: 0
};

function ensureDialogBackdropStyle(): void {
  if (typeof document === 'undefined') return;
  const id = 'vmux-dialog-backdrop-style';
  if (document.getElementById(id)) return;
  const el = document.createElement('style');
  el.id = id;
  el.textContent = `
dialog.vmux-dialog { margin: auto; inset: 0; }
dialog.vmux-dialog::backdrop {
  background: rgba(0, 0, 0, 0.5);
  backdrop-filter: blur(4px);
  animation: vmuxDialogBackdropFadeIn 120ms ease-out;
}
@keyframes vmuxDialogBackdropFadeIn { from { opacity: 0; } }
`;
  document.head.appendChild(el);
}
