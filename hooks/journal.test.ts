import { expect, test } from 'claude-code/testing'

test('subagents started together all reach the journal, in a file of their session', async ($, on) => {
  const files = new Map<string, string>()
  on('session.surfaces', () => ({ value: ['terminal' as const] }))
  on('session.id', () => ({ value: 'session-a' }))
  on('session.cwd', () => ({ value: '/work' }))
  on('clock.now', () => ({ value: Date.UTC(2026, 10, 13) }))
  on('config.list', () => ({ value: [] }))
  on('env.get', (_, e) => ({ value: e.name === 'HOME' ? '/home/test' : undefined }))
  on('ui.log', () => ({ value: undefined }))
  on('model.complete', () => ({
    value: {
      isAnswered: true as const,
      text: '{"tier": 2, "reason": "file search", "newTopic": false, "rework": false}',
      usage: { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
    },
  }))
  on('fs.exists', (_, e) => ({ value: files.has(e.path) }))
  on('fs.read', async (_, e) => {
    const text = files.get(e.path) ?? ''
    await Promise.resolve()

    return { value: text }
  })
  on('fs.write', (_, e) => {
    files.set(e.path, e.text)

    return { value: undefined }
  })
  let spawned = 0
  on('agent.spawn', (_, e) => ({ model: e.model ?? 'claude-opus-5-5', agentId: `agent-${++spawned}` }))

  await Promise.all(
    ['first', 'second', 'third'].map(description =>
      $.agent.spawn({
        tool_use_id: `toolu_${description}`,
        provider: { plugin: 'core', tier: 'builtin' } as never,
        parentModel: 'claude-opus-5-5',
        background: false,
        fork: false,
        subagentType: 'Explore',
        description,
        prompt: 'List the PHP controllers under app/Http',
      }),
    ),
  )

  expect([...files.keys()]).toEqual(['/home/test/.claude/tokenwise/2026-11-13.session-a.jsonl'])
  const texts = [...files.values()][0]!.trim().split('\n').map(line => (JSON.parse(line) as { text: string }).text)
  expect(texts.sort()).toEqual(['first', 'second', 'third'])
})
