import { useEffect, useRef, useState, type JSX } from 'react';
import { Send, X, AlignLeft } from 'lucide-react';
import type { Session, TerminalPane } from '@shared/types';
import { allPaneIds } from '@shared/tree';
import { useT } from '../i18n';

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

  // Liste des terminaux de la session pour le sélecteur de cible.
  const targets = session
    ? allPaneIds(session.tree)
        .map((id) => session.panes[id])
        .filter((p): p is TerminalPane => p?.kind === 'terminal')
    : [];

  useEffect(() => {
    if (!open) return;
    setText('');
    const active = session?.activePaneId;
    if (active && session?.panes[active]?.kind === 'terminal') {
      setTarget(active);
    } else if (targets[0]) {
      setTarget(targets[0].id);
    }
    requestAnimationFrame(() => taRef.current?.focus());
  }, [open, session?.activePaneId]);

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
    } else if (e.key === 'Escape') {
      e.preventDefault();
      onClose();
    }
  };

  return (
    <div className="dialog-backdrop" onClick={onClose}>
      <div className="compose" onClick={(e) => e.stopPropagation()}>
        <div className="compose-header">
          <div className="compose-title">
            <AlignLeft size={14} /> Compose
          </div>
          <button className="btn-icon" onClick={onClose} aria-label={t('settingsClose')}>
            <X size={14} />
          </button>
        </div>
        <div className="compose-target">
          <span className="field-label">{t('composeSendTo')}</span>
          <select
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
        <textarea
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
            <kbd>Ctrl+Enter</kbd> {t('composeSendHint')} · <kbd>Esc</kbd>{' '}
            {t('composeCancelHint')}
          </span>
          <button className="btn primary" onClick={send} disabled={!text.trim() || !target}>
            <Send size={13} /> {t('composeSendHint')}
          </button>
        </div>
      </div>
    </div>
  );
}
