import type { EngineInterface } from 'claude-code'

export type JournalEntry = {
  kind: 'request' | 'subagent' | 'override' | 'fresh-start'
  text?: string
  tier?: number
  reason?: string
  outcome: string
  rework?: boolean
  contextTokens?: number
}

const TEXT_LIMIT = 160

let directory: string | null = null

export async function journalDirectory($: EngineInterface): Promise<string> {
  if (directory === null) {
    const configured = await $.env.get('CLAUDE_CONFIG_DIR')
    const home = await $.env.get('HOME')
    directory = `${configured || `${home ?? ''}/.claude`}/tokenwise`
  }

  return directory
}

export async function journalPath($: EngineInterface, now: number, session: string): Promise<string> {
  return `${await journalDirectory($)}/${new Date(now).toISOString().slice(0, 10)}.${session}.jsonl`
}

let pending: Promise<void> = Promise.resolve()

/**
 * Adds one line to the journal. The file API has no append, so the file is read and
 * rewritten: one file per session and day keeps other sessions from overwriting it, and
 * the queue keeps this session's own hooks from doing the same. A failure never reaches
 * the person.
 */
export function record($: EngineInterface, entry: JournalEntry): Promise<void> {
  pending = pending.then(() => write($, entry))

  return pending
}

async function write($: EngineInterface, entry: JournalEntry): Promise<void> {
  try {
    const now = await $.clock.now()
    const session = await $.session.id()
    const path = await journalPath($, now, session)
    const existing = (await $.fs.exists(path)) ? String(await $.fs.read(path)) : ''
    const line = JSON.stringify({
      time: new Date(now).toISOString(),
      session,
      cwd: await $.session.cwd(),
      ...entry,
      ...(entry.text === undefined ? {} : { text: entry.text.replace(/\s+/g, ' ').slice(0, TEXT_LIMIT) }),
    })
    await $.fs.write(path, `${existing}${line}\n`)
  } catch (error) {
    $.ui.log(`journal not written (${String(error)})`, { to: 'debug' })
  }
}
