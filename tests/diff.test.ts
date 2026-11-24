import { assert, test } from 'orca/testing'
import { computeLineDiff } from '../src/shared/diff.ts'

test('computeLineDiff returns empty lines for identical text', () => {
  const res = computeLineDiff('a\nb\nc', 'a\r\nb\r\nc')
  assert.equal(res.added, 0)
  assert.equal(res.removed, 0)
  assert.equal(res.lines.length, 0)
})

test('computeLineDiff detects additions, removals and context lines accurately', () => {
  const existing = ['line 1', 'line 2', 'old line 3', 'line 4'].join('\n')
  const incoming = ['line 1', 'line 2', 'new line 3', 'extra line', 'line 4'].join('\n')
  const res = computeLineDiff(existing, incoming)
  assert.equal(res.removed, 1)
  assert.equal(res.added, 2)
  assert.ok(res.lines.some((l) => l.kind === 'remove' && l.text === 'old line 3'))
  assert.ok(res.lines.some((l) => l.kind === 'add' && l.text === 'new line 3'))
  assert.ok(res.lines.some((l) => l.kind === 'add' && l.text === 'extra line'))
})
