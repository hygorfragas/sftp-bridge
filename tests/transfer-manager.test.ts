import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { assert, test } from 'orca/testing'
import type { RemoteTransport } from '../src/worker/transport-types.ts'
import { TransferManager } from '../src/worker/transfer-manager.ts'

/** In-memory fake RemoteTransport supporting byte-offset reads/writes for deterministic tests. */
function createMemoryTransport(
  delayMs = 5,
  hostId = 'test-host',
  hostName = 'Test Host'
): RemoteTransport & { files: Map<string, Buffer> } {
  const files = new Map<string, Buffer>()
  const handles = new Map<string, string>()
  let nextHandle = 1

  const wait = () => new Promise<void>((r) => setTimeout(r, delayMs))

  return {
    hostId,
    hostName,
    mode: 'ssh2-sftp',
    isAlive: true,
    files,
    async realpath(p) {
      return p
    },
    async listDir() {
      return { path: '/', entries: [] }
    },
    async stat(p) {
      const buf = files.get(p)
      if (!buf) throw new Error(`ENOENT: ${p}`)
      return { size: buf.length, mtimeMs: Date.now(), mode: 0o100644, isDirectory: false, isSymlink: false }
    },
    async mkdir() {
      return ''
    },
    async mkdirRecursive() {},
    async createFile() {
      return ''
    },
    async rename() {
      return ''
    },
    async renameExact(oldPath, newPath) {
      const buf = files.get(oldPath)
      if (!buf) throw new Error(`ENOENT: ${oldPath}`)
      files.set(newPath, buf)
      files.delete(oldPath)
    },
    async deletePaths() {
      return 0
    },
    async chmod() {},
    async readText() {
      throw new Error('not used')
    },
    async readBytes(remotePath) {
      const b = files.get(remotePath)
      if (!b) throw new Error(`ENOENT: ${remotePath}`)
      return b
    },
    async writeText() {
      return { mtimeMs: Date.now(), size: 0 }
    },
    async openHandle(remotePath, flags) {
      const key = `h${nextHandle++}`
      handles.set(key, remotePath)
      // Truncate if creating fresh without resume
      if ((flags & 0x10) !== 0) {
        files.set(remotePath, Buffer.alloc(0))
      } else if (!files.has(remotePath)) {
        files.set(remotePath, Buffer.alloc(0))
      }
      return Buffer.from(key)
    },
    async readChunk(handle, buffer, offset, length, position) {
      await wait()
      const remotePath = handles.get(handle.toString())!
      const src = files.get(remotePath) || Buffer.alloc(0)
      if (position >= src.length) return 0
      const end = Math.min(src.length, position + length)
      src.copy(buffer, offset, position, end)
      return end - position
    },
    async writeChunk(handle, buffer, offset, length, position) {
      await wait()
      const remotePath = handles.get(handle.toString())!
      const prev = files.get(remotePath) || Buffer.alloc(0)
      const needed = position + length
      const next = needed > prev.length ? Buffer.concat([prev, Buffer.alloc(needed - prev.length)]) : Buffer.from(prev)
      buffer.copy(next, position, offset, offset + length)
      files.set(remotePath, next)
    },
    async closeHandle(handle) {
      handles.delete(handle.toString())
    },
    async unlink(remotePath) {
      files.delete(remotePath)
    },
    async compress() {
      return ''
    },
    async extract() {
      return ''
    },
    async searchRecursive() {
      return { results: [], truncated: false }
    },
    startTail() {
      return { stop: () => {} }
    },
    destroy() {}
  }
}

async function waitFor(predicate: () => boolean, timeoutMs = 4000): Promise<void> {
  const start = Date.now()
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) throw new Error('Timed out waiting for condition')
    await new Promise((r) => setTimeout(r, 15))
  }
}

test('TransferManager pauses mid-download and resumes from exact byte offset', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'sftp-bridge-tx-'))
  try {
    const transport = createMemoryTransport(8)
    // 256 KB payload -> 4 chunks of 64 KB
    const payload = Buffer.alloc(256 * 1024, 0x41)
    for (let i = 0; i < payload.length; i += 1024) payload[i] = i % 251
    transport.files.set('/remote/big.bin', payload)

    const manager = new TransferManager(
      {
        getTransport: async () => transport,
        onSnapshot: () => {}
      },
      1
    )

    const snap1 = manager.enqueue({
      hostId: 'test-host',
      hostName: 'Test Host',
      direction: 'download',
      items: [{ sourcePath: '/remote/big.bin', targetDir: dir, isDirectory: false, name: 'big.bin', size: payload.length }]
    })
    const txId = snap1.items[0].id

    // Wait until at least 1 chunk transferred, then pause
    await waitFor(() => (manager.getSnapshot().items[0]?.bytesTransferred || 0) >= 64 * 1024)
    manager.pause(txId)
    await waitFor(() => manager.getSnapshot().items[0]?.status === 'paused')

    const pausedBytes = manager.getSnapshot().items[0].bytesTransferred
    assert.ok(pausedBytes >= 64 * 1024 && pausedBytes < payload.length)

    // Resume and wait for completion
    manager.resume(txId)
    await waitFor(() => manager.getSnapshot().items[0]?.status === 'completed')

    const downloaded = await readFile(join(dir, 'big.bin'))
    assert.equal(downloaded.length, payload.length)
    assert.ok(downloaded.equals(payload))
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('TransferManager respects priority and queue reordering (top/up/down)', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'sftp-bridge-prio-'))
  try {
    const transport = createMemoryTransport(15)
    for (const name of ['a.bin', 'b.bin', 'c.bin']) {
      await writeFile(join(dir, name), Buffer.alloc(128 * 1024, name.charCodeAt(0)))
    }

    const completedOrder: string[] = []
    const manager = new TransferManager(
      {
        getTransport: async () => transport,
        onSnapshot: (snap) => {
          for (const it of snap.items) {
            if (it.status === 'completed' && !completedOrder.includes(it.name)) {
              completedOrder.push(it.name)
            }
          }
        }
      },
      1
    )

    const s = manager.enqueue({
      hostId: 'test-host',
      hostName: 'Test Host',
      direction: 'upload',
      items: [
        { sourcePath: join(dir, 'a.bin'), targetDir: '/out', isDirectory: false, name: 'a.bin', size: 128 * 1024 },
        { sourcePath: join(dir, 'b.bin'), targetDir: '/out', isDirectory: false, name: 'b.bin', size: 128 * 1024 },
        { sourcePath: join(dir, 'c.bin'), targetDir: '/out', isDirectory: false, name: 'c.bin', size: 128 * 1024 }
      ]
    })

    // Promote c.bin to top (high priority) while a.bin is running
    const cItem = s.items.find((i) => i.name === 'c.bin')!
    manager.reorder(cItem.id, 'top')

    await waitFor(() => manager.getSnapshot().completedCount === 3)
    // a.bin started immediately, then c.bin jumped ahead of b.bin!
    assert.deepEqual(completedOrder, ['a.bin', 'c.bin', 'b.bin'])
    assert.equal(transport.files.get('/out/c.bin')?.length, 128 * 1024)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('TransferManager cancel removes temporary .part file', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'sftp-bridge-cancel-'))
  try {
    const transport = createMemoryTransport(15)
    transport.files.set('/remote/cancel.bin', Buffer.alloc(256 * 1024, 0x42))

    const manager = new TransferManager(
      {
        getTransport: async () => transport,
        onSnapshot: () => {}
      },
      1
    )

    const s = manager.enqueue({
      hostId: 'test-host',
      hostName: 'Test Host',
      direction: 'download',
      items: [{ sourcePath: '/remote/cancel.bin', targetDir: dir, isDirectory: false, name: 'cancel.bin', size: 256 * 1024 }]
    })
    const txId = s.items[0].id

    await waitFor(() => (manager.getSnapshot().items[0]?.bytesTransferred || 0) >= 64 * 1024)
    manager.cancel(txId)
    await waitFor(() => manager.getSnapshot().items[0]?.status === 'cancelled')
    await new Promise((r) => setTimeout(r, 40))

    let partExists = true
    try {
      await stat(join(dir, 'cancel.bin.orca-sftp.part'))
    } catch {
      partExists = false
    }
    assert.equal(partExists, false)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('TransferManager creates .bak backup before overwriting when backupBeforeOverwrite is enabled', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'sftp-bridge-bak-'))
  try {
    const transport = createMemoryTransport(2)
    transport.files.set('/remote/AGENTS.md', Buffer.from('NEW REMOTE CONTENT'))
    await writeFile(join(dir, 'AGENTS.md'), 'ORIGINAL LOCAL CONTENT')

    const manager = new TransferManager(
      {
        getTransport: async () => transport,
        onSnapshot: () => {}
      },
      1
    )

    manager.enqueue({
      hostId: 'test-host',
      hostName: 'Test Host',
      direction: 'download',
      items: [
        {
          sourcePath: '/remote/AGENTS.md',
          targetDir: dir,
          isDirectory: false,
          name: 'AGENTS.md',
          backupBeforeOverwrite: true,
          size: 18
        }
      ]
    })

    await waitFor(() => manager.getSnapshot().completedCount === 1)
    assert.equal(await readFile(join(dir, 'AGENTS.md'), 'utf8'), 'NEW REMOTE CONTENT')
    assert.equal(await readFile(join(dir, 'AGENTS.md.bak'), 'utf8'), 'ORIGINAL LOCAL CONTENT')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('TransferManager streams Remote A -> Remote B in memory with pause/resume and .bak backup', async () => {
  const transportA = createMemoryTransport(6, 'host-a', 'Alpha Server')
  const transportB = createMemoryTransport(6, 'host-b', 'Beta Server')

  // 256 KB payload on Server A + existing file on Server B to test .bak backup
  const payload = Buffer.alloc(256 * 1024, 0x5a)
  for (let i = 0; i < payload.length; i += 2048) payload[i] = (i / 2048) % 251
  transportA.files.set('/srv/data/bundle.bin', payload)
  transportB.files.set('/opt/dest/bundle.bin', Buffer.from('OLD-BETA-CONTENT'))

  const manager = new TransferManager(
    {
      getTransport: async (hostId) => (hostId === 'host-a' ? transportA : transportB),
      onSnapshot: () => {}
    },
    1
  )

  const snap = manager.enqueue({
    hostId: 'host-b',
    hostName: 'Alpha Server → Beta Server',
    direction: 'remote-to-remote',
    sourceSide: 'remote',
    sourceHostId: 'host-a',
    sourceHostName: 'Alpha Server',
    targetSide: 'remote',
    targetHostId: 'host-b',
    targetHostName: 'Beta Server',
    items: [
      {
        sourcePath: '/srv/data/bundle.bin',
        targetDir: '/opt/dest',
        isDirectory: false,
        name: 'bundle.bin',
        backupBeforeOverwrite: true,
        size: payload.length
      }
    ]
  })
  const txId = snap.items[0].id
  assert.equal(snap.items[0].direction, 'remote-to-remote')

  // Pause mid-stream and resume from exact byte offset
  await waitFor(() => (manager.getSnapshot().items[0]?.bytesTransferred || 0) >= 64 * 1024)
  manager.pause(txId)
  await waitFor(() => manager.getSnapshot().items[0]?.status === 'paused')
  const pausedAt = manager.getSnapshot().items[0].bytesTransferred
  assert.ok(pausedAt >= 64 * 1024 && pausedAt < payload.length)

  manager.resume(txId)
  await waitFor(() => manager.getSnapshot().items[0]?.status === 'completed')

  const destBuf = transportB.files.get('/opt/dest/bundle.bin')
  assert.ok(destBuf && destBuf.equals(payload))
  assert.equal(transportB.files.get('/opt/dest/bundle.bin.bak')?.toString('utf8'), 'OLD-BETA-CONTENT')
})
