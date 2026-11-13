import type { Assessment } from './policy'
import { TIERS, type TierId, displayName, isTier } from './tiers'

export type Language = 'en' | 'it'

export type AssessmentInput = {
  request: string
  previousReply: string
  pendingQuestion: string
  previousTier: TierId | null
  profile: string
  kind: 'request' | 'subagent'
}

const REQUEST_LIMIT = 1500
const REPLY_LIMIT = 800
const QUESTION_LIMIT = 300

const SCALE: Record<Language, Record<TierId, string>> = {
  en: {
    1: 'chat, greetings, thanks, questions about this conversation',
    2: 'look up one fact or run one command and report it; summarise what was said',
    3: 'mechanical steps with a known procedure: commit and push, rename, add a line, run an existing script',
    4: 'everyday work with a clear scope: edit a document, small local config change, answer a question by searching the project',
    5: 'work that needs judgment or is costly to get wrong: implement a feature, write new scripts, deploys, production systems, client data, weighing options, valuations and decisions with money at stake, messages to clients or management',
    6: 'diagnosing something broken or a behaviour that differs from what was expected, irreversible operations in production, long unattended work that must be right',
    7: 'very long autonomous work, several intermittent defects together, ambiguous causes, architecture decisions, audits',
    8: 'only when tier 7 already failed on this problem, or the reasoning is exceptionally hard (open research problems)',
  },
  it: {
    1: 'chiacchiera, saluti, ringraziamenti, domande su questa conversazione',
    2: 'leggere un dato o lanciare un comando e riferire; riassumere quanto detto',
    3: 'passi meccanici con procedura nota: commit e push, rinominare, aggiungere una riga, lanciare uno script esistente',
    4: 'lavoro quotidiano con perimetro chiaro: modificare un documento, piccola modifica di configurazione locale, rispondere cercando nel progetto',
    5: 'lavoro che chiede giudizio o costa se sbagliato: implementare una funzionalità, scrivere script nuovi, deploy, sistemi in produzione, dati dei clienti, valutare opzioni, stime e decisioni con soldi in gioco, messaggi a clienti o dirigenti',
    6: 'diagnosi di qualcosa di rotto o di un comportamento diverso da quello atteso, operazioni irreversibili in produzione, lavori lunghi in autonomia da fare bene',
    7: 'lavori autonomi molto lunghi, più difetti intermittenti insieme, cause ambigue, decisioni di architettura, audit',
    8: 'solo se il livello 7 ha già fallito su questo problema, o il ragionamento è eccezionalmente difficile (problemi di ricerca aperti)',
  },
}

const RULES: Record<Language, string> = {
  en: `You size the work a Claude Code request sets in motion. Claude Code works on the user's machines with a shell, files, git, the web and connected tools. Pick the CHEAPEST tier that gets the job right the first time: redoing botched work costs more than a stronger model.

Rules:
- Judge the work the request starts, not the length of its text. A short "yes" weighs as much as the work it approves in the excerpt.
- Work without code or files weighs the same: an answer the user will act on (a price, an authenticity check, a bid, advice on a decision) is sized by the cost of getting it wrong, not by the tools it needs.
- Between two tiers, pick the higher one.
- Requests are often hurried and have typos; they may be in any language.
- "newTopic": true only if the request starts work unrelated to the excerpt of the conversation (a different project, file set or problem). Follow-ups, fixes and next steps of the same work are false. With no excerpt, false.
- "rework": true only if the request says the last result is wrong, broken, incomplete or must be redone.`,
  it: `Valuti il lavoro che una richiesta a Claude Code mette in moto. Claude Code lavora sulle macchine dell'utente con shell, file, git, web e strumenti collegati. Scegli il livello PIÙ ECONOMICO che fa il lavoro bene al primo colpo: rifare un lavoro sbagliato costa più di un modello più forte.

Regole:
- Giudica il lavoro che la richiesta avvia, non la lunghezza del testo. Un "sì" breve vale quanto il lavoro che approva nell'estratto.
- Il lavoro senza codice né file pesa allo stesso modo: una risposta su cui l'utente agirà (un prezzo, una verifica di autenticità, un'offerta, un consiglio su una decisione) si misura dal costo di sbagliarla, non dagli strumenti che richiede.
- Tra due livelli, scegli il più alto.
- Le richieste sono spesso scritte in fretta e con refusi, in qualsiasi lingua.
- "newTopic": true solo se la richiesta avvia un lavoro scollegato dall'estratto della conversazione (altro progetto, altri file, altro problema). Seguiti, correzioni e passi successivi dello stesso lavoro sono false. Senza estratto, false.
- "rework": true solo se la richiesta dice che l'ultimo risultato è sbagliato, rotto, incompleto o da rifare.`,
}

const SUBAGENT_RULES: Record<Language, string> = {
  en: `You size the work in a brief that a Claude Code session wrote for a subagent, which carries it out without seeing the conversation. Pick the CHEAPEST tier that gets it right the first time. Searching, reading and listing files is cheap even when the brief is long; what counts is the judgment needed and the cost of a mistake. "newTopic" and "rework" are always false.`,
  it: `Valuti il lavoro descritto nel brief che una sessione di Claude Code ha scritto per un sotto-agente, che lo esegue senza vedere la conversazione. Scegli il livello PIÙ ECONOMICO che lo fa bene al primo colpo. Cercare, leggere ed elencare file costa poco anche con un brief lungo; contano il giudizio richiesto e il costo di un errore. "newTopic" e "rework" sono sempre false.`,
}

const LABELS: Record<Language, { tiers: string; profile: string; excerpt: string; asked: string; previous: string; request: string; brief: string; answer: string }> = {
  en: {
    tiers: 'Tiers',
    profile: "The user's own note about their work",
    excerpt: "End of the assistant's last reply",
    asked: 'The assistant then asked',
    previous: 'The previous request was tier',
    request: "The user's request",
    brief: "The subagent's brief",
    answer: 'Answer with JSON only',
  },
  it: {
    tiers: 'Livelli',
    profile: "Nota dell'utente sul proprio lavoro",
    excerpt: "Fine dell'ultima risposta dell'assistente",
    asked: "Poi l'assistente ha chiesto",
    previous: 'La richiesta precedente era di livello',
    request: "Richiesta dell'utente",
    brief: 'Brief del sotto-agente',
    answer: 'Rispondi solo con JSON',
  },
}

export function buildSystem(language: Language, kind: AssessmentInput['kind'], profile: string): string {
  const labels = LABELS[language]
  const scale = (Object.keys(TIERS) as unknown as TierId[])
    .map(id => `${id} = ${displayName(TIERS[id].model, TIERS[id].effort)}: ${SCALE[language][id]}`)
    .join('\n')
  const note = profile ? `\n\n${labels.profile}:\n${profile}` : ''

  return `${kind === 'request' ? RULES[language] : SUBAGENT_RULES[language]}

${labels.tiers}:
${scale}${note}

${labels.answer}: {"tier": <1-8>, "reason": "<12 words at most>", "newTopic": <true|false>, "rework": <true|false>}`
}

export function buildPrompt(language: Language, input: AssessmentInput): string {
  const labels = LABELS[language]
  const parts: string[] = []
  if (input.previousReply) {
    parts.push(`${labels.excerpt}:\n«${input.previousReply.slice(-REPLY_LIMIT)}»`)
  }
  if (input.pendingQuestion) {
    parts.push(`${labels.asked}: «${input.pendingQuestion.slice(0, QUESTION_LIMIT)}»`)
  }
  if (input.previousTier !== null) {
    parts.push(`${labels.previous} ${input.previousTier}.`)
  }
  const heading = input.kind === 'request' ? labels.request : labels.brief
  parts.push(`${heading}:\n"""\n${input.request.slice(0, REQUEST_LIMIT)}\n"""`)

  return parts.join('\n\n')
}

/** Reads the classifier's answer; anything malformed counts as no assessment. */
export function parseAssessment(answer: string): Assessment | null {
  const start = answer.indexOf('{')
  const end = answer.lastIndexOf('}')
  if (start < 0 || end <= start) {
    return null
  }
  try {
    const parsed = JSON.parse(answer.slice(start, end + 1)) as Record<string, unknown>
    const tier = Number(parsed.tier)
    if (!isTier(tier)) {
      return null
    }

    return {
      tier,
      reason: typeof parsed.reason === 'string' ? parsed.reason.trim().replace(/\.$/, '') : '',
      newTopic: parsed.newTopic === true,
      rework: parsed.rework === true,
    }
  } catch {
    return null
  }
}
