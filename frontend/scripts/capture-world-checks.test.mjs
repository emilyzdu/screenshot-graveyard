import { describe, expect, it } from 'vitest';
import { assertCaptureHealthy } from './capture-world-checks.mjs';

describe('world capture checks', () => {
  it('accepts a capture with no page or image failures', () => {
    expect(() => assertCaptureHealthy([], [])).not.toThrow();
  });

  it('fails when the browser reports a page error', () => {
    expect(() => assertCaptureHealthy(['TypeError: render failed'], [])).toThrow('browser page errors: TypeError: render failed');
  });

  it('fails when a mandatory runtime image is missing', () => {
    expect(() => assertCaptureHealthy([], ['/assets/building-tower.png'])).toThrow('missing runtime images: /assets/building-tower.png');
  });
});