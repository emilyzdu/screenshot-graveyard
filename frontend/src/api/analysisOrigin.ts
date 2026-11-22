/** Version origins defined by ArtifactVersion. Missing or unfamiliar values carry no attribution. */
export function isAIAnalysisOrigin(origin: unknown): origin is 'ai_generate' | 'ai_redo' {
  return origin === 'ai_generate' || origin === 'ai_redo';
}

export function normalizeAnalysisOrigin(origin: unknown): 'manual_edit' | 'ai_generate' | 'ai_redo' | 'unknown' {
  return origin === 'manual_edit' || isAIAnalysisOrigin(origin) ? origin : 'unknown';
}
