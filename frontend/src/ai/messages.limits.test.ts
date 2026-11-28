import { describe, expect, it } from 'vitest';
import type { ApiFailure } from '../api/ai';
import { describeLimitFailure, describeRequestFailure } from './messages';

// Deployment foundation: a 429 has three causes, each with truthful text.
const f = (code: string, status = 429): ApiFailure => ({ ok: false, status, code, message: code });

describe('429 wording by cause', () => {
  it('the global daily AI limit points to the demo and says nothing was processed', () => {
    const text = describeRequestFailure(f('ai_budget_reached'));
    expect(text).toMatch(/daily AI limit has been reached/);
    expect(text).toMatch(/Nothing was processed/);
    expect(text).toMatch(/\?demo=1/);
    expect(text).not.toMatch(/workspace/);
  });

  it('plain rate limiting is not described as a used-up allowance', () => {
    const text = describeRequestFailure(f('rate_limited'));
    expect(text).toMatch(/Too many requests/);
    expect(text).not.toMatch(/allowance/);
  });

  it('the per-workspace quota keeps its existing wording', () => {
    expect(describeRequestFailure(f('quota_exceeded'))).toBe(
      'You have used up this workspace\u2019s AI request allowance. Nothing was processed.',
    );
    expect(describeLimitFailure(f('quota_exceeded'), 'x')).toBeNull();
  });

  it('non-429 failures are not treated as limits', () => {
    expect(describeLimitFailure(f('ai_budget_reached', 403), 'x')).toBeNull();
  });
});
