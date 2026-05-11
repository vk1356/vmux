import {
  Suspense,
  lazy,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useTransition,
  type JSX,
  type ReactNode
} from 'react';
import { X, Palette, Bot, Sliders, Bell, Download } from 'lucide-react';
import type { AppSettings } from '@shared/types';
import { useSessionStore } from '../store/sessions';
import { useShallow } from 'zustand/react/shallow';
import { useT } from '../i18n';
import { useFocusTrap } from '../hooks/useFocusTrap';

// Lazy-load each tab content so only the visible one is parsed/rendered.
// SettingsDialog itself is already lazy-loaded in App.tsx.
const SettingsAppearance = lazy(() =>
  import('./settings/SettingsAppearance').then((m) => ({ default: m.SettingsAppearance }))
);
const SettingsTerminal = lazy(() =>
  import('./settings/SettingsTerminal').then((m) => ({ default: m.SettingsTerminal }))
);
const SettingsNotifications = lazy(() =>
  import('./settings/SettingsNotifications').then((m) => ({ default: m.SettingsNotifications }))
);
const SettingsAgents = lazy(() =>
  import('./settings/SettingsAgents').then((m) => ({ default: m.SettingsAgents }))
);
const SettingsAdvanced = lazy(() =>
  import('./settings/SettingsAdvanced').then((m) => ({ default: m.SettingsAdvanced }))
);
const SettingsUpdates = lazy(() =>
  import('./settings/SettingsUpdates').then((m) => ({ default: m.SettingsUpdates }))
);

interface Props {
  open: boolean;
  onClose: () => void;
}

type Tab = 'apparence' | 'terminal' | 'notifs' | 'agents' | 'updates' | 'avance';

const IPC_DEBOUNCE_MS = 250;

export function SettingsDialog({ open, onClose }: Props): JSX.Element | null {
  const { settings, agents, agentAvailability, patchSettings } = useSessionStore(
    useShallow((s) => ({
      settings: s.settings,
      agents: s.agents,
      agentAvailability: s.agentAvailability,
      patchSettings: s.patchSettings
    }))
  );
  const [tab, setTab] = useState<Tab>('apparence');
  const [saving, setSaving] = useState(false);
  const [isPending, startTransition] = useTransition();
  const t = useT();
  const dialogRef = useRef<HTMLDivElement>(null);
  useFocusTrap(dialogRef, open);

  // Pending IPC patches are coalesced for IPC_DEBOUNCE_MS so a slider drag
  // doesn't flood the main process. Local store is updated synchronously for
  // instant UI feedback; the IPC write is the one we throttle.
  const pendingRef = useRef<Partial<AppSettings>>({});
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const inflightRef = useRef(0);

  const flush = useCallback(async (): Promise<void> => {
    if (timerRef.current) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    const patch = pendingRef.current;
    if (Object.keys(patch).length === 0) return;
    pendingRef.current = {};
    inflightRef.current++;
    setSaving(true);
    try {
      await window.cmux.settings.set(patch);
    } finally {
      inflightRef.current--;
      if (inflightRef.current === 0 && Object.keys(pendingRef.current).length === 0) {
        setSaving(false);
      }
    }
  }, []);

  const apply = useCallback(
    async (patch: Partial<AppSettings>): Promise<void> => {
      // Optimistic local update — UI stays responsive even while IPC debounces.
      patchSettings(patch);
      pendingRef.current = { ...pendingRef.current, ...patch };
      setSaving(true);
      if (timerRef.current) clearTimeout(timerRef.current);
      timerRef.current = setTimeout(() => {
        void flush();
      }, IPC_DEBOUNCE_MS);
    },
    [patchSettings, flush]
  );

  // Esc-to-close + flush any pending patch when the dialog closes / unmounts.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        e.preventDefault();
        void flush().finally(onClose);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('keydown', onKey);
    };
  }, [open, onClose, flush]);

  useEffect(() => {
    return () => {
      // On unmount, ensure no pending patch is lost.
      if (Object.keys(pendingRef.current).length > 0) void flush();
    };
  }, [flush]);

  const handleClose = useCallback((): void => {
    void flush().finally(onClose);
  }, [flush, onClose]);

  const switchTab = useCallback(
    (next: Tab): void => {
      startTransition(() => setTab(next));
    },
    [startTransition]
  );

  const tabDefs = useMemo(
    () =>
      [
        { id: 'apparence', label: t('tabAppearance'), icon: <Palette size={14} /> },
        { id: 'terminal', label: t('tabTerminal'), icon: <Sliders size={14} /> },
        { id: 'notifs', label: t('tabNotifications'), icon: <Bell size={14} /> },
        { id: 'agents', label: t('tabAgents'), icon: <Bot size={14} /> },
        { id: 'updates', label: t('tabUpdates'), icon: <Download size={14} /> },
        { id: 'avance', label: t('tabAdvanced'), icon: <Sliders size={14} /> }
      ] satisfies Array<{ id: Tab; label: string; icon: ReactNode }>,
    [t]
  );

  if (!open || !settings) return null;

  return (
    <div className="dialog-backdrop" onClick={handleClose}>
      <div
        className="dialog"
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-label={t('settingsTitle')}
        aria-busy={saving || isPending}
        style={{ width: 'min(720px, 92vw)' }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="dialog-header">
          <div className="dialog-title">{t('settingsTitle')}</div>
          <button
            type="button"
            className="btn-icon"
            onClick={handleClose}
            aria-label={t('settingsClose')}
          >
            <X size={14} />
          </button>
        </div>

        <div className="settings-layout">
          <div className="settings-tabs" role="tablist" aria-orientation="vertical">
            {tabDefs.map((td) => (
              <SettingsTabButton
                key={td.id}
                label={td.label}
                icon={td.icon}
                active={tab === td.id}
                onClick={() => switchTab(td.id)}
              />
            ))}
          </div>

          <div
            className="dialog-body"
            role="tabpanel"
            style={{ flex: 1, overflowY: 'auto', opacity: isPending ? 0.6 : 1 }}
          >
            <Suspense fallback={<div className="hint">{t('settingsLiveHint')}</div>}>
              {tab === 'apparence' && (
                <SettingsAppearance settings={settings} apply={apply} />
              )}
              {tab === 'terminal' && <SettingsTerminal settings={settings} apply={apply} />}
              {tab === 'notifs' && (
                <SettingsNotifications settings={settings} apply={apply} />
              )}
              {tab === 'agents' && (
                <SettingsAgents
                  settings={settings}
                  agents={agents}
                  agentAvailability={agentAvailability}
                  apply={apply}
                />
              )}
              {tab === 'updates' && <SettingsUpdates />}
              {tab === 'avance' && <SettingsAdvanced settings={settings} apply={apply} />}
            </Suspense>
          </div>
        </div>

        <div className="dialog-footer">
          <span className="hint" style={{ flex: 1 }}>
            {saving ? t('settingsSavingHint') : t('settingsLiveHint')}
          </span>
          <button type="button" className="btn primary" onClick={handleClose}>
            {t('settingsClose')}
          </button>
        </div>
      </div>
    </div>
  );
}

interface TabBtnProps {
  label: string;
  icon: ReactNode;
  active: boolean;
  onClick: () => void;
}

function SettingsTabButton({ label, icon, active, onClick }: TabBtnProps): JSX.Element {
  return (
    <button
      type="button"
      role="tab"
      aria-selected={active}
      onClick={onClick}
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 8,
        padding: '8px 10px',
        borderRadius: 6,
        border: '1px solid transparent',
        background: active ? 'var(--bg-elev-2)' : 'transparent',
        color: active ? 'var(--text)' : 'var(--text-muted)',
        textAlign: 'left',
        fontSize: 13,
        fontWeight: active ? 500 : 400
      }}
    >
      {icon}
      {label}
    </button>
  );
}
