import { Component, type ReactNode } from 'react';

export class WorldErrorBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() { return { failed: true }; }
  render() {
    if (!this.state.failed) return this.props.children;
    return (
      <div className="pw-fallback" role="alert">
        <h2>The world could not load</h2>
        <p>Your screenshots are safe. You can keep working in the list view.</p>
        <a className="pw-tool" href="?">List view</a>
      </div>
    );
  }
}
