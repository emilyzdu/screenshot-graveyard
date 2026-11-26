/** Version origins defined by ArtifactVersion. Missing or unfamiliar values carry no attribution. */
export function isAIAnalysisOrigin(origin: unknown): origin is 'ai_generate' | 'ai_redo' {
  return origin === 'ai_generate' || origin === 'ai_redo';
}

export function normalizeAnalysisOrigin(origin: unknown): 'manual_edit' | 'ai_generate' | 'ai_redo' | 'unknown' {
  return origin === 'manual_edit' || isAIAnalysisOrigin(origin) ? origin : 'unknown';
}

/**
 * Batch 6A (P2-E): the provider that GENERATED a stored result. Always read
 * from the stored version, never from the current provider mode. `null` means
 * it was not recorded (older versions) or a person wrote it.
 */
export type ResultProvider = 'fake' | 'openai' | null;
export function normalizeResultProvider(value: unknown): ResultProvider {
  return value === 'fake' || value === 'openai' ? value : null;
}
