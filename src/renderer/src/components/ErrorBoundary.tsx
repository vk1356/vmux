import { Component, Fragment, type ErrorInfo, type ReactNode } from 'react';
import { AlertTriangle, RotateCw } from 'lucide-react';
import { translate } from '../i18n';
import { useSessionStore } from '../store/sessions';
import type { Lang } from '@shared/types';

interface Props {
  children: ReactNode;
  /** Mode compact pour wrapper un pane (vs écran plein pour la racine). */
  scope?: 'app' | 'pane';
  /** Label du pane pour le message d'erreur. */
  label?: string;
  /** Clé pour reset auto le boundary quand la prop change (ex : changement de
   *  route / pane focus). Si la valeur change, on clear l'erreur — sinon une
   *  erreur "collante" empêche de re-tenter sur un autre contexte. */
  resetKey?: string | number;
}

interface State {
  error: Error | null;
  componentStack: string | null;
  /** Incrémenté par reset() — sert de key React pour forcer un remount du
   *  sous-arbre. Sans ça, "Retry" clear l'état mais réinstancie les mêmes
   *  composants qui re-crashent immédiatement si la cause persiste. */
  retryKey: number;
}

/**
 * Class-based ErrorBoundary — toujours requis en React 19 (les hooks ne couvrent
 * pas getDerivedStateFromError / componentDidCatch). On stocke componentStack
 * en plus du message pour permettre l'inspection en dev. Log via console.error
 * (pas d'endpoint IPC dédié côté preload, donc on évite d'ajouter une dépendance
 * que le main ne consomme pas).
 */
export class ErrorBoundary extends Component<Props, State> {
  override state: State = { error: null, componentStack: null, retryKey: 0 };

  static getDerivedStateFromError(error: Error): Partial<State> {
    return { error };
  }

  override componentDidCatch(error: Error, info: ErrorInfo): void {
    // Stocke le componentStack pour rendu — getDerivedStateFromError ne reçoit
    // que l'erreur, pas l'info. Best practice React 19.
    this.setState({ componentStack: info.componentStack ?? null });
    // eslint-disable-next-line no-console
    console.error('[vmux] React error caught:', error, info.componentStack);
  }

  override componentDidUpdate(prevProps: Props): void {
    // Reset auto si resetKey change (ex : route / session active change).
    if (this.state.error && prevProps.resetKey !== this.props.resetKey) {
      this.reset();
    }
  }

  reset = (): void => {
    this.setState((s) => ({
      error: null,
      componentStack: null,
      retryKey: s.retryKey + 1
    }));
  };

  reload = (): void => {
    window.location.reload();
  };

  /** Lit la langue active depuis le store de manière imperative — l'ErrorBoundary
   *  étant un class component, on ne peut pas utiliser `useT()`. Le re-render
   *  est déclenché par le state interne de l'erreur, ce qui est suffisant. */
  private getLang(): Lang {
    return (useSessionStore.getState().settings?.language ?? 'en') as Lang;
  }

  override render(): ReactNode {
    if (!this.state.error) {
      // Fragment keyed sur retryKey : un retry incrémente la clé → React
      // unmount le sous-arbre puis le remonte frais (state/refs/effects neufs).
      return <Fragment key={this.state.retryKey}>{this.props.children}</Fragment>;
    }

    const { scope = 'app', label } = this.props;
    const lang = this.getLang();

    if (scope === 'pane') {
      return (
        <div className="pane-error" role="alert" aria-live="assertive">
          <AlertTriangle size={20} className="pane-error-icon" aria-hidden />
          <div className="pane-error-title">
            {translate(lang, 'errPaneCrashed', { label: label ?? 'Pane' })}
          </div>
          <div className="pane-error-sub">{this.state.error.message}</div>
          <button className="btn primary" onClick={this.reset}>
            <RotateCw size={14} aria-hidden /> {translate(lang, 'errRetry')}
          </button>
        </div>
      );
    }

    return (
      <div className="error-screen" role="alert" aria-live="assertive">
        <div className="error-screen-card">
          <AlertTriangle size={32} className="error-screen-icon" aria-hidden />
          <h1>{translate(lang, 'errAppCrashed')}</h1>
          <p>{this.state.error.message || translate(lang, 'errAppCrashed')}</p>
          {this.state.error.stack && (
            <pre className="error-screen-stack">{this.state.error.stack.slice(0, 1500)}</pre>
          )}
          {this.state.componentStack && (
            <pre className="error-screen-stack">
              {this.state.componentStack.slice(0, 1500)}
            </pre>
          )}
          <div className="error-screen-actions">
            <button className="btn" onClick={this.reset}>
              {translate(lang, 'errRetry')}
            </button>
            <button className="btn primary" onClick={this.reload}>
              <RotateCw size={14} aria-hidden /> {translate(lang, 'previewReload')}
            </button>
          </div>
        </div>
      </div>
    );
  }
}
