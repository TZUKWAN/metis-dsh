/**
 * ErrorBoundary — catches render errors and displays a recoverable fallback UI.
 */

import { Component, type ReactNode } from 'react';
import { useTranslation } from '../i18n';

interface Props {
  children: ReactNode;
  onReset?: () => void;
  showDetails?: boolean;
}

interface State {
  hasError: boolean;
  error: Error | null;
}

function Fallback({
  error,
  onReset,
  showDetails,
}: {
  error: Error | null;
  onReset?: () => void;
  showDetails: boolean;
}) {
  const { t } = useTranslation();
  return (
    <div className="error-boundary" role="alert">
      <h2>{t('errorBoundary.title')}</h2>
      <p>{t('errorBoundary.message')}</p>
      {error && showDetails && (
        <pre className="error-boundary-details">{error.stack ?? error.message}</pre>
      )}
      {onReset && (
        <button type="button" className="btn-primary" onClick={onReset}>
          {t('errorBoundary.retry')}
        </button>
      )}
    </div>
  );
}

export default class ErrorBoundary extends Component<Props, State> {
  constructor(props: Props) {
    super(props);
    this.state = { hasError: false, error: null };
  }

  static getDerivedStateFromError(error: Error): State {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, errorInfo: React.ErrorInfo) {
    console.error('ErrorBoundary caught an error:', error, errorInfo);
  }

  handleReset = () => {
    this.setState({ hasError: false, error: null });
    this.props.onReset?.();
  };

  render() {
    if (this.state.hasError) {
      return (
        <Fallback
          error={this.state.error}
          onReset={this.props.onReset ? this.handleReset : undefined}
          showDetails={this.props.showDetails === true}
        />
      );
    }
    return this.props.children;
  }
}
