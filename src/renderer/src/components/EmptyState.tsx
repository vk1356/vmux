import { useEffect, useState, type JSX } from 'react';
import {
  Rocket,
  Layers,
  Globe,
  GitBranch,
  Bot,
  Zap,
  Bell,
  ArrowRight
} from 'lucide-react';
import { useT, type TKey } from '../i18n';

interface Props {
  onNewSession: () => void;
}

interface Feature {
  icon: JSX.Element;
  titleKey: TKey;
  bodyKey: TKey;
}

const FEATURES: Feature[] = [
  {
    icon: <Layers size={16} />,
    titleKey: 'heroFeatureSplitsTitle',
    bodyKey: 'heroFeatureSplitsBody'
  },
  {
    icon: <Globe size={16} />,
    titleKey: 'heroFeaturePreviewTitle',
    bodyKey: 'heroFeaturePreviewBody'
  },
  {
    icon: <GitBranch size={16} />,
    titleKey: 'heroFeatureWorktreesTitle',
    bodyKey: 'heroFeatureWorktreesBody'
  },
  {
    icon: <Bot size={16} />,
    titleKey: 'heroFeatureMultiAgentTitle',
    bodyKey: 'heroFeatureMultiAgentBody'
  },
  {
    icon: <Bell size={16} />,
    titleKey: 'heroFeatureNotifsTitle',
    bodyKey: 'heroFeatureNotifsBody'
  },
  {
    icon: <Zap size={16} />,
    titleKey: 'heroFeaturePtyTitle',
    bodyKey: 'heroFeaturePtyBody'
  }
];

export function EmptyState({ onNewSession }: Props): JSX.Element {
  const t = useT();
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
          <span className="hero-dot" /> {t('appTagline')}
        </div>

        <h1 className="hero-title">
          {t('heroTitleA')}{' '}
          <span className="hero-title-accent">{t('heroTitleB')}</span>
        </h1>
        <p className="hero-lead">{t('heroLead')}</p>

        <div className="hero-cta">
          <button className="btn primary hero-cta-primary" onClick={onNewSession}>
            <Rocket size={14} />
            {t('heroCta')}
            <ArrowRight size={14} />
          </button>
          <span className="hero-cta-hint">
            {t('heroCtaHint')} <span className="kbd-inline">Ctrl+N</span>
          </span>
        </div>

        <div className="hero-features">
          {FEATURES.map((f) => (
            <div key={f.titleKey} className="hero-feature-card">
              <div className="hero-feature-icon">{f.icon}</div>
              <div className="hero-feature-title">{t(f.titleKey)}</div>
              <div className="hero-feature-body">{t(f.bodyKey)}</div>
            </div>
          ))}
        </div>

        <div className="hero-shortcuts">
          <ShortcutHint k="Ctrl+N" label={t('shortcutNewSession')} />
          <span className="hero-sep" />
          <ShortcutHint k="Ctrl+Shift+D" label={t('shortcutAddPane')} />
          <span className="hero-sep" />
          <ShortcutHint k="Ctrl+G" label={t('shortcutRetile')} />
          <span className="hero-sep" />
          <ShortcutHint k="Ctrl+P" label={t('shortcutPalette')} />
          <span className="hero-sep" />
          <ShortcutHint k="Ctrl+,"  label={t('shortcutSettings')} />
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
