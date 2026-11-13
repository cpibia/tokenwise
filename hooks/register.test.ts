import type { AgentSpawnInput } from 'claude-code'
import { expect, test } from 'claude-code/testing'

function spawnRequest(fields: Pick<AgentSpawnInput, 'prompt' | 'description' | 'subagentType'> & { model?: string }): AgentSpawnInput {
  return {
    tool_use_id: 'toolu_test',
    provider: { plugin: 'core', tier: 'builtin' } as AgentSpawnInput['provider'],
    parentModel: 'claude-opus-5-5',
    background: false,
    fork: false,
    ...fields,
  }
}

function answerWith(text: string) {
  return () => ({
    value: { isAnswered: true as const, text, usage: { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } },
  })
}

test('a generic subagent starts on the model its brief needs', async ($, on) => {
  let spawnedWith: string | undefined
  on('session.surfaces', () => ({ value: ['terminal' as const] }))
  on('model.complete', answerWith('{"tier": 2, "reason": "file search", "newTopic": false, "rework": false}'))
  on('agent.spawn', (_, e) => {
    spawnedWith = e.model

    return { model: e.model ?? 'claude-opus-5-5', agentId: 'agent-1' }
  })

  await $.agent.spawn(spawnRequest({ prompt: 'List the PHP controllers under app/Http', description: 'find controllers', subagentType: 'Explore' }))

  expect(spawnedWith).toBe('claude-haiku-5-5')
})

test("a subagent the session gave a model keeps it", async ($, on) => {
  let spawnedWith: string | undefined
  on('session.surfaces', () => ({ value: ['terminal' as const] }))
  on('model.complete', answerWith('{"tier": 6, "reason": "diagnosis", "newTopic": false, "rework": false}'))
  on('agent.spawn', (_, e) => {
    spawnedWith = e.model

    return { model: e.model ?? 'claude-opus-5-5', agentId: 'agent-2' }
  })

  await $.agent.spawn(spawnRequest({ prompt: 'Find why the queue stalls', description: 'diagnose', subagentType: 'general-purpose', model: 'claude-sonnet-5-5' }))

  expect(spawnedWith).toBe('claude-sonnet-5-5')
})

test('nothing is assessed when nobody is watching', async ($, on) => {
  let classifierCalls = 0
  on('session.surfaces', () => ({ value: [] }))
  on('model.complete', () => {
    classifierCalls++

    return answerWith('{"tier": 2}')()
  })
  on('agent.spawn', (_, e) => ({ model: e.model ?? 'claude-opus-5-5', agentId: 'agent-3' }))

  await $.agent.spawn(spawnRequest({ prompt: 'List files', description: 'list', subagentType: 'Explore' }))

  expect(classifierCalls).toBe(0)
})

test('a light question on an Opus session runs on Haiku', async ($, on) => {
  let steppedWith = ''
  on('turn.step', async function* (_, e) {
    steppedWith = e.model

    return { turnId: e.turnId, index: e.index, answer: '', toolUses: [], stopReason: null, usage: null }
  })
  on('session.surfaces', () => ({ value: ['terminal' as const] }))
  on('session.model', () => ({ value: 'claude-opus-5-5' }))
  on('session.messages', () => ({ value: [] }))
  on('session.usage', () => ({ value: { startedAt: 0, context: { tokens: 20_000, window: 1_000_000 }, rateLimits: [] } }))
  on('model.complete', answerWith('{"tier": 2, "reason": "today\'s date", "newTopic": false, "rework": false}'))
  on('clock.now', () => ({ value: Date.UTC(2026, 10, 12) }))
  on('config.list', () => ({ value: [] }))
  on('env.get', () => ({ value: undefined }))
  on('fs.exists', () => ({ value: false }))
  on('fs.write', () => ({ value: undefined }))
  on('ui.status', () => ({ value: undefined }))
  on('ui.invalidate', () => ({ value: undefined }))
  on('ui.log', () => ({ value: undefined }))
  on('prompt.submit', (_, e) => ({ text: e.text }) as never)

  await $.prompt.submit({ text: 'ciao che giorno è oggi?', wait: false, origin: { kind: 'composer' } })

  for await (const _ of $.turn.step({ turnId: 'turn-1', index: 0, model: 'claude-opus-5-5', effort: 'medium', messageCount: 1 })) {
    // The step's chunks are not under test.
  }

  expect(steppedWith).toBe('claude-haiku-5-5')
})

test('everyday work opening an Opus session runs on Sonnet', async ($, on) => {
  let steppedWith = ''
  on('turn.step', async function* (_, e) {
    steppedWith = `${e.model} ${e.effort}`

    return { turnId: e.turnId, index: e.index, answer: '', toolUses: [], stopReason: null, usage: null }
  })
  on('session.surfaces', () => ({ value: ['terminal' as const] }))
  on('session.model', () => ({ value: 'claude-opus-5-5' }))
  on('session.messages', () => ({ value: [] }))
  on('session.usage', () => ({ value: { startedAt: 0, context: { tokens: 5_000, window: 1_000_000 }, rateLimits: [] } }))
  on('model.complete', answerWith('{"tier": 4, "reason": "write today\'s reviews", "newTopic": false, "rework": false}'))
  on('clock.now', () => ({ value: Date.UTC(2026, 10, 12) }))
  on('config.list', () => ({ value: [] }))
  on('env.get', () => ({ value: undefined }))
  on('fs.exists', () => ({ value: false }))
  on('fs.write', () => ({ value: undefined }))
  on('ui.status', () => ({ value: undefined }))
  on('ui.invalidate', () => ({ value: undefined }))
  on('ui.log', () => ({ value: undefined }))
  on('prompt.submit', (_, e) => ({ text: e.text }) as never)

  await $.prompt.submit({ text: 'ciao dobbiamo fare le recensioni di oggi', wait: false, origin: { kind: 'composer' } })

  for await (const _ of $.turn.step({ turnId: 'turn-1', index: 0, model: 'claude-opus-5-5', effort: 'medium', messageCount: 1 })) {
    // The step's chunks are not under test.
  }

  expect(steppedWith).toBe('claude-sonnet-5-5 high')
})
