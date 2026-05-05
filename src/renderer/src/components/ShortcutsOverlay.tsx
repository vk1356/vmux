import type { JSX } from 'react';
import { X, Keyboard } from 'lucide-react';

interface Props {
  open: boolean;
  onClose: () => void;
}

interface Shortcut {
  keys: string;
  label: string;
}

interface Group {
  title: string;
  items: Shortcut[];
}

const GROUPS: Group[] = [
  {
    title: 'Sessions',
    items: [
      { keys: 'Ctrl+N', label: 'Nouvelle session' },
      { keys: 'Ctrl+W', label: 'Fermer la session active' },
      { keys: 'Ctrl+K', label: 'Command palette' },
      { keys: 'Ctrl+,', label: 'Paramètres' }
    ]
  },
  {
    title: 'Panes',
    items: [
      { keys: 'Ctrl+Shift+D', label: 'Ajouter un pane (auto-tile)' },
      { keys: 'Ctrl+Shift+E', label: 'Split vertical manuel' },
      { keys: 'Ctrl+Shift+W', label: 'Fermer le pane focusé' },
      { keys: 'Ctrl+G', label: 'Re-tiler la session' },
      { keys: 'Alt+←/→/↑/↓', label: 'Naviguer entre panes' },
      { keys: 'Ctrl+Shift+S', label: 'Toggle sync input (broadcast)' }
    ]
  },
  {
    title: 'Terminal',
    items: [
      { keys: 'Ctrl+Shift+F', label: 'Recherche dans le pane' },
      { keys: 'Glisser fichier', label: 'Insère le chemin du fichier' },
      { keys: 'Bouton 📋', label: 'Coller image ou texte du clipboard' }
    ]
  },
  {
    title: 'Édition shell (PSReadLine)',
    items: [
      { keys: 'Ctrl+A / Home', label: 'Début de ligne' },
      { keys: 'Ctrl+E / End', label: 'Fin de ligne' },
      { keys: 'Ctrl+W', label: 'Supprimer le mot précédent' },
      { keys: 'Ctrl+U', label: 'Supprimer jusqu\'au début' },
      { keys: 'Ctrl+K', label: 'Supprimer jusqu\'à la fin' },
      { keys: '↑ / ↓', label: 'Historique commandes' }
    ]
  }
];

export function ShortcutsOverlay({ open, onClose }: Props): JSX.Element | null {
  if (!open) return null;
  return (
    <div className="dialog-backdrop" onClick={onClose}>
      <div className="shortcuts-overlay" onClick={(e) => e.stopPropagation()}>
        <div className="dialog-header">
          <div className="dialog-title">
            <Keyboard size={14} style={{ verticalAlign: '-2px', marginRight: 6 }} />
            Raccourcis clavier
          </div>
          <button className="btn-icon" onClick={onClose} aria-label="Fermer">
            <X size={14} />
          </button>
        </div>
        <div className="shortcuts-grid">
          {GROUPS.map((g) => (
            <div key={g.title} className="shortcuts-group">
              <div className="shortcuts-group-title">{g.title}</div>
              {g.items.map((s) => (
                <div key={s.keys + s.label} className="shortcut-row">
                  <span className="shortcut-keys">{s.keys}</span>
                  <span className="shortcut-label">{s.label}</span>
                </div>
              ))}
            </div>
          ))}
        </div>
        <div className="dialog-footer">
          <span className="hint">
            <kbd>?</kbd> ou <kbd>Esc</kbd> pour fermer
          </span>
        </div>
      </div>
    </div>
  );
}
