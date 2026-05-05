import type { JSX } from 'react';
import { Sparkles, Layers, Globe, GitBranch } from 'lucide-react';

interface Props {
  onNewSession: () => void;
}

export function EmptyState({ onNewSession }: Props): JSX.Element {
  return (
    <div className="empty">
      <div className="empty-mark">
        <svg viewBox="0 0 24 24" width="32" height="32" fill="none" aria-hidden>
          <path
            d="M5 6 L11.5 18 L18 6"
            stroke="#1a0a00"
            strokeWidth="2.8"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      </div>
      <div>
        <h1>Lance ton premier agent</h1>
        <p>
          vMux orchestre plusieurs agents IA en parallèle, chacun dans son propre git worktree.
          Aucune collision de branche, aucun conflit, juste des agents qui bossent en silence.
        </p>
      </div>

      <div className="empty-features">
        <div className="empty-feature">
          <Layers size={14} />
          Splits tmux-like + auto-tile en grid 2D
        </div>
        <div className="empty-feature">
          <Globe size={14} />
          Preview localhost détecté + embarqué
        </div>
        <div className="empty-feature">
          <GitBranch size={14} />
          Git worktrees éphémères par agent
        </div>
      </div>

      <button className="btn primary" onClick={onNewSession}>
        <Sparkles size={14} />
        Nouvelle session
      </button>
      <div className="empty-shortcuts">
        <span className="kbd">Ctrl+N</span>
        <span style={{ fontSize: 11 }}>Nouvelle session</span>
        <span className="kbd">Ctrl+Shift+D</span>
        <span style={{ fontSize: 11 }}>Ajouter un pane</span>
        <span className="kbd">Ctrl+G</span>
        <span style={{ fontSize: 11 }}>Re-tile</span>
      </div>
    </div>
  );
}
