import { useEffect, useState, type JSX } from 'react';
import {
  Sparkles,
  Layers,
  Globe,
  GitBranch,
  Bot,
  Zap,
  Bell,
  ArrowRight
} from 'lucide-react';

interface Props {
  onNewSession: () => void;
}

interface Feature {
  icon: JSX.Element;
  title: string;
  body: string;
}

const FEATURES: Feature[] = [
  {
    icon: <Layers size={16} />,
    title: 'Splits tmux-like',
    body: 'Découpe horizontalement, verticalement, ou auto-tile en grille 2D — un raccourci.'
  },
  {
    icon: <Globe size={16} />,
    title: 'Preview localhost',
    body: 'URL détectée → preview embarqué dans la fenêtre, sans quitter ton flow.'
  },
  {
    icon: <GitBranch size={16} />,
    title: 'Worktrees git',
    body: 'Chaque agent dans son propre worktree — branches isolées, zéro collision.'
  },
  {
    icon: <Bot size={16} />,
    title: 'Multi-agents',
    body: 'Claude Code, Codex, Aider, Cursor, Gemini — tous gérés depuis la même fenêtre.'
  },
  {
    icon: <Bell size={16} />,
    title: 'Notifications natives',
    body: "Push Windows + flash taskbar quand l'agent demande une action en background."
  },
  {
    icon: <Zap size={16} />,
    title: 'PTY natif ConPTY',
    body: 'Terminal Windows natif via node-pty — performances et compatibilité shell.'
  }
];

export function EmptyState({ onNewSession }: Props): JSX.Element {
  const [version, setVersion] = useState<string>('');
  useEffect(() => {
    void window.cmux.app?.version().then(setVersion);
  }, []);

  return (
    <div className="hero">
      <div className="hero-bg" aria-hidden />

      <div className="hero-content">
        <div className="hero-mark-wrap" aria-hidden>
          <div className="hero-mark-glow" />
          <div className="hero-mark">
            <svg viewBox="0 0 24 24" width="36" height="36" fill="none" aria-hidden>
              <path
                d="M5 6 L11.5 18 L18 6"
                stroke="#1a0a00"
                strokeWidth="2.8"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
          </div>
        </div>

        <div className="hero-eyebrow">
          <span className="hero-dot" /> orchestrateur multi-agents IA
        </div>

        <h1 className="hero-title">
          Plusieurs agents IA, <span className="hero-title-accent">une seule fenêtre.</span>
        </h1>
        <p className="hero-lead">
          vMux orchestre Claude Code, Codex, Aider et bien d'autres en parallèle — chacun
          dans son propre worktree git. Aucune collision de branche, juste des agents qui
          bossent en silence.
        </p>

        <div className="hero-cta">
          <button className="btn primary hero-cta-primary" onClick={onNewSession}>
            <Sparkles size={14} />
            Nouvelle session
            <ArrowRight size={14} />
          </button>
          <span className="hero-cta-hint">
            ou tape <span className="kbd-inline">Ctrl+N</span>
          </span>
        </div>

        <div className="hero-features">
          {FEATURES.map((f) => (
            <div key={f.title} className="hero-feature-card">
              <div className="hero-feature-icon">{f.icon}</div>
              <div className="hero-feature-title">{f.title}</div>
              <div className="hero-feature-body">{f.body}</div>
            </div>
          ))}
        </div>

        <div className="hero-shortcuts">
          <ShortcutHint k="Ctrl+N" label="Nouvelle session" />
          <span className="hero-sep" />
          <ShortcutHint k="Ctrl+Shift+D" label="Ajouter un pane" />
          <span className="hero-sep" />
          <ShortcutHint k="Ctrl+G" label="Re-tile" />
          <span className="hero-sep" />
          <ShortcutHint k="Ctrl+P" label="Palette" />
          <span className="hero-sep" />
          <ShortcutHint k="Ctrl+,"  label="Paramètres" />
        </div>

        <div className="hero-meta">
          <span>vMux {version || ''}</span>
          <span className="hero-meta-sep" />
          <a
            className="hero-meta-link"
            onClick={() =>
              window.cmux.dialog.openExternal('https://github.com/vk1356/vmux')
            }
          >
            github.com/vk1356/vmux
          </a>
        </div>
      </div>
    </div>
  );
}

function ShortcutHint({ k, label }: { k: string; label: string }): JSX.Element {
  return (
    <span className="hero-shortcut">
      <span className="kbd-inline">{k}</span>
      <span className="hero-shortcut-label">{label}</span>
    </span>
  );
}
