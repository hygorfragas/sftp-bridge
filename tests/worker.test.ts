import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { assert, mockHost, mountWorker, test } from 'orca/testing'
import '../src/protocol.ts'
import * as workerMod from '../dist/worker.mjs'

test('worker handles local FS, quick editor, compress/extract, bookmarks and commands', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'sftp-bridge-worker-'))
  try {
    const worker = await mountWorker(workerMod, {
      host: mockHost({
        results: {
          'workspace.readContext': null,
          'workspace.list': { workspaces: [], truncated: false },
          'statusBar.update': { ok: true }
        }
      })
    })

    const boot = await worker.request('app.bootstrap')
    assert.ok(typeof boot.localHome === 'string' && boot.localHome.length > 0)
    assert.equal(boot.settings.defaultLayout, 'tabs')

    // Create folder & file locally
    await worker.request('fs.mkdir', { side: 'local', parentPath: dir, name: 'docs' })
    const fileRes = await worker.request('fs.createFile', {
      side: 'local',
      parentPath: join(dir, 'docs'),
      name: 'notes.md',
      content: '# Hello SFTP Bridge'
    })

    // Read & edit with quick editor
    const doc = await worker.request('editor.read', { side: 'local', path: fileRes.createdPath })
    assert.equal(doc.name, 'notes.md')
    assert.equal(doc.content, '# Hello SFTP Bridge')

    await worker.request('editor.write', {
      side: 'local',
      path: fileRes.createdPath,
      content: '# Updated via QuickEditor\nLine 2'
    })
    assert.equal(await readFile(fileRes.createdPath, 'utf8'), '# Updated via QuickEditor\nLine 2')

    // Compress locally as tar.gz & extract to subfolder
    const comp = await worker.request('fs.compress', {
      side: 'local',
      cwd: dir,
      names: ['docs'],
      archiveName: 'bundle',
      format: 'tar.gz'
    })
    assert.equal(comp.archivePath, join(dir, 'bundle.tar.gz'))

    const ext = await worker.request('fs.extract', {
      side: 'local',
      archivePath: comp.archivePath,
      destinationDir: dir,
      createSubfolder: true
    })
    assert.equal(ext.extractedTo, join(dir, 'bundle'))
    const extractedText = await readFile(join(dir, 'bundle', 'docs', 'notes.md'), 'utf8')
    assert.equal(extractedText, '# Updated via QuickEditor\nLine 2')

    // Toggle bookmark
    const bm1 = await worker.request('bookmarks.toggle', { side: 'local', path: dir, label: 'Temp' })
    assert.equal(bm1.bookmarks.length, 1)
    const bm2 = await worker.request('bookmarks.toggle', { side: 'local', path: dir, label: 'Temp' })
    assert.equal(bm2.bookmarks.length, 0)

    // Command execution
    const statusText = await worker.command('sftp.status')
    assert.ok(
      typeof statusText === 'string' &&
        (statusText.includes('Desconectado') || statusText.includes('Conectado em')) &&
        statusText.includes('0 ativa(s)')
    )

    // Verify list includes our created archive & marks it as archive
    const list = await worker.request('fs.list', { side: 'local', path: dir })
    const archiveEntry = list.entries.find((e) => e.name === 'bundle.tar.gz')
    assert.ok(archiveEntry)
    assert.equal(archiveEntry.isArchive, true)
    assert.equal(archiveEntry.archiveType, 'tar.gz')

    // Binary file guard on editor.read
    const binPath = join(dir, 'bin.dat')
    await writeFile(binPath, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x01]))
    await assert.rejects(() => worker.request('editor.read', { side: 'local', path: binPath }))

    // Conflict detection on download against existing local file
    await writeFile(join(dir, 'AGENTS.md'), 'original local file')
    const conflictCheck = await worker.request('transfers.checkConflicts', {
      direction: 'download',
      items: [
        {
          sourcePath: '/remote/AGENTS.md',
          targetDir: dir,
          isDirectory: false,
          name: 'AGENTS.md',
          size: 512
        },
        {
          sourcePath: '/remote/NEW.md',
          targetDir: dir,
          isDirectory: false,
          name: 'NEW.md',
          size: 128
        }
      ]
    })
    assert.equal(conflictCheck.conflicts.length, 1)
    assert.equal(conflictCheck.conflicts[0].name, 'AGENTS.md')
    assert.equal(conflictCheck.conflicts[0].suggestedName, 'AGENTS (1).md')

    // Session persistence across panel close/reopen
    await worker.request('session.save', {
      lastHostId: 'orca-env:00000000-0000-4000-8000-000000000001',
      activeTab: 'remote',
      layout: 'split',
      splitRatio: 45
    })
    const boot2 = await worker.request('app.bootstrap')
    assert.equal(boot2.session.lastHostId, 'orca-env:00000000-0000-4000-8000-000000000001')
    assert.equal(boot2.session.activeTab, 'remote')
    assert.equal(boot2.session.layout, 'split')
    assert.equal(boot2.session.splitRatio, 45)
    assert.equal(boot2.session.lastLocalPath, dir)

    // Recursive subfolder search
    const searchRes = await worker.request('fs.search', {
      side: 'local',
      rootPath: dir,
      query: 'notes'
    })
    assert.ok(searchRes.results.some((r) => r.name === 'notes.md' && r.relativePath.includes('docs')))

    // Image preview (tiny valid 1x1 PNG)
    const pngBase64 =
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII='
    const pngPath = join(dir, 'pixel.png')
    await writeFile(pngPath, Buffer.from(pngBase64, 'base64'))
    const img = await worker.request('preview.readImage', { side: 'local', path: pngPath })
    assert.equal(img.mimeType, 'image/png')
    assert.ok(img.dataUrl.startsWith('data:image/png;base64,'))

    // Live local tail start & stop
    const logPath = join(dir, 'app.log')
    await writeFile(logPath, 'line 1\nline 2\n')
    const tail = await worker.request('tail.start', { side: 'local', path: logPath, lines: 20 })
    assert.ok(tail.tailId.startsWith('tail-'))
    await worker.request('tail.stop', { tailId: tail.tailId })

    await worker.deactivate()
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
