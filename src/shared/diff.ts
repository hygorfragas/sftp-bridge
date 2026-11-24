import type { DiffLine } from './types.ts'

export interface ComputedDiff {
  added: number
  removed: number
  truncated: boolean
  lines: DiffLine[]
}

/**
 * Computes a clean unified line diff between `existingText` (destination) and `incomingText` (source).
 * Uses LCS dynamic programming for normal files and falls back to bounded prefix/suffix diff for huge files.
 */
export function computeLineDiff(
  existingText: string,
  incomingText: string,
  maxOutputLines = 400
): ComputedDiff {
  const oldLines = existingText.replace(/\r\n/g, '\n').split('\n')
  const newLines = incomingText.replace(/\r\n/g, '\n').split('\n')

  // Trim common prefix and suffix for speed
  let prefix = 0
  const minLen = Math.min(oldLines.length, newLines.length)
  while (prefix < minLen && oldLines[prefix] === newLines[prefix]) {
    prefix++
  }

  let suffix = 0
  while (
    suffix < minLen - prefix &&
    oldLines[oldLines.length - 1 - suffix] === newLines[newLines.length - 1 - suffix]
  ) {
    suffix++
  }

  const midOld = oldLines.slice(prefix, oldLines.length - suffix)
  const midNew = newLines.slice(prefix, newLines.length - suffix)

  const raw: DiffLine[] = []
  let added = 0
  let removed = 0

  // Include up to 2 context lines before diff
  const ctxStart = Math.max(0, prefix - 2)
  for (let i = ctxStart; i < prefix; i++) {
    raw.push({ kind: 'same', oldLine: i + 1, newLine: i + 1, text: oldLines[i] })
  }

  if (midOld.length * midNew.length <= 250_000) {
    // Exact LCS table
    const n = midOld.length
    const m = midNew.length
    const dp = new Uint32Array((n + 1) * (m + 1))
    const stride = m + 1

    for (let i = n - 1; i >= 0; i--) {
      for (let j = m - 1; j >= 0; j--) {
        if (midOld[i] === midNew[j]) {
          dp[i * stride + j] = dp[(i + 1) * stride + (j + 1)] + 1
        } else {
          const a = dp[(i + 1) * stride + j]
          const b = dp[i * stride + (j + 1)]
          dp[i * stride + j] = a >= b ? a : b
        }
      }
    }

    let i = 0
    let j = 0
    while (i < n && j < m) {
      if (midOld[i] === midNew[j]) {
        raw.push({
          kind: 'same',
          oldLine: prefix + i + 1,
          newLine: prefix + j + 1,
          text: midOld[i]
        })
        i++
        j++
      } else if (dp[(i + 1) * stride + j] >= dp[i * stride + (j + 1)]) {
        raw.push({ kind: 'remove', oldLine: prefix + i + 1, text: midOld[i] })
        removed++
        i++
      } else {
        raw.push({ kind: 'add', newLine: prefix + j + 1, text: midNew[j] })
        added++
        j++
      }
    }
    while (i < n) {
      raw.push({ kind: 'remove', oldLine: prefix + i + 1, text: midOld[i] })
      removed++
      i++
    }
    while (j < m) {
      raw.push({ kind: 'add', newLine: prefix + j + 1, text: midNew[j] })
      added++
      j++
    }
  } else {
    // Linear fallback for very large files
    for (let i = 0; i < midOld.length; i++) {
      raw.push({ kind: 'remove', oldLine: prefix + i + 1, text: midOld[i] })
      removed++
    }
    for (let j = 0; j < midNew.length; j++) {
      raw.push({ kind: 'add', newLine: prefix + j + 1, text: midNew[j] })
      added++
    }
  }

  // Include up to 2 context lines after diff
  const ctxEnd = Math.min(suffix, 2)
  for (let k = 0; k < ctxEnd; k++) {
    const oldIdx = oldLines.length - suffix + k
    const newIdx = newLines.length - suffix + k
    raw.push({ kind: 'same', oldLine: oldIdx + 1, newLine: newIdx + 1, text: oldLines[oldIdx] })
  }

  // Filter out long runs of unchanged lines (keep 2 lines around changes)
  const keep = new Uint8Array(raw.length)
  for (let idx = 0; idx < raw.length; idx++) {
    if (raw[idx].kind !== 'same') {
      for (let d = Math.max(0, idx - 2); d <= Math.min(raw.length - 1, idx + 2); d++) {
        keep[d] = 1
      }
    }
  }
  const compact = added === 0 && removed === 0 ? [] : raw.filter((_, idx) => keep[idx] === 1)
  const truncated = compact.length > maxOutputLines

  return {
    added,
    removed,
    truncated,
    lines: truncated ? compact.slice(0, maxOutputLines) : compact
  }
}
