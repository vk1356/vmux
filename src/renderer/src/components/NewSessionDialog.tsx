import { useEffect, useId, useRef, useState, type JSX } from 'react';
import { FolderOpen, X, GitBranch, MessageSquare, AlertCircle, ExternalLink } from 'lucide-react';
import type { AgentPreset, GitRepoInfo } from '@shared/types';
import { useSessionStore } from '../store/sessions';
import { useShallow } from 'zustand/react/shallow';
import { useT } from '../i18n';

ensureDialogBackdropStyle();

interface Props {
  open: boolean;
  onClose: () => void;
  /** Cwd pré-rempli (ex: après un drag-drop de dossier sur la window). */
  defaultCwd?: string;
}

export function NewSessionDialog({ open, onClose, defaultCwd }: Props): JSX.Element | null {
  const t = useT();
  const { agents, agentAvailability, upsertSession } = useSessionStore(
    useShallow((s) => ({
      agents: s.agents,
      agentAvailability: s.agentAvailability,
      upsertSession: s.upsertSession
    }))
  );
  const [agentId, setAgentId] = useState<string>('claude-code');
  const [name, setName] = useState('');
  const [cwd, setCwd] = useState('');
  const [repoInfo, setRepoInfo] = useState<GitRepoInfo | null>(null);
  const [useWorktree, setUseWorktree] = useState(true);
  const [branch, setBranch] = useState('');
  const [base, setBase] = useState('');
  const [initialInput, setInitialInput] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Guard synchrone contre le double-fire de submit. `submitting` state suit
  // un cycle render → React batche les setState donc 2 submits rapides
  // peuvent passer le check `if (submitting)` avant le re-render. Le ref est
  // checké et set synchroniquement → vraiment idempotent.
  const submittingRef = useRef(false);
  const dialogRef = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  const cwdId = useId();
  const branchId = useId();
  const baseId = useId();
  const nameId = useId();
  const initialPromptId = useId();

  useEffect(() => {
    const d = dialogRef.current;
    if (!d) return;
    if (open && !d.open) {
      d.showModal();
      setAgentId('claude-code');
      setName('');
      setCwd(defaultCwd ?? '');
      setRepoInfo(null);
      setUseWorktree(true);
      setBranch('');
      setBase('');
      setInitialInput('');
      setError(null);
    } else if (!open && d.open) {
      d.close();
    }
  }, [open, defaultCwd]);

  // Enter to submit — skip si focus sur button/textarea/select (l'Enter natif
  // a déjà sa sémantique : activate button, newline dans textarea, open dropdown
  // dans select). Skip aussi en cours de composition IME (CJK).
  useEffect(() => {
    if (!open) return;
    const d = dialogRef.current;
    if (!d) return;
    const onKey = (e: KeyboardEvent): void => {
      if (e.isComposing) return;
      if (e.key !== 'Enter') return;
      const tag = (e.target as HTMLElement | null)?.tagName;
      if (tag === 'BUTTON' || tag === 'TEXTAREA' || tag === 'SELECT') return;
      e.preventDefault();
      void submit();
    };
    d.addEventListener('keydown', onKey);
    return () => d.removeEventListener('keydown', onKey);
    // submit est stable via submittingRef ; on évite de le mettre en dep pour
    // ne pas réinstaller le listener à chaque keystroke (form fields = setState).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  // Inspection git debouncée.
  useEffect(() => {
    if (!cwd || !open) {
      setRepoInfo(null);
      return;
    }
    let cancelled = false;
    const handle = window.setTimeout(() => {
      void window.cmux.git.inspect(cwd).then((r) => {
        if (cancelled) return;
        if (!r.ok) {
          setRepoInfo({ isRepo: false, path: cwd, branches: [], hasUncommitted: false });
          return;
        }
        setRepoInfo(r.data);
        if (r.data.isRepo) {
          setBase((b) => b || r.data.currentBranch || 'HEAD');
        }
      });
    }, 200);
    return () => {
      cancelled = true;
      window.clearTimeout(handle);
    };
  }, [cwd, open]);

  const pickFolder = async (): Promise<void> => {
    const p = await window.cmux.dialog.pickRepo();
    if (p) setCwd(p);
  };

  const submit = async (): Promise<void> => {
    if (submittingRef.current) return; // anti-double-fire synchrone
    setError(null);
    if (!cwd) {
      setError(t('newSessionCwd'));
      return;
    }
    if (useWorktree && repoInfo?.isRepo && !branch.trim()) {
      setError(t('newSessionBranch'));
      return;
    }

    submittingRef.current = true;
    setSubmitting(true);
    try {
      const agent = agents.find((a) => a.id === agentId);
      // Auto-name : si pas de nom donné mais un prompt initial, dérive le nom
      // de la 1ère ligne du prompt (max 60 chars). Sinon fallback sur "Agent · branche".
      const fallback = `${agent?.label || agentId} · ${branch.trim() || 'main'}`;
      const auto = initialInput.trim().split(/\r?\n/)[0]?.trim().slice(0, 60);
      const finalName = name.trim() || auto || fallback;
      const r = await window.cmux.sessions.create({
        name: finalName,
        agentId: agentId as AgentPreset['id'],
        cwd,
        newWorktree:
          useWorktree && repoInfo?.isRepo && branch.trim()
            ? { branch: branch.trim(), base: base || undefined }
            : undefined,
        initialInput: initialInput.trim() || undefined
      });
      if (!r.ok) {
        setError(r.error);
        return;
      }
      upsertSession(r.data);
      onClose();
    } catch (err) {
      setError((err as Error).message || t('newSessionFailedToCreate'));
    } finally {
      submittingRef.current = false;
      setSubmitting(false);
    }
  };

  if (!open) return null;

  const canWorktree = !!repoInfo?.isRepo;
  const selectedAvailability = agentAvailability[agentId];
  const selectedAgent = agents.find((a) => a.id === agentId);

  const onBackdropClick = (e: React.MouseEvent<HTMLDialogElement>): void => {
    if (e.target === e.currentTarget) onClose();
  };

  return (
    <dialog
      ref={dialogRef}
      className="dialog vmux-dialog"
      style={dialogResetStyle}
      onCancel={(e) => {
        e.preventDefault();
        onClose();
      }}
      onClick={onBackdropClick}
      aria-labelledby={titleId}
    >
      <div className="dialog-header">
        <div className="dialog-title" id={titleId}>
          {t('newSessionTitle')}
        </div>
        <button className="btn-icon" onClick={onClose} aria-label={t('settingsClose')}>
          <X size={14} />
        </button>
      </div>

      <div className="dialog-body">
        <div className="field">
          <span className="field-label">{t('newSessionAgent')}</span>
          <div className="agent-grid" role="radiogroup" aria-label={t('newSessionAgent')}>
            {agents.map((a) => {
              const av = agentAvailability[a.id];
              const missing = av && !av.found && a.id !== 'shell';
              const isSelected = agentId === a.id;
              return (
                <button
                  key={a.id}
                  type="button"
                  role="radio"
                  aria-checked={isSelected}
                  className={`agent-card ${isSelected ? 'selected' : ''} ${
                    missing ? 'missing' : ''
                  }`}
                  onClick={() => setAgentId(a.id)}
                >
                  <div className="agent-card-row">
                    <span
                      className="agent-card-bullet"
                      style={{ background: a.color }}
                      aria-hidden
                    />
                    <span className="agent-card-name">{a.label}</span>
                    {missing && (
                      <span
                        className="agent-card-badge"
                        title={t('newSessionAgentNotDetectedTip')}
                      >
                        {t('agentNotInstalled')}
                      </span>
                    )}
                  </div>
                  <div className="agent-card-desc">
                    {translateAgentDesc(t, a.id, a.description)}
                  </div>
                </button>
              );
            })}
          </div>
          {selectedAvailability && !selectedAvailability.found && agentId !== 'shell' && (
            <div className="hint warn">
              <AlertCircle size={11} style={{ verticalAlign: '-1px' }} />{' '}
              <code>{selectedAgent?.command}</code> {t('newSessionAgentNotInstalled')}
              {selectedAgent?.installUrl && (
                <>
                  {' '}
                  <a
                    onClick={() =>
                      selectedAgent.installUrl &&
                      window.cmux.dialog.openExternal(selectedAgent.installUrl)
                    }
                  >
                    <ExternalLink size={9} style={{ verticalAlign: '-1px' }} />
                  </a>
                </>
              )}
            </div>
          )}
        </div>

        <div className="field">
          <label className="field-label" htmlFor={cwdId}>
            {t('newSessionCwd')}
          </label>
          <div className="input-group">
            <input
              id={cwdId}
              className="input"
              placeholder="C:\path\to\repo"
              value={cwd}
              onChange={(e) => setCwd(e.target.value)}
              autoComplete="off"
              spellCheck={false}
            />
            <button className="btn" onClick={pickFolder}>
              <FolderOpen size={14} />
              {t('newSessionCwdPick')}
            </button>
          </div>
          {repoInfo && (
            <div className="hint">
              {repoInfo.isRepo ? (
                <>
                  <GitBranch size={11} style={{ verticalAlign: '-2px', marginRight: 4 }} />
                  {t('newSessionRepoDetected')}{' '}
                  <strong>{repoInfo.currentBranch ?? 'detached'}</strong>
                  {repoInfo.hasUncommitted && ` · ${t('newSessionUncommitted')}`}
                </>
              ) : (
                t('newSessionNotARepo')
              )}
            </div>
          )}
        </div>

        {canWorktree && (
          <>
            <label className="checkbox-row">
              <input
                type="checkbox"
                checked={useWorktree}
                onChange={(e) => setUseWorktree(e.target.checked)}
              />
              {t('newSessionCreateWorktreeFull')}
            </label>

            {useWorktree && (
              <>
                <div className="field">
                  <label className="field-label" htmlFor={branchId}>
                    {t('newSessionBranch')}
                  </label>
                  <input
                    id={branchId}
                    className="input"
                    placeholder="agent/claude-feature-x"
                    value={branch}
                    onChange={(e) => setBranch(e.target.value)}
                    autoComplete="off"
                    spellCheck={false}
                  />
                </div>
                <div className="field">
                  <label className="field-label" htmlFor={baseId}>
                    {t('newSessionBaseBranch')}
                  </label>
                  <select
                    id={baseId}
                    className="select"
                    value={base}
                    onChange={(e) => setBase(e.target.value)}
                  >
                    {repoInfo?.branches.map((b) => (
                      <option key={b} value={b}>
                        {b}
                      </option>
                    ))}
                  </select>
                </div>
              </>
            )}
          </>
        )}

        <div className="field">
          <label className="field-label" htmlFor={nameId}>
            {t('newSessionName')}
          </label>
          <input
            id={nameId}
            className="input"
            placeholder="refactor api"
            value={name}
            onChange={(e) => setName(e.target.value)}
            autoComplete="off"
          />
        </div>

        <div className="field">
          <label className="field-label" htmlFor={initialPromptId}>
            <MessageSquare size={11} style={{ verticalAlign: '-1px' }} />{' '}
            {t('newSessionInitialPrompt')}
          </label>
          <input
            id={initialPromptId}
            className="input"
            placeholder={t('newSessionInitialPromptPlaceholder')}
            value={initialInput}
            onChange={(e) => setInitialInput(e.target.value)}
            autoComplete="off"
          />
          <div className="hint">{t('newSessionInitialPromptHint')}</div>
        </div>

        {error && (
          <div className="error-banner" role="alert">
            {error}
          </div>
        )}
      </div>

      <div className="dialog-footer">
        <button className="btn ghost" onClick={onClose} disabled={submitting}>
          {t('newSessionCancel')}
        </button>
        <button
          className="btn primary"
          onClick={() => void submit()}
          disabled={submitting || !cwd}
        >
          {submitting ? t('newSessionCreating') : t('newSessionLaunch')}
        </button>
      </div>
    </dialog>
  );
}

/** Renvoie la description traduite de l'agent (clé `agentDesc.<id>`) ou
 *  un fallback sur la description par défaut du preset si la clé manque. */
function translateAgentDesc(
  t: ReturnType<typeof useT>,
  agentId: string,
  fallback: string
): string {
  const key = `agentDesc.${agentId}` as Parameters<typeof t>[0];
  const translated = t(key);
  // Si la clé n'existe pas du tout, translate() renvoie la clé brute.
  return translated && translated !== key ? translated : fallback;
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
