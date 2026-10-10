import { Component, createRef, type ErrorInfo, type ReactNode } from "react";
import "./workspaceStartupBoundary.css";

interface WorkspaceStartupBoundaryProps {
  children: ReactNode;
  onReload?: () => void;
}

/** Covers lazy loading and React render/lifecycle failures. Native jobs and
 * event-handler errors still retain their own error owners. */
export class WorkspaceStartupBoundary extends Component<WorkspaceStartupBoundaryProps, { failed: boolean }> {
  state = { failed: false };
  private readonly reloadButton = createRef<HTMLButtonElement>();

  static getDerivedStateFromError() { return { failed: true }; }

  componentDidCatch(error: unknown, info: ErrorInfo) {
    // Keep diagnostics local; arbitrary paths and stacks are not product copy.
    console.error("Editkin workspace startup failed", error, info.componentStack);
  }

  componentDidMount() { if (this.state.failed) this.reloadButton.current?.focus(); }
  componentDidUpdate(_props: WorkspaceStartupBoundaryProps, previous: { failed: boolean }) {
    if (this.state.failed && !previous.failed) this.reloadButton.current?.focus();
  }

  render() {
    if (!this.state.failed) return this.props.children;
    return <main className="workspace-startup-failure">
      <section role="alert" aria-label="工作區發生錯誤" className="workspace-startup-failure-card">
        <span className="workspace-startup-brand">EDITKIN</span>
        <h1>工作區發生錯誤</h1>
        <p>重新載入後，請再次開啟專案。尚未儲存的修改可能無法恢復。</p>
        <button ref={this.reloadButton} type="button" onClick={this.props.onReload ?? (() => window.location.reload())}>重新載入</button>
        <small>若再次出現，請提供錯誤代碼給支援人員：WORKSPACE_START_FAILED</small>
      </section>
    </main>;
  }
}
