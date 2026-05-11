import { useCallback, useEffect, useId, useRef, useState, type JSX } from 'react';
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
 * Implémenté en native <dialog> : Chromium gère focus-trap, inertness du reste
 * de la page, et restore-focus à l'opener — gratuit. On reset les styles UA
 * du <dialog> pour conserver le visuel full-screen radial gradient.
 */
export function OnboardingOverlay({ open, onClose }: Props): JSX.Element | null {
  const t = useT();
  const [idx, setIdx] = useState(0);
  const dialogRef = useRef<HTMLDialogElement>(null);
  const titleId = useId();

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

  // showModal / close en fonction de open.
  useEffect(() => {
    const d = dialogRef.current;
    if (!d) return;
    if (open && !d.open) {
      d.showModal();
      setIdx(0);
    } else if (!open && d.open) {
      d.close();
    }
  }, [open]);

  // ArrowLeft/Right + Enter : nav step. Esc → géré nativement par <dialog>
  // (cancel event) — on appelle skip() depuis onCancel.
  useEffect(() => {
    if (!open) return;
    const d = dialogRef.current;
    if (!d) return;
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'ArrowRight' || e.key === 'Enter') {
        e.preventDefault();
        next();
      } else if (e.key === 'ArrowLeft') {
        e.preventDefault();
        prev();
      }
    };
    d.addEventListener('keydown', onKey);
    return () => d.removeEventListener('keydown', onKey);
  }, [open, next, prev]);

  if (!open) return null;
  const step = STEPS[idx];

  return (
    <dialog
      ref={dialogRef}
      className="onboarding-overlay"
      style={dialogResetStyle}
      onCancel={(e) => {
        e.preventDefault();
        skip();
      }}
      aria-labelledby={titleId}
    >
      <div className="onboarding-card">
        <button className="onboarding-skip" onClick={skip} title={t('onboardingSkip')}>
          <X size={16} /> {t('onboardingSkip')}
        </button>

        <div className="onboarding-icon" aria-hidden>
          {step.icon}
        </div>
        <h2 className="onboarding-title" id={titleId}>
          {t(step.titleKey)}
        </h2>
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
    </dialog>
  );
}

/**
 * Reset des styles UA du <dialog>. L'onboarding est full-screen (inset:0) —
 * le CSS `.onboarding-overlay` gère déjà le positioning / gradient / blur.
 * Quand showModal() : <dialog> passe en top-layer, donc inset:0 le couvre tout.
 */
const dialogResetStyle: React.CSSProperties = {
  padding: 0,
  border: 0,
  background: 'transparent',
  maxWidth: 'unset',
  maxHeight: 'unset',
  width: '100%',
  height: '100%',
  overflow: 'visible',
  color: 'inherit'
};
