import { useEffect, useState, type JSX } from 'react';
import { FolderOpen, X, GitBranch, MessageSquare, AlertCircle, ExternalLink } from 'lucide-react';
import type { AgentPreset, GitRepoInfo } from '@shared/types';
import { useSessionStore } from '../store/sessions';

interface Props {
  open: boolean;
  onClose: () => void;
}

export function NewSessionDialog({ open, onClose }: Props): JSX.Element | null {
  const { agents, agentAvailability, upsertSession } = useSessionStore();
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

  useEffect(() => {
    if (!open) return;
    setAgentId('claude-code');
    setName('');
    setCwd('');
    setRepoInfo(null);
    setUseWorktree(true);
    setBranch('');
    setBase('');
    setInitialInput('');
    setError(null);
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
    setError(null);
    if (!cwd) {
      setError('Choisis un dossier de travail.');
      return;
    }
    if (useWorktree && repoInfo?.isRepo && !branch.trim()) {
      setError('Indique un nom de branche pour le nouveau worktree.');
      return;
    }

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
      setError((err as Error).message || 'Échec de création de la session.');
    } finally {
      setSubmitting(false);
    }
  };

  if (!open) return null;

  const canWorktree = !!repoInfo?.isRepo;
  const selectedAvailability = agentAvailability[agentId];
  const selectedAgent = agents.find((a) => a.id === agentId);

  return (
    <div className="dialog-backdrop" onClick={onClose}>
      <div className="dialog" onClick={(e) => e.stopPropagation()}>
        <div className="dialog-header">
          <div className="dialog-title">Nouvelle session</div>
          <button className="btn-icon" onClick={onClose} aria-label="Fermer">
            <X size={14} />
          </button>
        </div>

        <div className="dialog-body">
          <div className="field">
            <label className="field-label">Agent</label>
            <div className="agent-grid">
              {agents.map((a) => {
                const av = agentAvailability[a.id];
                const missing = av && !av.found && a.id !== 'shell';
                return (
                  <button
                    key={a.id}
                    className={`agent-card ${agentId === a.id ? 'selected' : ''} ${
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
                        <span className="agent-card-badge" title="Non détecté dans le PATH">
                          non installé
                        </span>
                      )}
                    </div>
                    <div className="agent-card-desc">{a.description}</div>
                  </button>
                );
              })}
            </div>
            {selectedAvailability && !selectedAvailability.found && agentId !== 'shell' && (
              <div className="hint warn">
                <AlertCircle size={11} style={{ verticalAlign: '-1px' }} />{' '}
                <code>{selectedAgent?.command}</code> n'est pas dans le PATH.
                {selectedAgent?.installUrl && (
                  <>
                    {' '}
                    <a
                      onClick={() =>
                        selectedAgent.installUrl &&
                        window.cmux.dialog.openExternal(selectedAgent.installUrl)
                      }
                    >
                      Voir l'installation <ExternalLink size={9} style={{ verticalAlign: '-1px' }} />
                    </a>
                  </>
                )}
              </div>
            )}
          </div>

          <div className="field">
            <label className="field-label">Dossier de travail</label>
            <div className="input-group">
              <input
                className="input"
                placeholder="C:\chemin\vers\repo"
                value={cwd}
                onChange={(e) => setCwd(e.target.value)}
              />
              <button className="btn" onClick={pickFolder}>
                <FolderOpen size={14} />
                Parcourir
              </button>
            </div>
            {repoInfo && (
              <div className="hint">
                {repoInfo.isRepo ? (
                  <>
                    <GitBranch size={11} style={{ verticalAlign: '-2px', marginRight: 4 }} />
                    Dépôt Git détecté · branche actuelle&nbsp;:{' '}
                    <strong>{repoInfo.currentBranch ?? 'detached'}</strong>
                    {repoInfo.hasUncommitted && ' · changements non commités'}
                  </>
                ) : (
                  'Pas un dépôt Git — la session démarrera dans ce dossier sans worktree.'
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
                Créer un nouveau git worktree pour isoler cet agent
              </label>

              {useWorktree && (
                <>
                  <div className="field">
                    <label className="field-label">Nouvelle branche</label>
                    <input
                      className="input"
                      placeholder="agent/claude-feature-x"
                      value={branch}
                      onChange={(e) => setBranch(e.target.value)}
                    />
                  </div>
                  <div className="field">
                    <label className="field-label">Branche de base</label>
                    <select
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
            <label className="field-label">Nom de la session (optionnel)</label>
            <input
              className="input"
              placeholder="Ex: refactor api"
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
          </div>

          <div className="field">
            <label className="field-label">
              <MessageSquare size={11} style={{ verticalAlign: '-1px' }} /> Prompt initial (optionnel)
            </label>
            <input
              className="input"
              placeholder="Ce que l'agent doit faire en premier"
              value={initialInput}
              onChange={(e) => setInitialInput(e.target.value)}
            />
            <div className="hint">Envoyé en stdin juste après le démarrage de l'agent.</div>
          </div>

          {error && <div className="error-banner">{error}</div>}
        </div>

        <div className="dialog-footer">
          <button className="btn ghost" onClick={onClose} disabled={submitting}>
            Annuler
          </button>
          <button className="btn primary" onClick={submit} disabled={submitting || !cwd}>
            {submitting ? 'Création…' : 'Lancer la session'}
          </button>
        </div>
      </div>
    </div>
  );
}
