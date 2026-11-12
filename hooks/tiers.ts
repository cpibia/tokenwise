export type Effort = 'low' | 'medium' | 'high' | 'xhigh' | 'max'
export type Family = 'haiku' | 'sonnet' | 'opus' | 'fable'
export type TierId = 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8

export type Level = { model: string; effort: Effort }

export const EFFORTS: readonly Effort[] = ['low', 'medium', 'high', 'xhigh', 'max']

export const TIERS: Record<TierId, Level> = {
  1: { model: 'claude-haiku-5-5', effort: 'low' },
  2: { model: 'claude-haiku-5-5', effort: 'medium' },
  3: { model: 'claude-sonnet-5-5', effort: 'medium' },
  4: { model: 'claude-sonnet-5-5', effort: 'high' },
  5: { model: 'claude-opus-5-5', effort: 'medium' },
  6: { model: 'claude-opus-5-5', effort: 'high' },
  7: { model: 'claude-opus-5-5', effort: 'xhigh' },
  8: { model: 'claude-fable-5-2', effort: 'high' },
}

export const TOP_TIER: TierId = 8

const STRENGTH: Record<Family, number> = { haiku: 0, sonnet: 1, opus: 2, fable: 3 }

// A stronger model covers lighter tiers at a lower effort. Mechanical tiers (1-3) run at low
// effort on Opus and Fable; Fable keeps its default effort for anything that needs judgment.
const EFFORT_BY_FAMILY: Record<Family, Partial<Record<TierId, Effort>>> = {
  haiku: { 1: 'low', 2: 'medium' },
  sonnet: { 1: 'low', 2: 'low', 3: 'medium', 4: 'high' },
  opus: { 1: 'low', 2: 'low', 3: 'low', 4: 'medium', 5: 'medium', 6: 'high', 7: 'xhigh' },
  fable: { 1: 'low', 2: 'low', 3: 'low', 4: 'medium', 5: 'high', 6: 'high', 7: 'high', 8: 'high' },
}

const CEILING_EFFORT: Record<Family, Effort> = { haiku: 'high', sonnet: 'high', opus: 'xhigh', fable: 'high' }

export function familyOf(model: string): Family {
  const match = /(haiku|sonnet|opus|fable)/.exec(model.toLowerCase())?.[1]

  return (match as Family | undefined) ?? 'opus'
}

export function isTier(value: unknown): value is TierId {
  return Number.isInteger(value) && (value as number) >= 1 && (value as number) <= TOP_TIER
}

export function clampTier(value: number): TierId {
  return Math.min(TOP_TIER, Math.max(1, Math.round(value))) as TierId
}

export function isStrongerFamily(a: string, b: string): boolean {
  return STRENGTH[familyOf(a)] > STRENGTH[familyOf(b)]
}

export function sameFamily(a: string, b: string): boolean {
  return familyOf(a) === familyOf(b)
}

/** The effort the given model needs for a tier, or null when the model is too weak for it. */
export function effortOn(model: string, tier: TierId): Effort | null {
  return EFFORT_BY_FAMILY[familyOf(model)][tier] ?? null
}

export function ceilingEffort(model: string): Effort {
  return CEILING_EFFORT[familyOf(model)]
}

export function compareEffort(a: Effort, b: Effort): number {
  return EFFORTS.indexOf(a) - EFFORTS.indexOf(b)
}

export function asEffort(value: unknown): Effort | null {
  return typeof value === 'string' && (EFFORTS as readonly string[]).includes(value) ? (value as Effort) : null
}

export function displayName(model: string, effort?: Effort | null): string {
  const lower = model.toLowerCase()
  const family = /(haiku|sonnet|opus|fable)/.exec(lower)?.[1]
  const [, major, minor] = /(?:haiku|sonnet|opus|fable)-(\d+)(?:-(\d{1,2}))?(?!\d)/.exec(lower) ?? []
  const base = family
    ? `${family[0]!.toUpperCase()}${family.slice(1)}${major ? ` ${major}${minor ? `.${minor}` : ''}` : ''}`
    : model

  return effort ? `${base} · ${effort}` : base
}
