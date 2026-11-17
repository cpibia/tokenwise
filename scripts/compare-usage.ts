/**
 * Compares Claude Code token spend before and after tokenwise, from the local transcripts.
 *
 *   scripts/compare-usage.sh [--from YYYY-MM-DD] [--days 7] [--classifier sonnet|haiku] [--markdown]
 *   scripts/compare-usage.sh --before YYYY-MM-DD --after YYYY-MM-DD [--days 1]
 *   scripts/compare-usage.sh --requests 800 [--from YYYY-MM-DD]
 *   scripts/compare-usage.sh --classify [--concurrency 6]
 *
 * Two fixed windows of --days each, split at --from (default: the first journal day), or starting
 * on the --before and --after days, which compares whole days. With --requests N the windows hold
 * a number of requests instead of days: the last N typed before --from against the first N typed
 * in tokenwise sessions from --from on, so both groups are the same size. Activity in the first window forms
 * the "before" group; activity of journal sessions in the second window forms the "with" group.
 * Activity outside the two windows is ignored, so a later run gives the same figures. Sessions in
 * the second window that ran without tokenwise, or started before it was installed, are counted
 * but left out of both groups.
 *
 * --classify sizes every request of both groups with the tokenwise classifier, through `claude -p`
 * on Sonnet, and keeps the tiers in ~/.claude/tokenwise/history-tiers.json; later runs reuse them
 * and only size requests not seen before. With tiers known, the report adds the cost per request
 * at each tier and the cost the "with" group would have had on the "before" group's mix of work.
 */
import { spawn } from 'node:child_process'
import { createReadStream, existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { registerHooks } from 'node:module'
import { homedir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { createInterface } from 'node:readline'

// The plugin's modules import each other without the .ts extension, as its runtime expects.
registerHooks({
  resolve(specifier, context, nextResolve) {
    try {
      return nextResolve(specifier, context)
    } catch (error) {
      if (specifier.startsWith('.') && !specifier.endsWith('.ts')) {
        return nextResolve(`${specifier}.ts`, context)
      }
      throw error
    }
  },
})
const { buildPrompt, buildSystem, parseAssessment } = await import('../hooks/assessor.ts')

type Price = { input: number; output: number; cacheRead: number }

// List prices in USD per million tokens. Cache writes are priced from `input`.
const PRICES: Record<string, Price> = {
  'claude-haiku-5-5': { input: 0.1, output: 0.5, cacheRead: 0.01 },
  'claude-sonnet-5-5': { input: 2, output: 10, cacheRead: 0.1 },
  'claude-opus-5-5': { input: 4, output: 20, cacheRead: 0.2 },
  'claude-fable-5-2': { input: 8, output: 40, cacheRead: 0.2 },
  'claude-fable-5-1': { input: 10, output: 50, cacheRead: 1 },
  'claude-fable-5': { input: 10, output: 50, cacheRead: 1 },
  'claude-opus-5': { input: 5, output: 25, cacheRead: 0.5 },
  'claude-opus-4-8': { input: 5, output: 25, cacheRead: 0.5 },
  'claude-opus-4-7': { input: 5, output: 25, cacheRead: 0.5 },
  'claude-opus-4-6': { input: 5, output: 25, cacheRead: 0.5 },
  'claude-sonnet-5': { input: 2, output: 10, cacheRead: 0.2 },
  'claude-sonnet-4-6': { input: 3, output: 15, cacheRead: 0.3 },
  'claude-haiku-4-5': { input: 1, output: 5, cacheRead: 0.1 },
}
const CACHE_WRITE_5M = 1.25
const CACHE_WRITE_1H = 2

// Classifier call size from the prompt budget in hooks/assessor.ts, not from billing.
const CLASSIFIER_INPUT_TOKENS = 1_250
const CLASSIFIER_OUTPUT_TOKENS = 150
const CLASSIFIER_MODELS: Record<string, string> = { sonnet: 'claude-sonnet-5-5', haiku: 'claude-haiku-5-5' }

const DAY_MS = 86_400_000

const localDay = (time: number): string => new Date(time).toLocaleDateString('sv-SE')

// Calendar arithmetic, so a window crossing a daylight saving change still spans whole days.
function addDays(time: number, days: number): number {
  const date = new Date(time)
  date.setDate(date.getDate() + days)

  return date.getTime()
}

type Range = { from: number; to: number }
type Group = 'before' | 'after'
type Windows = Record<Group, Range>

function groupAt(time: number, windows: Windows): Group | undefined {
  for (const group of ['before', 'after'] as const) {
    if (time >= windows[group].from && time < windows[group].to) {
      return group
    }
  }

  return undefined
}

function parseDay(value: string, flag: string): number {
  const time = /^\d{4}-\d{2}-\d{2}$/.test(value) ? new Date(`${value}T00:00:00`).getTime() : NaN
  if (Number.isNaN(time) || localDay(time) !== value) {
    console.error(`--${flag} must be a date such as 2026-11-12, not "${value}".`)
    process.exit(1)
  }

  return time
}

type Usage = {
  input_tokens?: number
  output_tokens?: number
  cache_read_input_tokens?: number
  cache_creation_input_tokens?: number
  cache_creation?: { ephemeral_5m_input_tokens?: number; ephemeral_1h_input_tokens?: number }
}

type SessionStats = {
  startedAt: number
  requests: number
  calls: number
  subagentCalls: number
  contextTokens: number
  outputTokens: number
  costByModel: Map<string, number>
  requestsByFamily: Map<string, number>
  unpricedCalls: number
  requestTimes: number[]
  callFamilies: { time: number; family: string; cost: number }[]
  typedRequests: TypedRequest[]
}

type TypedRequest = { key: string; time: number; text: string; previousReply: string }

type JournalLine = { session?: string; kind?: string; tier?: number; outcome?: string; time?: string }

function argument(name: string, fallback: string): string {
  const index = process.argv.indexOf(`--${name}`)

  return index > 0 && process.argv[index + 1] ? process.argv[index + 1]! : fallback
}

function configDirectory(): string {
  return process.env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude')
}

function priceFor(model: string): Price | undefined {
  return PRICES[model] ?? PRICES[model.replace(/-\d{8}$/, '')]
}

function costOf(model: string, usage: Usage): number | null {
  const price = priceFor(model)
  if (!price) {
    return null
  }
  const written = usage.cache_creation_input_tokens ?? 0
  const written1h = usage.cache_creation?.ephemeral_1h_input_tokens ?? 0
  const written5m = usage.cache_creation ? (usage.cache_creation.ephemeral_5m_input_tokens ?? 0) : written

  return (
    ((usage.input_tokens ?? 0) * price.input +
      written5m * price.input * CACHE_WRITE_5M +
      written1h * price.input * CACHE_WRITE_1H +
      (usage.cache_read_input_tokens ?? 0) * price.cacheRead +
      (usage.output_tokens ?? 0) * price.output) /
    1_000_000
  )
}

function readJournal(): JournalLine[] {
  const directory = join(configDirectory(), 'tokenwise')
  if (!existsSync(directory)) {
    return []
  }

  return readdirSync(directory)
    .filter(name => name.endsWith('.jsonl'))
    .flatMap(name => readFileSync(join(directory, name), 'utf8').split('\n'))
    .filter(line => line.trim())
    .flatMap(line => {
      try {
        return [JSON.parse(line) as JournalLine]
      } catch {
        return []
      }
    })
}

function transcriptFiles(directory: string, since: number): string[] {
  const files: string[] = []
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) {
      files.push(...transcriptFiles(path, since))
    } else if (entry.name.endsWith('.jsonl') && statSync(path).mtimeMs >= since) {
      files.push(path)
    }
  }

  return files
}

/** Subagent transcripts live in <session>/subagents/, and count toward that session. */
function sessionIdOf(path: string): string {
  const parent = dirname(path)

  return basename(parent) === 'subagents' ? basename(dirname(parent)) : basename(path, '.jsonl')
}

// Turns Claude Code writes in the person's name: command output, notifications, the summary that
// opens a compacted session and the marker left by an interrupted reply.
const GENERATED_TURN =
  /^\s*(<(command-|local-command|bash-|task-notification)|\[Request interrupted|This session is being continued from a previous conversation)/

/** The text of a request the person typed, or '' for tool results, commands and other generated turns. */
function typedText(record: {
  isMeta?: boolean
  isSidechain?: boolean
  isCompactSummary?: boolean
  message?: { content?: unknown }
}): string {
  if (record.isMeta || record.isSidechain || record.isCompactSummary) {
    return ''
  }
  const content = record.message?.content
  const text =
    typeof content === 'string'
      ? content
      : Array.isArray(content) && content.every(block => block?.type !== 'tool_result')
        ? content.map(block => (block?.type === 'text' ? String(block.text ?? '') : '')).join('')
        : ''

  return text.trim() !== '' && !GENERATED_TURN.test(text) ? text.trim() : ''
}

function assistantText(content: unknown): string {
  return Array.isArray(content)
    ? content.map(block => (block?.type === 'text' ? String(block.text ?? '') : '')).join('\n').trim()
    : ''
}

async function scanFile(
  path: string,
  windows: Windows,
  sessions: Record<Group, Map<string, SessionStats>>,
  firstSeen: Map<string, number>,
  seenMessages: Set<string>,
): Promise<void> {
  const id = sessionIdOf(path)
  const isSubagent = path.includes('/subagents/')
  const lines = createInterface({ input: createReadStream(path), crlfDelay: Infinity })
  let awaitingAnswer = false
  let lastReply = ''

  for await (const line of lines) {
    if (!line.includes('"role":"assistant"') && !line.includes('"role":"user"')) {
      continue
    }
    let record: any
    try {
      record = JSON.parse(line)
    } catch {
      continue
    }
    const time = Date.parse(record.timestamp ?? '')
    if (Number.isNaN(time)) {
      continue
    }
    firstSeen.set(id, Math.min(time, firstSeen.get(id) ?? Infinity))
    const group = groupAt(time, windows)
    if (!group) {
      continue
    }
    let stats = sessions[group].get(id)
    if (!stats) {
      stats = {
        startedAt: time,
        requests: 0,
        calls: 0,
        subagentCalls: 0,
        contextTokens: 0,
        outputTokens: 0,
        costByModel: new Map(),
        requestsByFamily: new Map(),
        unpricedCalls: 0,
        requestTimes: [],
        callFamilies: [],
        typedRequests: [],
      }
      sessions[group].set(id, stats)
    }
    if (time < stats.startedAt) {
      stats.startedAt = time
    }

    if (record.type === 'user') {
      const text = isSubagent ? '' : typedText(record)
      if (text) {
        stats.requests++
        stats.requestTimes.push(time)
        stats.typedRequests.push({ key: `${id}:${time}`, time, text, previousReply: lastReply })
        lastReply = ''
        awaitingAnswer = true
      }
      continue
    }

    const message = record.message
    const reply = isSubagent ? '' : assistantText(message?.content)
    if (reply) {
      lastReply = lastReply ? `${lastReply}\n${reply}` : reply
    }
    const usage: Usage | undefined = message?.usage
    const messageId: string = message?.id ?? record.requestId ?? record.uuid
    if (!usage || !message.model || message.model === '<synthetic>') {
      continue
    }
    // A request counts for the model that gave its first answer: the level tokenwise set for it.
    if (awaitingAnswer && !isSubagent) {
      const name = family(message.model)
      stats.requestsByFamily.set(name, (stats.requestsByFamily.get(name) ?? 0) + 1)
      awaitingAnswer = false
    }
    if (seenMessages.has(messageId)) {
      continue
    }
    seenMessages.add(messageId)

    const cost = costOf(message.model, usage)
    stats.calls++
    stats.callFamilies.push({ time, family: family(message.model), cost: cost ?? 0 })
    if (isSubagent) {
      stats.subagentCalls++
    }
    stats.contextTokens +=
      (usage.input_tokens ?? 0) + (usage.cache_read_input_tokens ?? 0) + (usage.cache_creation_input_tokens ?? 0)
    stats.outputTokens += usage.output_tokens ?? 0
    if (cost === null) {
      stats.unpricedCalls++
    } else {
      stats.costByModel.set(message.model, (stats.costByModel.get(message.model) ?? 0) + cost)
    }
  }
}

type GroupSummary = {
  sessions: number
  requests: number
  calls: number
  subagentCalls: number
  contextTokens: number
  outputTokens: number
  cost: number
  costByModel: Map<string, number>
  requestsByFamily: Map<string, number>
  unpricedCalls: number
  requestsByModelSet: Map<string, number>
}

const FAMILIES = ['Haiku', 'Sonnet', 'Opus', 'Fable']

/**
 * The models each request used, its subagents included. Subagent transcripts carry no link to the
 * request that started them, so a call belongs to the last request typed before it.
 */
function modelSetsOf(session: SessionStats): string[] {
  const requests = [...session.requestTimes].sort((x, y) => x - y)
  const used = requests.map(() => new Set<string>())
  for (const call of session.callFamilies) {
    let index = requests.length - 1
    while (index >= 0 && requests[index]! > call.time) {
      index--
    }
    if (index >= 0) {
      used[index]!.add(call.family)
    }
  }

  return used
    .filter(set => set.size > 0)
    .map(set => [...set].sort((x, y) => FAMILIES.indexOf(x) - FAMILIES.indexOf(y)).join(' + '))
}

/** Each typed request with the cost of its calls and its subagents' calls, by the same rule as modelSetsOf. */
function requestCostsOf(session: SessionStats): { key: string; cost: number }[] {
  const requests = [...session.typedRequests].sort((x, y) => x.time - y.time)
  const costs = requests.map(() => 0)
  for (const call of session.callFamilies) {
    let index = requests.length - 1
    while (index >= 0 && requests[index]!.time > call.time) {
      index--
    }
    if (index >= 0) {
      costs[index]! += call.cost
    }
  }

  return requests.map((request, index) => ({ key: request.key, cost: costs[index]! }))
}

type Tiers = Record<string, number>

const TIERS_FILE = 'history-tiers.json'
const CLASSIFY_MODEL = 'claude-sonnet-5-5'
const CLASSIFY_TIMEOUT_MS = 90_000

function tiersPath(): string {
  return join(configDirectory(), 'tokenwise', TIERS_FILE)
}

function readTiers(): Tiers {
  try {
    return JSON.parse(readFileSync(tiersPath(), 'utf8')) as Tiers
  } catch {
    return {}
  }
}

/** One classifier call through `claude -p`, with the plugin's own instructions and no tools. */
function classifyOne(system: string, prompt: string): Promise<{ tier: number | null; cost: number }> {
  return new Promise(resolve => {
    const child = spawn(
      'claude',
      ['-p', '--model', CLASSIFY_MODEL, '--effort', 'low', '--system-prompt', system, '--tools', '', '--setting-sources', '', '--strict-mcp-config', '--no-session-persistence', '--output-format', 'json', prompt],
      { stdio: ['ignore', 'pipe', 'ignore'] },
    )
    let output = ''
    const timer = setTimeout(() => child.kill(), CLASSIFY_TIMEOUT_MS)
    child.stdout.on('data', chunk => (output += chunk))
    child.on('close', () => {
      clearTimeout(timer)
      try {
        const parsed = JSON.parse(output) as { result?: string; total_cost_usd?: number }
        resolve({ tier: parseAssessment(parsed.result ?? '')?.tier ?? null, cost: parsed.total_cost_usd ?? 0 })
      } catch {
        resolve({ tier: null, cost: 0 })
      }
    })
  })
}

/**
 * Sizes the requests of the given sessions that have no tier yet. A session is sized in order, so
 * each request sees the tier of the one before, as it would live; sessions run side by side.
 */
async function classify(stats: SessionStats[], tiers: Tiers, concurrency: number): Promise<void> {
  const pending = stats.filter(session => session.typedRequests.some(request => tiers[request.key] === undefined))
  const total = pending.reduce((sum, session) => sum + session.typedRequests.filter(r => tiers[r.key] === undefined).length, 0)
  if (total === 0) {
    return
  }
  const system = buildSystem('en', 'request', '')
  let done = 0
  let failed = 0
  let spent = 0
  const report = (): void => {
    process.stderr.write(`\rSizing past requests: ${done} of ${total}, $${spent.toFixed(2)} spent${failed ? `, ${failed} unanswered` : ''}   `)
  }
  report()

  const queue = [...pending]
  const worker = async (): Promise<void> => {
    for (let session = queue.shift(); session; session = queue.shift()) {
      let previousTier: number | null = null
      for (const request of [...session.typedRequests].sort((x, y) => x.time - y.time)) {
        if (tiers[request.key] === undefined) {
          const prompt = buildPrompt('en', {
            kind: 'request',
            request: request.text,
            previousReply: request.previousReply,
            pendingQuestion: '',
            previousTier: previousTier as never,
            profile: '',
          })
          const result = await classifyOne(system, prompt)
          spent += result.cost
          done++
          if (result.tier === null) {
            failed++
          } else {
            tiers[request.key] = result.tier
          }
          report()
        }
        previousTier = tiers[request.key] ?? null
      }
      writeFileSync(tiersPath(), JSON.stringify(tiers))
    }
  }
  await Promise.all(Array.from({ length: concurrency }, worker))
  process.stderr.write('\n')
}

const TIER_BANDS: { label: string; tiers: number[] }[] = [
  { label: 'Tiers 1-2', tiers: [1, 2] },
  { label: 'Tiers 3-4', tiers: [3, 4] },
  { label: 'Tiers 5-6', tiers: [5, 6] },
  { label: 'Tiers 7-8', tiers: [7, 8] },
]

type BandCosts = { count: number; cost: number }[]

function bandCostsOf(stats: SessionStats[], tiers: Tiers): { bands: BandCosts; sized: number; total: number } {
  const bands = TIER_BANDS.map(() => ({ count: 0, cost: 0 }))
  let sized = 0
  let total = 0
  for (const session of stats) {
    for (const { key, cost } of requestCostsOf(session)) {
      total++
      const band = TIER_BANDS.findIndex(entry => entry.tiers.includes(tiers[key] ?? 0))
      if (band >= 0) {
        sized++
        bands[band]!.count++
        bands[band]!.cost += cost
      }
    }
  }

  return { bands, sized, total }
}

function summarize(stats: SessionStats[]): GroupSummary {
  const summary: GroupSummary = {
    sessions: stats.length,
    requests: 0,
    calls: 0,
    subagentCalls: 0,
    contextTokens: 0,
    outputTokens: 0,
    cost: 0,
    costByModel: new Map(),
    requestsByFamily: new Map(),
    unpricedCalls: 0,
    requestsByModelSet: new Map(),
  }
  for (const session of stats) {
    for (const set of modelSetsOf(session)) {
      summary.requestsByModelSet.set(set, (summary.requestsByModelSet.get(set) ?? 0) + 1)
    }
    summary.requests += session.requests
    summary.calls += session.calls
    summary.subagentCalls += session.subagentCalls
    summary.contextTokens += session.contextTokens
    summary.outputTokens += session.outputTokens
    summary.unpricedCalls += session.unpricedCalls
    for (const [model, cost] of session.costByModel) {
      summary.cost += cost
      summary.costByModel.set(model, (summary.costByModel.get(model) ?? 0) + cost)
    }
    for (const [name, count] of session.requestsByFamily) {
      summary.requestsByFamily.set(name, (summary.requestsByFamily.get(name) ?? 0) + count)
    }
  }

  return summary
}

function family(model: string): string {
  return /haiku/.test(model) ? 'Haiku' : /sonnet/.test(model) ? 'Sonnet' : /opus/.test(model) ? 'Opus' : /fable/.test(model) ? 'Fable' : model
}

function share(summary: GroupSummary, name: string): number {
  let total = 0
  for (const [model, cost] of summary.costByModel) {
    if (family(model) === name) {
      total += cost
    }
  }

  return summary.cost > 0 ? total / summary.cost : 0
}

function modelSetCount(summary: GroupSummary, set: string): string {
  let count = 0
  for (const [key, value] of summary.requestsByModelSet) {
    if (set === '+' ? key.includes('+') : key === set) {
      count += value
    }
  }

  return `${count} of ${summary.requests}`
}

function answeredBy(summary: GroupSummary, name: string): string {
  const count = summary.requestsByFamily.get(name) ?? 0

  return `${count} of ${summary.requests}`
}

const money = (value: number): string => `$${value.toFixed(value < 1 ? 3 : 2)}`
const thousands = (value: number): string => `${Math.round(value / 1000)}k`
const percent = (value: number): string => (value > 0 && value < 0.005 ? '<1%' : `${Math.round(value * 100)}%`)

function delta(before: number, after: number): number | undefined {
  return before ? (after - before) / before : undefined
}

const signedMoney = (value: number): string => `${value < 0 ? '-' : '+'}${money(Math.abs(value))}`
const signed = (value: number): string => `${value > 0 ? '+' : ''}${Math.round(value * 100)}%`

type Row = { label: string; before: string; after: string; delta?: number; difference?: string }

const changeText = (row: Row): string =>
  row.delta === undefined ? '' : `${signed(row.delta)}${row.difference ? ` (${row.difference})` : ''}`
type Section = { title: string; rows: Row[] }

function renderMarkdown(period: string, sections: Section[], notes: string[]): string {
  const lines = [period, '', '| | Before | With tokenwise | Change |', '| --- | ---: | ---: | ---: |']
  for (const section of sections) {
    lines.push(`| **${section.title}** | | | |`)
    for (const row of section.rows) {
      lines.push(`| ${row.label} | ${row.before} | ${row.after} | ${changeText(row)} |`)
    }
  }

  return [...lines, '', ...notes.map(note => `_${note}_`)].join('\n')
}

function renderTerminal(period: string, sections: Section[], notes: string[]): string {
  const colored = process.stdout.isTTY && !process.env.NO_COLOR
  const paint = (code: string, text: string): string => (colored ? `\x1b[${code}m${text}\x1b[0m` : text)
  const bold = (text: string): string => paint('1', text)
  const dim = (text: string): string => paint('2', text)

  const headers = ['', 'Before', 'With tokenwise', 'Change']
  const rows = sections.flatMap(section => section.rows)
  const widths = [
    Math.max(...rows.map(row => row.label.length + 2), ...sections.map(section => section.title.length)),
    Math.max(headers[1]!.length, ...rows.map(row => row.before.length)),
    Math.max(headers[2]!.length, ...rows.map(row => row.after.length)),
    Math.max(headers[3]!.length, ...rows.map(row => changeText(row).length)),
  ]
  const rule = (left: string, middle: string, right: string): string =>
    dim(`${left}${widths.map(width => '─'.repeat(width + 2)).join(middle)}${right}`)
  const line = (cells: string[]): string => `${dim('│')} ${cells.join(` ${dim('│')} `)} ${dim('│')}`

  // Every metric with a change is one where lower means cheaper, so a fall is good news.
  const changeCell = (row: Row): string => {
    const value = row.delta
    const text = changeText(row).padStart(widths[3]!)
    if (value === undefined || Math.abs(value) < 0.005) {
      return text
    }

    return paint(value < 0 ? '32;1' : '31;1', text)
  }

  const output = ['', bold('tokenwise: before and after'), dim(period), '', rule('┌', '┬', '┐')]
  output.push(line(headers.map((header, index) => bold(index === 0 ? header.padEnd(widths[0]!) : header.padStart(widths[index]!)))))
  for (const section of sections) {
    output.push(rule('├', '┼', '┤'))
    output.push(line([paint('36;1', section.title.padEnd(widths[0]!)), ' '.repeat(widths[1]!), ' '.repeat(widths[2]!), ' '.repeat(widths[3]!)]))
    for (const row of section.rows) {
      output.push(
        line([
          `  ${row.label}`.padEnd(widths[0]!),
          dim(row.before.padStart(widths[1]!)),
          bold(row.after.padStart(widths[2]!)),
          changeCell(row),
        ]),
      )
    }
  }
  output.push(rule('└', '┴', '┘'), '', ...notes.map(note => dim(`· ${note}`)), '')

  return output.join('\n')
}

/**
 * Cost per request at each tier, and the headline figure that takes the mix of work out of the
 * comparison: what the "with" group would cost per request on the "before" group's tier mix.
 */
function tierSections(before: SessionStats[], after: SessionStats[], tiers: Tiers, classifierCost: number): Section[] {
  const a = bandCostsOf(before, tiers)
  const b = bandCostsOf(after, tiers)
  if (a.sized === 0 || b.sized === 0) {
    return []
  }
  const classifierPerRequest = b.total ? classifierCost / b.total : 0
  const perRequest = (band: { count: number; cost: number }, extra = 0): number => (band.count ? band.cost / band.count + extra : 0)
  const rows: Row[] = TIER_BANDS.map((band, index) => {
    const x = a.bands[index]!
    const y = b.bands[index]!
    const costBefore = perRequest(x)
    const costAfter = perRequest(y, classifierPerRequest)

    return {
      label: `${band.label} (${x.count} / ${y.count})`,
      before: x.count ? money(costBefore) : '',
      after: y.count ? money(costAfter) : '',
      delta: x.count && y.count ? delta(costBefore, costAfter) : undefined,
    }
  })
  let mixBefore = 0
  let mixAfter = 0
  let covered = 0
  a.bands.forEach((x, index) => {
    const y = b.bands[index]!
    if (x.count && y.count) {
      mixBefore += x.cost
      mixAfter += x.count * perRequest(y, classifierPerRequest)
      covered += x.count
    }
  })
  const sameMixBefore = covered ? mixBefore / covered : 0
  const sameMixAfter = covered ? mixAfter / covered : 0

  return [
    {
      title: 'Same work, by tier',
      rows: [
        ...rows,
        {
          label: 'On the before mix of work',
          before: money(sameMixBefore),
          after: money(sameMixAfter),
          delta: delta(sameMixBefore, sameMixAfter),
          difference: signedMoney(sameMixAfter - sameMixBefore),
        },
      ],
    },
  ]
}

function tierNotes(before: SessionStats[], after: SessionStats[], tiers: Tiers): string[] {
  const a = bandCostsOf(before, tiers)
  const b = bandCostsOf(after, tiers)
  if (a.sized === 0 && b.sized === 0) {
    return ['Run with --classify to size past requests and compare the cost of the same kind of work.']
  }
  const missing = a.total - a.sized + (b.total - b.sized)

  return [
    `Same work, by tier: both groups sized afterwards by the current classifier (counts before / with). ${missing ? `${missing} ${missing === 1 ? 'request has' : 'requests have'} no tier yet; --classify sizes them.` : ''}`.trim(),
  ]
}

type Groups = { before: SessionStats[]; withTokenwise: SessionStats[]; leftOut: number }

/**
 * Reads the transcripts into the two windows. Sessions in the second window that ran without
 * tokenwise, or started before it was installed, are counted in leftOut and kept out of both groups.
 */
async function scanGroups(windows: Windows, tokenwiseSessions: Set<string>, installDay: number): Promise<Groups> {
  const sessions: Record<Group, Map<string, SessionStats>> = { before: new Map(), after: new Map() }
  const firstSeen = new Map<string, number>()
  const seenMessages = new Set<string>()
  for (const file of transcriptFiles(join(configDirectory(), 'projects'), windows.before.from)) {
    await scanFile(file, windows, sessions, firstSeen, seenMessages)
  }

  const withTokenwise: SessionStats[] = []
  let leftOut = 0
  // A session opened before tokenwise was installed would blur the comparison, even if the journal later saw it.
  for (const [id, stats] of sessions.after) {
    if (tokenwiseSessions.has(id) && (firstSeen.get(id) ?? 0) >= installDay) {
      withTokenwise.push(stats)
    } else {
      leftOut++
    }
  }

  return { before: [...sessions.before.values()], withTokenwise, leftOut }
}

// How far back --requests looks for the "before" group.
const REQUEST_LOOKBACK_DAYS = 90

/**
 * Windows that hold the last `count` requests before installDay and the first `count` requests of
 * tokenwise sessions from installDay on. The second window ends where request count + 1 starts, so
 * the calls of the last request are cut there when another session is already running.
 */
async function requestWindows(count: number, installDay: number, tokenwiseSessions: Set<string>): Promise<Windows> {
  const wide: Windows = {
    before: { from: addDays(installDay, -REQUEST_LOOKBACK_DAYS), to: installDay },
    after: { from: installDay, to: Date.now() + 1 },
  }
  const groups = await scanGroups(wide, tokenwiseSessions, installDay)
  const beforeTimes = groups.before.flatMap(session => session.requestTimes).sort((x, y) => y - x)
  const afterTimes = groups.withTokenwise.flatMap(session => session.requestTimes).sort((x, y) => x - y)

  return {
    before: { from: beforeTimes[Math.min(count, beforeTimes.length) - 1] ?? installDay, to: installDay },
    after: { from: installDay, to: afterTimes[count] ?? wide.after.to },
  }
}

function sessionsInJournal(journal: JournalLine[], range: Range): Set<string> {
  return new Set(
    journal
      .filter(line => {
        const time = Date.parse(line.time ?? '')
        return time >= range.from && time < range.to
      })
      .map(line => line.session)
      .filter((id): id is string => Boolean(id)),
  )
}

async function main(): Promise<void> {
  const beforeDay = argument('before', '')
  const afterDay = argument('after', '')
  if (Boolean(beforeDay) !== Boolean(afterDay)) {
    console.error('--before and --after go together: give both days.')
    process.exit(1)
  }
  const requestCount = process.argv.includes('--requests') ? Number(argument('requests', '')) : 0
  if (process.argv.includes('--requests') && (!Number.isInteger(requestCount) || requestCount < 1)) {
    console.error(`--requests must be a whole number of requests, not "${argument('requests', '')}".`)
    process.exit(1)
  }
  if (requestCount && beforeDay) {
    console.error('--requests compares the requests on each side of --from: leave out --before and --after.')
    process.exit(1)
  }
  const days = Number(argument('days', beforeDay ? '1' : '7'))
  if (!Number.isInteger(days) || days < 1) {
    console.error(`--days must be a whole number of days, not "${argument('days', '')}".`)
    process.exit(1)
  }
  const classifierModel = CLASSIFIER_MODELS[argument('classifier', 'sonnet')] ?? CLASSIFIER_MODELS.sonnet!

  const journal = readJournal()
  if (journal.length === 0) {
    console.error('No tokenwise journal found: use Claude Code with tokenwise for a while, then run this again.')
    process.exit(1)
  }
  const firstUse = Math.min(...journal.map(line => Date.parse(line.time ?? '')).filter(time => !Number.isNaN(time)))
  const from = argument('from', '')
  const installDay = from ? parseDay(from, 'from') : new Date(firstUse).setHours(0, 0, 0, 0)

  let windows: Windows
  let tokenwiseSessions: Set<string>
  if (requestCount) {
    // Sessions are matched to the journal over the whole period, so the cut at request N cannot drop one.
    tokenwiseSessions = sessionsInJournal(journal, { from: installDay, to: Infinity })
    windows = await requestWindows(requestCount, installDay, tokenwiseSessions)
  } else {
    const beforeStart = beforeDay ? parseDay(beforeDay, 'before') : addDays(installDay, -days)
    const afterStart = afterDay ? parseDay(afterDay, 'after') : installDay
    windows = {
      before: { from: beforeStart, to: addDays(beforeStart, days) },
      after: { from: afterStart, to: addDays(afterStart, days) },
    }
    if (windows.before.to > windows.after.from) {
      console.error('The before window must end by the time the after window starts.')
      process.exit(1)
    }
    tokenwiseSessions = sessionsInJournal(journal, windows.after)
  }
  const windowEnd = windows.after.to
  const journalLines = journal.filter(line => {
    const time = Date.parse(line.time ?? '')
    return time >= windows.after.from && time < windowEnd
  })

  const { before, withTokenwise, leftOut } = await scanGroups(windows, tokenwiseSessions, installDay)

  const tiers = readTiers()
  if (process.argv.includes('--classify')) {
    const concurrency = Number(argument('concurrency', '6'))
    await classify([...before, ...withTokenwise], tiers, Number.isInteger(concurrency) && concurrency > 0 ? concurrency : 6)
  }

  const a = summarize(before)
  const b = summarize(withTokenwise)
  const assessed = journalLines.filter(line => line.tier !== undefined).length
  const classifierPrice = PRICES[classifierModel]!
  const classifierCost =
    (assessed * (CLASSIFIER_INPUT_TOKENS * classifierPrice.input + CLASSIFIER_OUTPUT_TOKENS * classifierPrice.output)) /
    1_000_000
  const freshStarts = journalLines.filter(line => line.kind === 'fresh-start')
  const freshAccepted = freshStarts.filter(line => /clear|compact/i.test(line.outcome ?? '')).length
  const afterTotal = b.cost + classifierCost

  const ratio = (value: number, total: number): number => (total ? value / total : 0)
  const sections: Section[] = [
    {
      title: 'Volume',
      rows: [
        { label: 'Sessions', before: `${a.sessions}`, after: `${b.sessions}` },
        { label: 'Requests typed', before: `${a.requests}`, after: `${b.requests}` },
        { label: 'Clean starts accepted', before: '', after: `${freshAccepted} of ${freshStarts.length}` },
      ],
    },
    {
      title: 'Cost at list prices',
      rows: [
        { label: 'Total', before: money(a.cost), after: money(afterTotal) },
        { label: 'of which classifier', before: '', after: money(classifierCost) },
        {
          label: 'Per request',
          before: money(ratio(a.cost, a.requests)),
          after: money(ratio(afterTotal, b.requests)),
          delta: delta(ratio(a.cost, a.requests), ratio(afterTotal, b.requests)),
          difference: signedMoney(ratio(afterTotal, b.requests) - ratio(a.cost, a.requests)),
        },
      ],
    },
    ...tierSections(before, withTokenwise, tiers, classifierCost),
    {
      title: 'Work per request',
      rows: [
        { label: 'Model calls', before: ratio(a.calls, a.requests).toFixed(1), after: ratio(b.calls, b.requests).toFixed(1), delta: delta(ratio(a.calls, a.requests), ratio(b.calls, b.requests)) },
        { label: 'Context read per call', before: thousands(ratio(a.contextTokens, a.calls)), after: thousands(ratio(b.contextTokens, b.calls)), delta: delta(ratio(a.contextTokens, a.calls), ratio(b.contextTokens, b.calls)) },
        { label: 'Output tokens', before: thousands(ratio(a.outputTokens, a.requests)), after: thousands(ratio(b.outputTokens, b.requests)), delta: delta(ratio(a.outputTokens, a.requests), ratio(b.outputTokens, b.requests)) },
        { label: 'Calls made by subagents', before: percent(ratio(a.subagentCalls, a.calls)), after: percent(ratio(b.subagentCalls, b.calls)) },
      ],
    },
    {
      title: 'Share of cost by model',
      rows: FAMILIES.map(name => ({ label: name, before: percent(share(a, name)), after: percent(share(b, name)) })),
    },
    {
      title: 'Requests answered by',
      rows: FAMILIES.map(name => ({
        label: name,
        before: answeredBy(a, name),
        after: answeredBy(b, name),
      })),
    },
    {
      title: 'Models used per request',
      rows: [
        ...[...new Set([...a.requestsByModelSet.keys(), ...b.requestsByModelSet.keys()])]
          .sort((x, y) => (b.requestsByModelSet.get(y) ?? 0) - (b.requestsByModelSet.get(x) ?? 0) || (a.requestsByModelSet.get(y) ?? 0) - (a.requestsByModelSet.get(x) ?? 0))
          .map(set => ({ label: set.includes('+') ? set : `${set} only`, before: modelSetCount(a, set), after: modelSetCount(b, set) })),
        { label: 'Two or more models', before: modelSetCount(a, '+'), after: modelSetCount(b, '+') },
      ],
    },
  ]

  const daysElapsed = Math.ceil((Math.min(Date.now(), windowEnd) - windows.after.from) / DAY_MS)
  const openWindowNotes = requestCount
    ? [
        ...(b.requests < requestCount ? [`Only ${b.requests} of ${requestCount} requests with tokenwise so far: the figures settle once there are ${requestCount}.`] : []),
        ...(a.requests < requestCount ? [`Only ${a.requests} requests in the ${REQUEST_LOOKBACK_DAYS} days before tokenwise.`] : []),
      ]
    : Date.now() < windowEnd
      ? [`The second window is still open: day ${daysElapsed} of ${days}. The figures settle on ${localDay(windowEnd)}.`]
      : []
  const notes = [
    ...openWindowNotes,
    ...(leftOut ? [`${leftOut} sessions in the second window ran without tokenwise, or started before it, and are left out.`] : []),
    ...(a.unpricedCalls + b.unpricedCalls ? [`${a.unpricedCalls + b.unpricedCalls} calls on models with no price in PRICES are left out of the cost.`] : []),
    'Models used per request counts the calls of the request and its subagents; the tokenwise classifier runs outside the transcript and is not among them.',
    `The classifier cost is an estimate: ${assessed} calls on ${classifierModel}, about ${CLASSIFIER_INPUT_TOKENS} input and ${CLASSIFIER_OUTPUT_TOKENS} output tokens each.`,
    ...tierNotes(before, withTokenwise, tiers),
  ]
  const label = (range: Range): string =>
    days === 1 ? localDay(range.from) : `${localDay(range.from)} to ${localDay(addDays(range.to, -1))}`
  const requestLabel = (count: number, range: Range): string =>
    `${count} requests, ${localDay(range.from)} to ${localDay(Math.min(range.to, Date.now()) - 1)}`
  const period = requestCount
    ? `Before: the last ${requestLabel(a.requests, windows.before)}. With tokenwise: the first ${requestLabel(b.requests, windows.after)}.`
    : `Before: ${label(windows.before)}. With tokenwise: ${label(windows.after)}.`

  console.log(process.argv.includes('--markdown') ? renderMarkdown(period, sections, notes) : renderTerminal(period, sections, notes))
}

await main()
