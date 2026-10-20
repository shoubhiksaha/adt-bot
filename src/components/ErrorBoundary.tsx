import { Component, type ErrorInfo, type ReactNode } from "react";

/**
 * Keeps one broken part (a message with unexpected data from a backup or a service, a bad theme)
 * from blanking the whole app. `fallback` shows instead of the part that failed.
 */
export class ErrorBoundary extends Component<{ children: ReactNode; fallback: (error: Error, reset: () => void) => ReactNode }, { error: Error | null }> {
  state = { error: null as Error | null };

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error("Display error:", error, info.componentStack);
  }

  render() {
    const { error } = this.state;
    return error ? this.props.fallback(error, () => this.setState({ error: null })) : this.props.children;
  }
}
