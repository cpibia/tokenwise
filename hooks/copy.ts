import type { Language } from './assessor'
import type { EvaluationSummary } from './evaluation'
import type { FreshStartReason } from './policy'

export type Copy = {
  header: string
  freshHeader: string
  recommend: (level: string, reason: string) => string
  needsStronger: (level: string, reason: string, cost: string) => string
  cheapSwitch: string
  costlySwitch: (thousands: number) => string
  widerHint: string
  pick: (level: string) => string
  sameModel: (level: string) => string
  wholeSession: (level: string) => string
  keep: (level: string) => string
  mute: string
  muted: string
  fresh: (reason: FreshStartReason, thousands: number) => string
  clearAndGo: string
  compactAndGo: string
  carryOn: string
  clearFallback: string
  modelNote: (name: string, id: string) => string
  status: (level: string) => string
  subagent: (description: string, level: string, reason: string) => string
  command: string
  on: string
  off: string
  reset: string
  state: (enabled: boolean, level: string | null, journal: string) => string
  evaluation: (summary: EvaluationSummary, invalid: readonly number[], report: string) => string
  evaluationMissing: (path: string) => string
  evaluationEmpty: (path: string) => string
  seeded: (count: number, path: string) => string
  seedExists: (path: string) => string
  seedEmpty: string
}

const reasonSuffix = (reason: string) => (reason ? ` (${reason})` : '')
const share = (part: number, whole: number) => `${whole ? Math.round((part / whole) * 100) : 0}%`
const signed = (value: number) => `${value > 0 ? '+' : ''}${value.toFixed(2)}`

export const COPY: Record<Language, Copy> = {
  en: {
    header: 'Model',
    freshHeader: 'Context',
    recommend: (level, reason) => `For this work I recommend ${level}${reasonSuffix(reason)}.`,
    needsStronger: (level, reason, cost) => `This needs a stronger model: ${level}${reasonSuffix(reason)}. ${cost}`,
    cheapSwitch: 'The conversation is still short, so switching now is cheap.',
    costlySwitch: thousands => `Switching re-reads the whole conversation (about ${thousands}k tokens) without the cache.`,
    widerHint: 'If heavier work follows, Opus now saves a switch later.',
    pick: level => `${level} (recommended)`,
    sameModel: level => `${level} (same model)`,
    wholeSession: level => `${level} for the whole session`,
    keep: level => `Keep ${level}`,
    mute: 'Stop asking in this session',
    muted: 'tokenwise is off for this session: /tokenwise on turns it back on',
    fresh: (reason, thousands) =>
      reason === 'new-topic'
        ? `This looks like a new task, and the conversation carries about ${thousands}k tokens that every step re-reads. Start clean?`
        : `You were away for over an hour: the cache has expired and the next step re-reads about ${thousands}k tokens at full price. Start clean?`,
    clearAndGo: 'Clear and send the request',
    compactAndGo: 'Compact and send the request',
    carryOn: 'Carry on as is',
    clearFallback: '/clear is in the prompt box: press Enter, then recall your request with ↑',
    modelNote: (name, id) =>
      `The tokenwise mod switched this request to ${name} (ID ${id}). The system prompt still names the session's model because it was composed before the switch; for your model's name and any Co-Authored-By line, this note applies.`,
    status: level => level,
    subagent: (description, level, reason) => `subagent «${description}» on ${level}${reasonSuffix(reason)}`,
    command: 'Model, effort and context advice: on, off, reset, status, eval',
    on: 'tokenwise is on: effort is set on its own, model switches and fresh starts are asked first.',
    off: 'tokenwise is off for this session.',
    reset: "Back to the session's own model and effort.",
    state: (enabled, level, journal) =>
      `tokenwise is ${enabled ? 'on' : 'off'}. Level in use: ${level ?? "the session's"}. Skip one request by starting it with ~. Journal: ${journal}`,
    evaluation: (s, invalid, report) =>
      [
        `Classifier on ${s.cases} labelled requests: ${s.exact} exact (${share(s.exact, s.cases)}), ${s.withinOne} within one tier (${share(s.withinOne, s.cases)}).`,
        `Below the label: ${s.under}. Above it: ${s.over}. Mean error: ${signed(s.meanError)} tiers.`,
        ...(s.answered < s.cases ? [`No answer for ${s.cases - s.answered}.`] : []),
        ...(invalid.length ? [`Malformed lines skipped: ${invalid.join(', ')}.`] : []),
        `Case by case: ${report}`,
      ].join(' '),
    evaluationMissing: path => `No labelled requests in ${path}. /tokenwise eval seed fills it from the journal; then set each "tier" to the right one.`,
    evaluationEmpty: path => `No labelled request in ${path} yet: set "tier" on the lines to measure.`,
    seeded: (count, path) => `${count} requests from the journal written to ${path}. Set each "tier" from 1 to 8, then run /tokenwise eval.`,
    seedExists: path => `${path} already exists and is left as it is.`,
    seedEmpty: 'The journal has no assessed request yet.',
  },
  it: {
    header: 'Modello',
    freshHeader: 'Contesto',
    recommend: (level, reason) => `Per questo lavoro consiglio ${level}${reasonSuffix(reason)}.`,
    needsStronger: (level, reason, cost) => `Serve un modello più forte: ${level}${reasonSuffix(reason)}. ${cost}`,
    cheapSwitch: 'La conversazione è ancora corta: cambiare adesso costa poco.',
    costlySwitch: thousands => `Cambiare fa rileggere tutta la conversazione (circa ${thousands}k token) senza cache.`,
    widerHint: 'Se poi arriva lavoro più pesante, Opus adesso evita un cambio dopo.',
    pick: level => `${level} (consigliato)`,
    sameModel: level => `${level} (stesso modello)`,
    wholeSession: level => `${level} per tutta la sessione`,
    keep: level => `Tieni ${level}`,
    mute: 'Non chiedere più in questa sessione',
    muted: 'tokenwise spento per questa sessione: /tokenwise on per riaccenderlo',
    fresh: (reason, thousands) =>
      reason === 'new-topic'
        ? `Sembra un lavoro nuovo, e la conversazione porta circa ${thousands}k token che ogni passo rilegge. Ricominci pulito?`
        : `Sei stato via più di un'ora: la cache è scaduta e il prossimo passo rilegge circa ${thousands}k token a prezzo pieno. Ricominci pulito?`,
    clearAndGo: 'Pulisci e invia la richiesta',
    compactAndGo: 'Compatta e invia la richiesta',
    carryOn: 'Continua così',
    clearFallback: '/clear è nella casella: premi Invio, poi recupera la richiesta con ↑',
    modelNote: (name, id) =>
      `Il mod tokenwise ha spostato questa richiesta su ${name} (ID ${id}). Il prompt di sistema nomina ancora il modello della sessione perché è stato composto prima del cambio; per il nome del tuo modello e per le righe Co-Authored-By vale questa nota.`,
    status: level => level,
    subagent: (description, level, reason) => `sotto-agente «${description}» su ${level}${reasonSuffix(reason)}`,
    command: 'Consigli su modello, effort e contesto: on, off, reset, status, eval',
    on: "tokenwise acceso: l'effort lo regolo da solo, cambi di modello e ripartenze li chiedo prima.",
    off: 'tokenwise spento per questa sessione.',
    reset: "Torno al modello e all'effort della sessione.",
    state: (enabled, level, journal) =>
      `tokenwise è ${enabled ? 'acceso' : 'spento'}. Livello in uso: ${level ?? 'quello della sessione'}. Per saltare una richiesta, iniziala con ~. Registro: ${journal}`,
    evaluation: (s, invalid, report) =>
      [
        `Classificatore su ${s.cases} richieste etichettate: ${s.exact} esatte (${share(s.exact, s.cases)}), ${s.withinOne} entro un livello (${share(s.withinOne, s.cases)}).`,
        `Sotto l'etichetta: ${s.under}. Sopra: ${s.over}. Errore medio: ${signed(s.meanError)} livelli.`,
        ...(s.answered < s.cases ? [`Senza risposta: ${s.cases - s.answered}.`] : []),
        ...(invalid.length ? [`Righe malformate saltate: ${invalid.join(', ')}.`] : []),
        `Caso per caso: ${report}`,
      ].join(' '),
    evaluationMissing: path => `Nessuna richiesta etichettata in ${path}. /tokenwise eval seed lo riempie dal registro; poi imposta "tier" al livello giusto su ogni riga.`,
    evaluationEmpty: path => `Ancora nessuna richiesta etichettata in ${path}: imposta "tier" sulle righe da misurare.`,
    seeded: (count, path) => `${count} richieste dal registro scritte in ${path}. Imposta "tier" da 1 a 8 su ognuna, poi lancia /tokenwise eval.`,
    seedExists: path => `${path} esiste già e resta com'è.`,
    seedEmpty: 'Il registro non ha ancora richieste valutate.',
  },
}
