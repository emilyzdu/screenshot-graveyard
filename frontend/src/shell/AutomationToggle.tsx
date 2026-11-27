import { useId } from 'react';
import type { ProviderMode } from '../api/ai';
import type { useAutomation } from './useAutomation';

/**
 * Batch 6B: the explicit opt-in for automatic preparation. It is a workspace
 * preference, not consent: each screenshot still needs its own "Allow AI
 * processing" before anything is sent, so turning this on never sends anything
 * by itself and never covers screenshots the user has not allowed.
 */
export function AutomationToggle({
  automation,
  providerMode,
}: {
  automation: ReturnType<typeof useAutomation>;
  providerMode: ProviderMode | 'unknown';
}) {
  const hint = useId();
  const { state } = automation;
  const checked = state.t === 'ready' && state.enabled;
  const disabled = state.t !== 'ready' || state.saving;
  return (
    <div className="sg-auto-toggle" role="group" aria-label="Automatic preparation">
      <label className="sg-auto-toggle__label">
        <input
          type="checkbox"
          checked={checked}
          disabled={disabled}
          aria-describedby={hint}
          onChange={(e) => void automation.set(e.target.checked)}
        />
        <span>Prepare drafts automatically after I allow AI processing</span>
      </label>
      <p id={hint} className="sg-muted">
        When this is on, allowing AI processing for a screenshot is the only click needed: it is understood, a next
        step is chosen, and a calendar or notes draft is prepared for you to review.{' '}
        {providerMode === 'openai'
          ? 'With the real AI, the analysis and the draft each send that screenshot to OpenAI.'
          : providerMode === 'fake'
            ? 'In Fake AI mode nothing is sent anywhere, and no draft is chosen automatically.'
            : ''}{' '}
        Each screenshot still needs its own Allow, and nothing is ever approved or sent to another app for you.
      </p>
      {state.t === 'loading' && <p role="status" className="sg-muted">Checking this setting…</p>}
      {state.t === 'error' && (
        <p role="status" className="sg-muted">
          This setting could not be loaded, so automatic preparation stays off.{' '}
          <button type="button" className="sg-link" onClick={() => void automation.reload()}>Load it again</button>
        </p>
      )}
      {state.t === 'ready' && state.error && <p role="alert">{state.error}</p>}
    </div>
  );
}
