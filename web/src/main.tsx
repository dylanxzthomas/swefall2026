import React from 'react'
import ReactDOM from 'react-dom/client'
import ErrorBoundary from './daymark/ErrorBoundary'
import './startup.css'

const App = React.lazy(() => import('./App'))
ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode><ErrorBoundary><React.Suspense fallback={<main className="dm-startup" role="status">Opening your workspace…</main>}><App /></React.Suspense></ErrorBoundary></React.StrictMode>,
)
