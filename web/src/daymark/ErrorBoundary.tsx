import { Component, type ReactNode } from 'react'
export default class ErrorBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false }
  static getDerivedStateFromError() { return { failed: true } }
  render() { return this.state.failed ? <main className="dm-app"><div style={{ padding: 20 }}><h1>Daymark</h1><p>This view could not be opened. The request may have expired or the connection may be unavailable. No action is marked complete from this error.</p><button onClick={() => window.location.reload()}>Try again</button><a href="/">Back to Daymark</a></div></main> : this.props.children }
}
