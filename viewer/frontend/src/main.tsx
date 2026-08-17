import ReactDOM from 'react-dom/client'
import App from './App'
import ErrorBoundary from './ErrorBoundary'

// ErrorBoundary で包む: 描画中の例外で React が落ちると index.html の背景だけが残って
// 「真っ暗な画面」になり原因が分からない。落ちた理由とリロード手段を画面に出す。
ReactDOM.createRoot(document.getElementById('root')!).render(
  <ErrorBoundary>
    <App />
  </ErrorBoundary>,
)
