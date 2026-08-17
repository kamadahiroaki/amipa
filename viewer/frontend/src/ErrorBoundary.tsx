import React from 'react'

// 描画中の例外で React がツリーごとアンマウントすると、index.html の背景(#1a1a2e)だけが残って
// **原因の分からない「真っ暗な画面」**になる(実例: ノード詳細パネルが高速経路で欠ける
// `size` に .toLocaleString() を呼んで落ちた)。最低限、何が起きたかを画面に出して復帰手段を示す。
interface State { error: Error | null; info: string }

export default class ErrorBoundary extends React.Component<{ children: React.ReactNode }, State> {
  state: State = { error: null, info: '' }

  static getDerivedStateFromError(error: Error): Partial<State> { return { error } }

  componentDidCatch(error: Error, info: React.ErrorInfo) {
    console.error('viewer crashed:', error, info.componentStack)
    this.setState({ info: info.componentStack ?? '' })
  }

  render() {
    const { error, info } = this.state
    if (!error) return this.props.children
    const box: React.CSSProperties = {
      position: 'fixed', inset: 0, overflow: 'auto', background: '#fff', color: '#212529',
      font: '13px/1.6 ui-monospace,Menlo,Consolas,monospace', padding: '24px 28px', zIndex: 9999,
    }
    return (
      <div style={box}>
        <div style={{ font: '600 16px sans-serif', color: '#b91c1c', marginBottom: 10 }}>
          viewer が描画中にエラーで停止しました
        </div>
        <div style={{ marginBottom: 14, font: '13px sans-serif', color: '#495057' }}>
          直前の操作を控えてこの内容を報告してください。<b>リロード</b>で復帰できます
          （編集中の変更は失われます）。
        </div>
        <button onClick={() => location.reload()}
          style={{ border: '1px solid #0d9488', background: '#0d9488', color: '#fff', borderRadius: 6,
            padding: '6px 14px', font: '13px sans-serif', cursor: 'pointer', marginBottom: 16 }}>
          リロード
        </button>
        <pre style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-all', background: '#f8f9fa',
          border: '1px solid #e9ecef', borderRadius: 6, padding: '10px 12px' }}>
          {String(error.stack || error.message || error)}
        </pre>
        {info && (
          <pre style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-all', color: '#868e96',
            background: '#f8f9fa', border: '1px solid #e9ecef', borderRadius: 6, padding: '10px 12px',
            marginTop: 10 }}>{info}</pre>
        )}
      </div>
    )
  }
}
