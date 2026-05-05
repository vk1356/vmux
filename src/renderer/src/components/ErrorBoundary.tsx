import { Component, type ErrorInfo, type ReactNode } from 'react';
import { AlertTriangle, RotateCw } from 'lucide-react';

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
    console.error('[cmux] React error caught:', error, info);
  }

  reset = (): void => {
    this.setState({ error: null });
  };

  reload = (): void => {
    window.location.reload();
  };

  override render(): ReactNode {
    if (!this.state.error) return this.props.children;

    const { scope = 'app', label } = this.props;

    if (scope === 'pane') {
      return (
        <div className="pane-error">
          <AlertTriangle size={20} className="pane-error-icon" />
          <div className="pane-error-title">{label ?? 'Pane'} a crashé</div>
          <div className="pane-error-sub">{this.state.error.message}</div>
          <button className="btn primary" onClick={this.reset}>
            <RotateCw size={14} /> Recharger
          </button>
        </div>
      );
    }

    return (
      <div className="error-screen">
        <div className="error-screen-card">
          <AlertTriangle size={32} className="error-screen-icon" />
          <h1>cmux a rencontré une erreur</h1>
          <p>{this.state.error.message || 'Erreur inattendue.'}</p>
          {this.state.error.stack && (
            <pre className="error-screen-stack">{this.state.error.stack.slice(0, 1500)}</pre>
          )}
          <div className="error-screen-actions">
            <button className="btn" onClick={this.reset}>
              Réessayer
            </button>
            <button className="btn primary" onClick={this.reload}>
              <RotateCw size={14} /> Recharger
            </button>
          </div>
        </div>
      </div>
    );
  }
}
