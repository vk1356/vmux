import { Component, type ErrorInfo, type ReactNode } from 'react';
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
}

interface State {
  error: Error | null;
}

export class ErrorBoundary extends Component<Props, State> {
  override state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  override componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error('[vmux] React error caught:', error, info);
  }

  reset = (): void => {
    this.setState({ error: null });
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
    if (!this.state.error) return this.props.children;

    const { scope = 'app', label } = this.props;
    const lang = this.getLang();

    if (scope === 'pane') {
      return (
        <div className="pane-error">
          <AlertTriangle size={20} className="pane-error-icon" />
          <div className="pane-error-title">
            {translate(lang, 'errPaneCrashed', { label: label ?? 'Pane' })}
          </div>
          <div className="pane-error-sub">{this.state.error.message}</div>
          <button className="btn primary" onClick={this.reset}>
            <RotateCw size={14} /> {translate(lang, 'errRetry')}
          </button>
        </div>
      );
    }

    return (
      <div className="error-screen">
        <div className="error-screen-card">
          <AlertTriangle size={32} className="error-screen-icon" />
          <h1>{translate(lang, 'errAppCrashed')}</h1>
          <p>{this.state.error.message || translate(lang, 'errAppCrashed')}</p>
          {this.state.error.stack && (
            <pre className="error-screen-stack">{this.state.error.stack.slice(0, 1500)}</pre>
          )}
          <div className="error-screen-actions">
            <button className="btn" onClick={this.reset}>
              {translate(lang, 'errRetry')}
            </button>
            <button className="btn primary" onClick={this.reload}>
              <RotateCw size={14} /> {translate(lang, 'previewReload')}
            </button>
          </div>
        </div>
      </div>
    );
  }
}
