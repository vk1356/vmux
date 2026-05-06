import type { JSX } from 'react';
import { X, Keyboard } from 'lucide-react';
import { useT, type TKey } from '../i18n';

interface Props {
  open: boolean;
  onClose: () => void;
}

interface ShortcutSpec {
  keys: string;
  labelKey: TKey;
}

interface GroupSpec {
  titleKey: TKey;
  items: ShortcutSpec[];
}

const GROUPS: GroupSpec[] = [
  {
    titleKey: 'shortcutsGroupSessions',
    items: [
      { keys: 'Ctrl+N', labelKey: 'shortcutsItemNewSession' },
      { keys: 'Ctrl+W', labelKey: 'shortcutsItemCloseSession' },
      { keys: 'Ctrl+K', labelKey: 'shortcutsItemPalette' },
      { keys: 'Ctrl+,', labelKey: 'shortcutsItemSettings' }
    ]
  },
  {
    titleKey: 'shortcutsGroupPanes',
    items: [
      { keys: 'Ctrl+Shift+D', labelKey: 'shortcutsItemAddPane' },
      { keys: 'Ctrl+Shift+E', labelKey: 'shortcutsItemSplitVertical' },
      { keys: 'Ctrl+Shift+W', labelKey: 'shortcutsItemClosePane' },
      { keys: 'Ctrl+G', labelKey: 'shortcutsItemRetile' },
      { keys: 'Alt+←/→/↑/↓', labelKey: 'shortcutsItemNavigatePanes' },
      { keys: 'Ctrl+Shift+S', labelKey: 'shortcutsItemSyncInput' }
    ]
  },
  {
    titleKey: 'shortcutsGroupTerminal',
    items: [
      { keys: 'Ctrl+Shift+F', labelKey: 'shortcutsItemSearchPane' },
      { keys: 'shortcutsItemDragFile', labelKey: 'shortcutsItemInsertPath' },
      { keys: 'shortcutsItemPasteButton', labelKey: 'shortcutsItemPasteHint' }
    ]
  },
  {
    titleKey: 'shortcutsGroupShellEdit',
    items: [
      { keys: 'Ctrl+A / Home', labelKey: 'shortcutsItemHomeKey' },
      { keys: 'Ctrl+E / End', labelKey: 'shortcutsItemEndKey' },
      { keys: 'Ctrl+W', labelKey: 'shortcutsItemDeleteWord' },
      { keys: 'Ctrl+U', labelKey: 'shortcutsItemDeleteHome' },
      { keys: 'Ctrl+K', labelKey: 'shortcutsItemDeleteEnd' },
      { keys: '↑ / ↓', labelKey: 'shortcutsItemHistory' }
    ]
  }
];

export function ShortcutsOverlay({ open, onClose }: Props): JSX.Element | null {
  const t = useT();
  if (!open) return null;
  return (
    <div className="dialog-backdrop" onClick={onClose}>
      <div className="shortcuts-overlay" onClick={(e) => e.stopPropagation()}>
        <div className="dialog-header">
          <div className="dialog-title">
            <Keyboard size={14} style={{ verticalAlign: '-2px', marginRight: 6 }} />
            {t('shortcutsTitle')}
          </div>
          <button className="btn-icon" onClick={onClose} aria-label={t('shortcutsClose')}>
            <X size={14} />
          </button>
        </div>
        <div className="shortcuts-grid">
          {GROUPS.map((g) => (
            <div key={g.titleKey} className="shortcuts-group">
              <div className="shortcuts-group-title">{t(g.titleKey)}</div>
              {g.items.map((s) => {
                // Cas spécial : pour la rangée "drag file" et "📋 button", la
                // colonne `keys` est elle-même une clé i18n (texte plutôt qu'un
                // raccourci). On détecte les `shortcutsItem*` pour traduire.
                const keysLabel = s.keys.startsWith('shortcutsItem')
                  ? t(s.keys as TKey)
                  : s.keys;
                return (
                  <div key={s.keys + s.labelKey} className="shortcut-row">
                    <span className="shortcut-keys">{keysLabel}</span>
                    <span className="shortcut-label">{t(s.labelKey)}</span>
                  </div>
                );
              })}
            </div>
          ))}
        </div>
        <div className="dialog-footer">
          <span className="hint">
            {t('shortcutsCloseHint', { q: '?', esc: 'Esc' })
              .split(/(\?|Esc)/)
              .map((part, i) =>
                part === '?' || part === 'Esc' ? <kbd key={i}>{part}</kbd> : <span key={i}>{part}</span>
              )}
          </span>
        </div>
      </div>
    </div>
  );
}
