import { useCallback, useEffect, useState, type JSX } from 'react';
import { ArrowLeft, ArrowRight, Bot, GitBranch, Globe, Keyboard, Rocket, X } from 'lucide-react';
import { useT } from '../i18n';
import type { TKey } from '../i18n';

interface Props {
  open: boolean;
  onClose: (completed: boolean) => void;
}

interface Step {
  icon: JSX.Element;
  titleKey: TKey;
  bodyKey: TKey;
}

const STEPS: Step[] = [
  { icon: <Rocket size={28} />, titleKey: 'onboardingWelcomeTitle', bodyKey: 'onboardingWelcomeBody' },
  { icon: <Bot size={28} />, titleKey: 'onboardingAgentsTitle', bodyKey: 'onboardingAgentsBody' },
  { icon: <GitBranch size={28} />, titleKey: 'onboardingSplitsTitle', bodyKey: 'onboardingSplitsBody' },
  { icon: <Globe size={28} />, titleKey: 'onboardingPreviewTitle', bodyKey: 'onboardingPreviewBody' },
  { icon: <Keyboard size={28} />, titleKey: 'onboardingShortcutsTitle', bodyKey: 'onboardingShortcutsBody' }
];

/**
 * Overlay full-screen affiché à la première launch (settings.onboardingCompleted
 * absent/false). 5 étapes, skippable. Au close → caller persiste le flag à true.
 *
 * Pas géré via le système Lazy Suspense des autres dialogs : c'est l'écran
 * d'accueil, on veut qu'il soit immédiat sans flash de spinner.
 */
export function OnboardingOverlay({ open, onClose }: Props): JSX.Element | null {
  const t = useT();
  const [idx, setIdx] = useState(0);

  const total = STEPS.length;
  const isLast = idx === total - 1;
  const isFirst = idx === 0;

  const skip = useCallback(() => onClose(false), [onClose]);
  const finish = useCallback(() => onClose(true), [onClose]);
  const next = useCallback(() => {
    if (isLast) finish();
    else setIdx((i) => i + 1);
  }, [isLast, finish]);
  const prev = useCallback(() => {
    if (!isFirst) setIdx((i) => i - 1);
  }, [isFirst]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        e.preventDefault();
        skip();
      } else if (e.key === 'ArrowRight' || e.key === 'Enter') {
        e.preventDefault();
        next();
      } else if (e.key === 'ArrowLeft') {
        e.preventDefault();
        prev();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, next, prev, skip]);

  if (!open) return null;
  const step = STEPS[idx];

  return (
    <div className="onboarding-overlay" role="dialog" aria-modal="true">
      <div className="onboarding-card">
        <button className="onboarding-skip" onClick={skip} title={t('onboardingSkip')}>
          <X size={16} /> {t('onboardingSkip')}
        </button>

        <div className="onboarding-icon">{step.icon}</div>
        <h2 className="onboarding-title">{t(step.titleKey)}</h2>
        <p className="onboarding-body">{t(step.bodyKey)}</p>

        <div className="onboarding-dots" aria-hidden>
          {STEPS.map((_, i) => (
            <span
              key={i}
              className={`onboarding-dot ${i === idx ? 'active' : ''} ${i < idx ? 'past' : ''}`}
              onClick={() => setIdx(i)}
            />
          ))}
        </div>

        <div className="onboarding-step-count">
          {t('onboardingStepCount', { current: idx + 1, total })}
        </div>

        <div className="onboarding-actions">
          <button className="btn ghost" onClick={prev} disabled={isFirst}>
            <ArrowLeft size={14} /> {t('onboardingPrev')}
          </button>
          <button className="btn primary" onClick={next}>
            {isLast ? (
              <>{t('onboardingFinish')}</>
            ) : (
              <>
                {t('onboardingNext')} <ArrowRight size={14} />
              </>
            )}
          </button>
        </div>
      </div>
    </div>
  );
}
