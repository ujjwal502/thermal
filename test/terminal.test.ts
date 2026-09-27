import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import { wrap } from '../src/report/terminal.ts'

const detail =
  '15 times a warm cache went cold and was rebuilt from scratch. Anthropic attributed some of these: ' +
  'previous_message_not_found x2, model_changed x1, messages_changed x1.'

test('wrapped report lines fit the width and never split a word', () => {
  const lines = wrap(detail, 60)
  assert.ok(lines.every((line) => line.length <= 60), lines.join('\n'))
  assert.equal(lines.join(' '), detail)
})

test('a word longer than the width gets its own line rather than being cut', () => {
  assert.deepEqual(wrap('see previous_message_not_found here', 10), ['see', 'previous_message_not_found', 'here'])
})
