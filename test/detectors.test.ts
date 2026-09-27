import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import { cacheNeverRead } from '../src/detectors/cache-never-read.ts'
import { prefixInvalidated } from '../src/detectors/prefix-invalidated.ts'
import { ttlPremiumWasted } from '../src/detectors/ttl-premium-wasted.ts'
import { cachingNetNegative } from '../src/detectors/caching-net-negative.ts'
import type { Turn } from '../src/types.ts'

const BASE = new Date('2026-09-01T12:00:00Z').getTime()

function turn(offsetSeconds: number, fields: Partial<Turn> = {}): Turn {
  return {
    sessionId: 's1',
    project: 'test',
    requestId: `r${offsetSeconds}`,
    timestamp: new Date(BASE + offsetSeconds * 1000),
    model: 'claude-opus-5',
    inputTokens: 10,
    cacheReadTokens: 0,
    cacheWrite5mTokens: 0,
    cacheWrite1hTokens: 0,
    outputTokens: 100,
    ...fields,
  }
}

test('cache-never-read flags a session that writes cache and never reads it', () => {
  const findings = cacheNeverRead.run([
    turn(0, { cacheWrite5mTokens: 50_000 }),
    turn(10, { cacheWrite5mTokens: 50_000 }),
  ])
  assert.equal(findings.length, 1)
  assert.equal(findings[0]?.occurrences, 1)
  assert.ok(findings[0] !== undefined && findings[0].wastedUSD > 0)
})

test('cache-never-read ignores a session whose cache is read', () => {
  const findings = cacheNeverRead.run([
    turn(0, { cacheWrite5mTokens: 50_000 }),
    turn(10, { cacheReadTokens: 50_000 }),
  ])
  assert.deepEqual(findings, [])
})

test('cache-never-read ignores a single-turn session, which cannot read its own new cache', () => {
  assert.deepEqual(cacheNeverRead.run([turn(0, { cacheWrite5mTokens: 50_000 })]), [])
})

test('prefix-invalidated flags a warm cache going cold and being rebuilt', () => {
  const findings = prefixInvalidated.run([
    turn(0, { cacheReadTokens: 80_000 }),
    turn(10, { cacheWrite5mTokens: 80_000 }),
  ])
  assert.equal(findings.length, 1)
  assert.equal(findings[0]?.occurrences, 1)
})

test('prefix-invalidated ignores a cold start, where no cache existed to lose', () => {
  const findings = prefixInvalidated.run([
    turn(0, { cacheWrite5mTokens: 80_000 }),
    turn(10, { cacheReadTokens: 80_000 }),
  ])
  assert.deepEqual(findings, [])
})

test('ttl-premium-wasted flags a 1h write on continuous work a 5m cache would have covered', () => {
  const findings = ttlPremiumWasted.run([
    turn(0, { cacheWrite1hTokens: 100_000 }),
    turn(30, { cacheReadTokens: 100_000 }),
  ])
  assert.equal(findings.length, 1)
  assert.equal(findings[0]?.occurrences, 1)
})

test('ttl-premium-wasted ignores a 1h write followed by a long enough idle gap', () => {
  const findings = ttlPremiumWasted.run([
    turn(0, { cacheWrite1hTokens: 100_000 }),
    turn(300, { cacheReadTokens: 100_000 }),
  ])
  assert.deepEqual(findings, [])
})

test('caching-net-negative flags a session whose writes outran its read savings', () => {
  const findings = cachingNetNegative.run([
    turn(0, { cacheWrite5mTokens: 200_000 }),
    turn(10, { cacheReadTokens: 1_000 }),
  ])
  assert.equal(findings.length, 1)
})

test('caching-net-negative ignores a session whose reads repaid the writes', () => {
  const findings = cachingNetNegative.run([
    turn(0, { cacheWrite5mTokens: 10_000 }),
    turn(10, { cacheReadTokens: 900_000 }),
  ])
  assert.deepEqual(findings, [])
})

test('caching-net-negative leaves never-read sessions to cache-never-read rather than double-counting', () => {
  assert.deepEqual(
    cachingNetNegative.run([turn(0, { cacheWrite5mTokens: 200_000 }), turn(10, { cacheWrite5mTokens: 200_000 })]),
    [],
  )
})
