import { Component, type ErrorInfo, type ReactNode } from 'react';

import { WorkplaceExperienceFailureView } from './WorkplaceExperienceFailureView';

interface Props {
  /** Changing this remounts the boundary, so switching experiences clears a previous one's error. */
  experienceId: string;
  children: ReactNode;
}

interface State {
  error: Error | null;
}

/**
 * Contains a render failure to the experience surface. The transcript, project rail, and the
 * experience menu live outside this boundary, so a broken experience never takes the selection
 * context with it — the operator can retry it or pick another one.
 */
export class WorkplaceExperienceErrorBoundary extends Component<Props, State> {
  override state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  override componentDidUpdate(previous: Props): void {
    if (previous.experienceId !== this.props.experienceId && this.state.error) this.setState({ error: null });
  }

  override componentDidCatch(error: Error, info: ErrorInfo): void {
    // biome-ignore lint/suspicious/noConsole: an experience that crashes the host is a developer-facing failure.
    console.error(`workplace experience "${this.props.experienceId}" failed to render`, error, info.componentStack);
  }

  override render(): ReactNode {
    if (!this.state.error) return this.props.children;
    return (
      <WorkplaceExperienceFailureView
        failure={{ category: 'render', detail: this.state.error.message }}
        onRetry={() => this.setState({ error: null })}
      />
    );
  }
}
