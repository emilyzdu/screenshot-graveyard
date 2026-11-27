import { lazy, Suspense } from 'react';
import './App.css';
import Graveyard from './Graveyard';
import HealthStatus from './HealthStatus';
import { isDemoMode } from './uiMode';
import LiveWorkspace from './shell/LiveWorkspace';

// The visual redesign runs in a frontend-only demo mode: it uses synthetic
// fixtures and never touches the API client. Enable with `?demo=1` or by
// building/running with VITE_UI_MODE=demo (`npm run dev:demo`).
const DemoApp = lazy(() => import('./demo/DemoApp'));
// The Lantern Graveyard (Pixel World) loads on demand: `?view=world`. With
// `?demo=1` it uses synthetic ghosts instead of the API.
const PixelWorld = lazy(() => import('./world/PixelWorld'));

function App() {
  if (new URLSearchParams(window.location.search).get('view') === 'world') {
    return (
      <Suspense fallback={null}>
        <PixelWorld />
      </Suspense>
    );
  }
  if (isDemoMode()) {
    return (
      <Suspense fallback={null}>
        <DemoApp />
      </Suspense>
    );
  }
  if (new URLSearchParams(window.location.search).get('view') !== 'classic') {
    return <LiveWorkspace />;
  }
  return (
    <main className="app">
      <header className="app__header">
        <h1>Screenshot Graveyard</h1>
        <p className="tagline">
          Where screenshots finish their unfinished business.
        </p>
        <HealthStatus />
        <a href="?">Back to the new Workspace</a>
      </header>
      <Graveyard />
    </main>
  );
}
export default App;
