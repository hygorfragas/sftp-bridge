import { generateKeyPairSync } from 'node:crypto'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { assert, mockHost, mountWorker, test } from 'orca/testing'
import type { Server as Ssh2ServerType } from 'ssh2'
import '../src/protocol.ts'
import * as workerMod from '../dist/worker.mjs'

const require = createRequire(import.meta.url)
const { Server: Ssh2Server } = require('ssh2') as { Server: typeof Ssh2ServerType }
const { STATUS_CODE } = require('ssh2/lib/protocol/SFTP.js') as { STATUS_CODE: Record<string, number> }

interface MemFile {
  data: Buffer
  mode: number
  mtimeSec: number
}

/**
 * Starts an ephemeral in-process SSH2 + SFTP v3 server on 127.0.0.1 for true E2E testing.
 * Uses a freshly generated RSA host key (no hardcoded credentials or personal data).
 */
async function startTestSftpServer(): Promise<{
  port: number
  password: string
  files: Map<string, MemFile>
  dirs: Set<string>
  close: () => Promise<void>
}> {
  const { privateKey } = generateKeyPairSync('rsa', {
    modulusLength: 2048,
    privateKeyEncoding: { type: 'pkcs1', format: 'pem' },
    publicKeyEncoding: { type: 'pkcs1', format: 'pem' }
  })
  const password = 'e2e-test-pass'
  const files = new Map<string, MemFile>()
  const dirs = new Set<string>(['/root', '/root/sub'])
  files.set('/root/hello.txt', {
    data: Buffer.from('remote-hello-v1\nline-2\n'),
    mode: 0o100644,
    mtimeSec: Math.floor(Date.now() / 1000)
  })
  // Tiny 1x1 PNG
  files.set('/root/icon.png', {
    data: Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
      'base64'
    ),
    mode: 0o100644,
    mtimeSec: Math.floor(Date.now() / 1000)
  })

  const normalize = (p: string): string => {
    if (!p || p === '.') return '/root'
    if (p === '/') return '/'
    return p.replace(/\/+$/, '') || '/'
  }

  const server = new Ssh2Server({ hostKeys: [privateKey] }, (client) => {
    client.on('authentication', (ctx) => {
      if (ctx.method === 'password' && ctx.username === 'tester' && ctx.password === password) {
        ctx.accept()
      } else {
        ctx.reject(['password'])
      }
    })

    client.on('ready', () => {
      client.on('session', (accept) => {
        const session = accept()
        session.on('sftp', (acceptSftp) => {
          const sftp = acceptSftp()
          const openHandles = new Map<string, { kind: 'dir' | 'file'; path: string; readOnce?: boolean }>()
          let nextH = 1

          const ok = (reqId: number) => sftp.status(reqId, STATUS_CODE.OK)
          const fail = (reqId: number, code = STATUS_CODE.NO_SUCH_FILE) => sftp.status(reqId, code)

          sftp.on('REALPATH', (reqId, path) => {
            const p = normalize(path)
            sftp.name(reqId, [{ filename: p, longname: p, attrs: { mode: 0o040755, size: 0, uid: 0, gid: 0, atime: 0, mtime: 0 } }])
          })

          sftp.on('STAT', (reqId, path) => {
            const p = normalize(path)
            if (dirs.has(p)) {
              sftp.attrs(reqId, { mode: 0o040755, size: 0, uid: 0, gid: 0, atime: 0, mtime: Math.floor(Date.now() / 1000) })
              return
            }
            const f = files.get(p)
            if (!f) return fail(reqId)
            sftp.attrs(reqId, { mode: f.mode, size: f.data.length, uid: 0, gid: 0, atime: f.mtimeSec, mtime: f.mtimeSec })
          })

          sftp.on('LSTAT', (reqId, path) => {
            const p = normalize(path)
            if (dirs.has(p)) {
              sftp.attrs(reqId, { mode: 0o040755, size: 0, uid: 0, gid: 0, atime: 0, mtime: Math.floor(Date.now() / 1000) })
              return
            }
            const f = files.get(p)
            if (!f) return fail(reqId)
            sftp.attrs(reqId, { mode: f.mode, size: f.data.length, uid: 0, gid: 0, atime: f.mtimeSec, mtime: f.mtimeSec })
          })

          sftp.on('OPENDIR', (reqId, path) => {
            const p = normalize(path)
            if (!dirs.has(p)) return fail(reqId)
            const id = Buffer.from(`d${nextH++}`)
            openHandles.set(id.toString(), { kind: 'dir', path: p })
            sftp.handle(reqId, id)
          })

          sftp.on('READDIR', (reqId, handle) => {
            const entry = openHandles.get(handle.toString())
            if (!entry || entry.readOnce) return sftp.status(reqId, STATUS_CODE.EOF)
            entry.readOnce = true
            const prefix = entry.path === '/' ? '/' : `${entry.path}/`
            const items: Array<{ filename: string; longname: string; attrs: { mode: number; size: number; uid: number; gid: number; atime: number; mtime: number } }> = []
            for (const d of dirs) {
              if (!d.startsWith(prefix)) continue
              const rest = d.slice(prefix.length)
              if (rest && !rest.includes('/')) {
                items.push({ filename: rest, longname: rest, attrs: { mode: 0o040755, size: 0, uid: 0, gid: 0, atime: 0, mtime: Math.floor(Date.now() / 1000) } })
              }
            }
            for (const [fp, f] of files) {
              if (!fp.startsWith(prefix)) continue
              const rest = fp.slice(prefix.length)
              if (rest && !rest.includes('/')) {
                items.push({ filename: rest, longname: rest, attrs: { mode: f.mode, size: f.data.length, uid: 0, gid: 0, atime: f.mtimeSec, mtime: f.mtimeSec } })
              }
            }
            sftp.name(reqId, items)
          })

          sftp.on('OPEN', (reqId, filename, flags) => {
            const p = normalize(filename)
            const isWrite = (flags & 0x02) !== 0
            const isCreat = (flags & 0x08) !== 0
            const isTrunc = (flags & 0x10) !== 0
            if (!files.has(p)) {
              if (!isCreat) return fail(reqId)
              files.set(p, { data: Buffer.alloc(0), mode: 0o100644, mtimeSec: Math.floor(Date.now() / 1000) })
            } else if (isWrite && isTrunc) {
              const prev = files.get(p)!
              files.set(p, { data: Buffer.alloc(0), mode: prev.mode, mtimeSec: Math.floor(Date.now() / 1000) })
            }
            const id = Buffer.from(`f${nextH++}`)
            openHandles.set(id.toString(), { kind: 'file', path: p })
            sftp.handle(reqId, id)
          })

          sftp.on('READ', (reqId, handle, offset, length) => {
            const entry = openHandles.get(handle.toString())
            if (!entry) return fail(reqId, STATUS_CODE.FAILURE)
            const f = files.get(entry.path)
            if (!f || offset >= f.data.length) return sftp.status(reqId, STATUS_CODE.EOF)
            const chunk = f.data.subarray(offset, Math.min(f.data.length, offset + length))
            sftp.data(reqId, chunk)
          })

          sftp.on('WRITE', (reqId, handle, offset, data) => {
            const entry = openHandles.get(handle.toString())
            if (!entry) return fail(reqId, STATUS_CODE.FAILURE)
            const f = files.get(entry.path)
            if (!f) return fail(reqId)
            const needed = offset + data.length
            const next = needed > f.data.length ? Buffer.concat([f.data, Buffer.alloc(needed - f.data.length)]) : Buffer.from(f.data)
            data.copy(next, offset)
            f.data = next
            f.mtimeSec = Math.floor(Date.now() / 1000)
            ok(reqId)
          })

          sftp.on('CLOSE', (reqId, handle) => {
            openHandles.delete(handle.toString())
            ok(reqId)
          })

          sftp.on('MKDIR', (reqId, path) => {
            dirs.add(normalize(path))
            ok(reqId)
          })

          sftp.on('RMDIR', (reqId, path) => {
            dirs.delete(normalize(path))
            ok(reqId)
          })

          sftp.on('REMOVE', (reqId, path) => {
            files.delete(normalize(path))
            ok(reqId)
          })

          sftp.on('RENAME', (reqId, oldPath, newPath) => {
            const o = normalize(oldPath)
            const n = normalize(newPath)
            const f = files.get(o)
            if (!f) return fail(reqId)
            files.set(n, f)
            files.delete(o)
            ok(reqId)
          })

          sftp.on('SETSTAT', (reqId, path, attrs) => {
            const f = files.get(normalize(path))
            if (f && typeof attrs.mode === 'number') f.mode = attrs.mode
            ok(reqId)
          })
        })
      })
    })
  })

  await new Promise<void>((res) => server.listen(0, '127.0.0.1', () => res()))
  const addr = server.address() as { port: number }
  return {
    port: addr.port,
    password,
    files,
    dirs,
    close: () => new Promise<void>((res) => server.close(() => res()))
  }
}

async function waitUntil(fn: () => Promise<boolean>, timeoutMs = 6000): Promise<void> {
  const start = Date.now()
  while (!(await fn())) {
    if (Date.now() - start > timeoutMs) throw new Error('Timed out waiting for E2E condition')
    await new Promise((r) => setTimeout(r, 25))
  }
}

test('E2E: full SFTP lifecycle, errors, capabilities, Finder chunked upload, diff/bak, preview & events', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'sftp-bridge-e2e-'))
  const sftpSrv = await startTestSftpServer()

  try {
    const worker = await mountWorker(workerMod, {
      host: mockHost({
        results: {
          'workspace.readContext': {
            workspaceId: 'ws-1',
            branch: 'main',
            displayName: 'Demo Workspace',
            terminals: []
          },
          'workspace.list': {
            workspaces: [
              { id: 'ws-1', kind: 'folder', name: 'Demo Workspace', path: dir, branch: 'main', hostId: 'local' }
            ],
            truncated: false
          },
          'statusBar.update': { ok: true },
          'notifications.show': { delivered: true }
        }
      })
    })

    // 1. Error handling before connection & input validation
    await assert.rejects(() => worker.request('fs.list', { side: 'remote', path: '/root' }))
    await assert.rejects(() => worker.request('fs.mkdir', { side: 'local', parentPath: dir, name: '../escape' }))
    await assert.rejects(() => worker.request('fs.createFile', { side: 'local', parentPath: dir, name: 'a/b.txt' }))
    await assert.rejects(() => worker.request('fs.rename', { side: 'local', oldPath: join(dir, 'missing'), newName: '..' }))
    await assert.rejects(() => worker.request('fs.delete', { side: 'local', paths: [homedir()] }))
    await assert.rejects(() => worker.request('fs.chmod', { side: 'local', path: dir, mode: '999' }))
    await assert.rejects(() => worker.request('fs.extract', { side: 'local', archivePath: join(dir, 'x.unknown'), destinationDir: dir }))
    await assert.rejects(() => worker.request('fs.uploadChunkWrite', { uploadId: 'bad-id', offset: 0, dataBase64: 'AA==' }))
    await assert.rejects(() => worker.request('connection.connect', { hostId: 'non-existent-host' }))

    // 2. Save a real SSH2 password host & connect over SFTP v3
    const saved = await worker.request('hosts.save', {
      name: 'E2E Localhost SFTP',
      hostname: '127.0.0.1',
      port: sftpSrv.port,
      username: 'tester',
      authMethod: 'password',
      password: sftpSrv.password,
      defaultRemotePath: '/root'
    })
    assert.ok(saved.host.hasSecret)

    const conn = await worker.request('connection.connect', { hostId: saved.host.id })
    assert.equal(conn.connection.connected, true)
    assert.equal(conn.connection.transportMode, 'ssh2-sftp')
    assert.equal(conn.remotePath, '/root')
    assert.ok(conn.entries.some((e) => e.name === 'hello.txt'))
    assert.ok(conn.entries.some((e) => e.name === 'icon.png' && e.isImage))

    // 3. Remote CRUD + QuickEditor over real SFTP
    await worker.request('fs.mkdir', { side: 'remote', parentPath: '/root', name: 'e2e-dir' })
    const created = await worker.request('fs.createFile', {
      side: 'remote',
      parentPath: '/root/e2e-dir',
      name: 'notes.md',
      content: '# Title'
    })
    const remoteDoc = await worker.request('editor.read', { side: 'remote', path: created.createdPath })
    assert.equal(remoteDoc.content, '# Title')
    await worker.request('editor.write', { side: 'remote', path: created.createdPath, content: '# Updated' })
    assert.equal(sftpSrv.files.get('/root/e2e-dir/notes.md')?.data.toString('utf8'), '# Updated')

    await worker.request('fs.chmod', { side: 'remote', path: created.createdPath, mode: '600' })
    assert.equal((sftpSrv.files.get('/root/e2e-dir/notes.md')!.mode & 0o777), 0o600)

    const renamed = await worker.request('fs.rename', { side: 'remote', oldPath: created.createdPath, newName: 'readme.md' })
    assert.equal(renamed.newPath, '/root/e2e-dir/readme.md')

    // 4. Remote Image Preview over real SFTP
    const remoteImg = await worker.request('preview.readImage', { side: 'remote', path: '/root/icon.png' })
    assert.equal(remoteImg.side, 'remote')
    assert.equal(remoteImg.mimeType, 'image/png')
    assert.ok(remoteImg.dataUrl.startsWith('data:image/png;base64,'))

    // 5. Conflict Detection + Visual Diff + .bak Backup on real SFTP download
    await writeFile(join(dir, 'hello.txt'), 'local-existing-v0\nline-2\n')
    const conflicts = await worker.request('transfers.checkConflicts', {
      direction: 'download',
      items: [{ sourcePath: '/root/hello.txt', targetDir: dir, isDirectory: false, name: 'hello.txt', size: 23 }]
    })
    assert.equal(conflicts.conflicts.length, 1)
    assert.equal(conflicts.conflicts[0].suggestedName, 'hello (1).txt')

    const diff = await worker.request('transfers.diffConflict', {
      direction: 'download',
      sourcePath: '/root/hello.txt',
      targetPath: join(dir, 'hello.txt')
    })
    assert.equal(diff.binary, false)
    assert.equal(diff.added, 1)
    assert.equal(diff.removed, 1)

    await worker.request('transfers.enqueue', {
      direction: 'download',
      items: [
        {
          sourcePath: '/root/hello.txt',
          targetDir: dir,
          isDirectory: false,
          name: 'hello.txt',
          backupBeforeOverwrite: true,
          size: 23
        }
      ]
    })
    await waitUntil(async () => (await worker.request('transfers.list')).snapshot.completedCount >= 1)
    assert.equal(await readFile(join(dir, 'hello.txt'), 'utf8'), 'remote-hello-v1\nline-2\n')
    assert.equal(await readFile(join(dir, 'hello.txt.bak'), 'utf8'), 'local-existing-v0\nline-2\n')

    // 6. Finder chunked upload over real SFTP (with .bak on overwrite)
    const initUp = await worker.request('fs.uploadChunkInit', {
      targetDir: '/root',
      name: 'hello.txt',
      backupBeforeOverwrite: true
    })
    await worker.request('fs.uploadChunkWrite', {
      uploadId: initUp.uploadId,
      offset: 0,
      dataBase64: Buffer.from('finder-uploaded-content').toString('base64')
    })
    await worker.request('fs.uploadChunkFinish', { uploadId: initUp.uploadId })
    assert.equal(sftpSrv.files.get('/root/hello.txt')?.data.toString('utf8'), 'finder-uploaded-content')
    assert.equal(sftpSrv.files.get('/root/hello.txt.bak')?.data.toString('utf8'), 'remote-hello-v1\nline-2\n')

    // 7. Remote delete recursive
    const delRes = await worker.request('fs.delete', { side: 'remote', paths: ['/root/e2e-dir'] })
    assert.equal(delRes.deletedCount, 1)
    assert.equal(sftpSrv.files.has('/root/e2e-dir/readme.md'), false)

    // 8. Commands & workspace.changed event
    const statusOut = await worker.command('sftp.status')
    assert.ok(typeof statusOut === 'string' && statusOut.includes('E2E Localhost SFTP'))
    assert.ok(worker.posts.some((p) => p.event === 'quickHub.toggle'))

    await worker.emit('workspace.changed', {
      context: { workspaceId: 'ws-1', branch: 'main', displayName: 'Demo Workspace', terminals: [] }
    })
    assert.ok(worker.posts.some((p) => p.event === 'workspace.hint'))

    // 9. Disconnect & delete host (cleans binding + secret)
    await worker.request('connection.disconnect')
    await worker.request('hosts.delete', { hostId: saved.host.id })

    // 10. Least-privilege check: zero capability refusals!
    assert.deepEqual(worker.refusals, [])

    await worker.deactivate()
  } finally {
    await sftpSrv.close()
    await rm(dir, { recursive: true, force: true })
  }
})
