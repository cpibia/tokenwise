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

export async function journalPath($: EngineInterface, now: number): Promise<string> {
  return `${await journalDirectory($)}/${new Date(now).toISOString().slice(0, 10)}.jsonl`
}

/**
 * Adds one line to today's journal. The file API has no append, so the day's file is
 * rewritten; one file per day keeps that cheap. A failure never reaches the person.
 */
export async function record($: EngineInterface, entry: JournalEntry): Promise<void> {
  try {
    const now = await $.clock.now()
    const path = await journalPath($, now)
    const existing = (await $.fs.exists(path)) ? String(await $.fs.read(path)) : ''
    const line = JSON.stringify({
      time: new Date(now).toISOString(),
      session: await $.session.id(),
      cwd: await $.session.cwd(),
      ...entry,
      ...(entry.text === undefined ? {} : { text: entry.text.replace(/\s+/g, ' ').slice(0, TEXT_LIMIT) }),
    })
    await $.fs.write(path, `${existing}${line}\n`)
  } catch (error) {
    $.ui.log(`journal not written (${String(error)})`, { to: 'debug' })
  }
}
