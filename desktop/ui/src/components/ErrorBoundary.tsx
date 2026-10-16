import React from 'react'

interface State {
  error: Error | null
}

/**
 * One boundary around the whole shell: a crashing view shows a calm panel
 * with the stack tail and a reload, never a blank white window.
 */
export default class ErrorBoundary extends React.Component<{ children: React.ReactNode }, State> {
  state: State = { error: null }

  static getDerivedStateFromError(error: Error): State {
    return { error }
  }

  componentDidCatch(error: Error, info: React.ErrorInfo): void {
    console.error('[moch] view crashed', error, info.componentStack)
  }

  render(): React.ReactNode {
    if (this.state.error) {
      return (
        <div style={{ height: '100%', display: 'grid', placeItems: 'center', background: '#0a0813', color: '#b4b1c4', fontFamily: 'system-ui, sans-serif' }}>
          <div style={{ maxWidth: 640, padding: 32, textAlign: 'center' }}>
            <div style={{ fontSize: 18, fontWeight: 650, color: '#fff', marginBottom: 8 }}>Something broke in the interface</div>
            <div style={{ fontSize: 13, marginBottom: 4 }}>The runtime is still running — this is a UI-level fault only.</div>
            <pre style={{ textAlign: 'left', background: '#151220', border: '1px solid rgba(248,239,229,0.11)', borderRadius: 10, padding: 14, fontSize: 11.5, overflow: 'auto', maxHeight: 200, color: '#ff5a5a', whiteSpace: 'pre-wrap' }}>
              {String(this.state.error?.stack ?? this.state.error).slice(0, 1200)}
            </pre>
            <button
              onClick={() => location.reload()}
              style={{ marginTop: 14, background: '#f79236', color: '#2e1a08', border: 'none', borderRadius: 10, padding: '9px 18px', fontWeight: 650, fontSize: 13, cursor: 'pointer' }}
            >
              Reload Moch
            </button>
          </div>
        </div>
      )
    }
    return this.props.children
  }
}
