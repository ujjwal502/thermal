import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import { extractUsage } from '../src/proxy/usage.ts'

test('reads Chat Completions usage', () => {
  const body = JSON.stringify({ usage: { prompt_tokens: 3290, prompt_tokens_details: { cached_tokens: 3200 } } })
  assert.deepEqual(extractUsage(body, 'openai'), { promptTokens: 3290, cachedTokens: 3200 })
})

test('reads Responses API usage, which spells the same fields differently', () => {
  const body = JSON.stringify({ usage: { input_tokens: 3565, input_tokens_details: { cached_tokens: 3171 } } })
  assert.deepEqual(extractUsage(body, 'openai'), { promptTokens: 3565, cachedTokens: 3171 })
})

test('reads Anthropic usage, summing the three input buckets', () => {
  const body = JSON.stringify({
    usage: { input_tokens: 10, cache_read_input_tokens: 900, cache_creation_input_tokens: 90 },
  })
  assert.deepEqual(extractUsage(body, 'anthropic'), { promptTokens: 1000, cachedTokens: 900, writtenTokens: 90 })
})

test('an Anthropic response without a cache write count leaves it unknown, not zero', () => {
  const body = JSON.stringify({ usage: { input_tokens: 10, cache_read_input_tokens: 900 } })
  assert.equal(extractUsage(body, 'anthropic')?.writtenTokens, undefined)
})

test('reads usage out of an SSE stream', () => {
  const body = [
    'event: message_start',
    'data: {"message":{"usage":{"input_tokens":5,"cache_read_input_tokens":500}}}',
    '',
    'data: [DONE]',
  ].join('\n')
  assert.deepEqual(extractUsage(body, 'anthropic'), { promptTokens: 505, cachedTokens: 500 })
})

test('returns nothing rather than zero when there is no usage to read', () => {
  assert.equal(extractUsage('{"content":[]}', 'openai'), undefined)
  assert.equal(extractUsage('not json at all', 'openai'), undefined)
})
