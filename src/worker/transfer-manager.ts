import { mkdir, open as openLocalFile, readdir, rename, stat, unlink } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { posixDirname, posixJoin } from '../shared/file-utils.ts'
import type {
  TransferDirection,
  TransferItem,
  TransferPriority,
  TransferSnapshot
} from '../shared/types.ts'
import { type RemoteTransport, SFTP_OPEN_FLAGS } from './transport-types.ts'

export interface EnqueueTransferItemInput {
  sourcePath: string
  targetDir: string
  isDirectory: boolean
  name: string
  targetName?: string
  backupBeforeOverwrite?: boolean
  size?: number
}

interface FileTask {
  sourcePath: string
  targetPath: string
  tempTargetPath: string
  size: number
  bytesDone: number
  completed: boolean
}

interface InternalTransfer {
  item: TransferItem
  backupBeforeOverwrite: boolean
  files: FileTask[] | null
  abortReason: 'pause' | 'cancel' | null
  speedWindow: Array<{ at: number; bytes: number }>
}

export interface TransferRunnerHooks {
  getTransport: (hostId: string) => Promise<RemoteTransport>
  onSnapshot: (snapshot: TransferSnapshot) => void
  onQueueSettled?: (summary: { completed: number; failed: number }) => void
}

const PRIORITY_RANK: Record<TransferPriority, number> = {
  high: 0,
  normal: 1,
  low: 2
}

const CHUNK_SIZE = 64 * 1024
const PART_SUFFIX = '.orca-sftp.part'

export class TransferManager {
  private readonly transfers = new Map<string, InternalTransfer>()
  private readonly activeIds = new Set<string>()
  private nextOrder = 1
  private maxConcurrent = 2
  private emitTimer: ReturnType<typeof setTimeout> | null = null
  private lastEmitAt = 0
  private readonly hooks: TransferRunnerHooks
  private batchCompleted = 0
  private batchFailed = 0

  constructor(hooks: TransferRunnerHooks, maxConcurrent = 2) {
    this.hooks = hooks
    this.maxConcurrent = Math.max(1, Math.min(6, maxConcurrent))
  }

  setMaxConcurrent(n: number): void {
    this.maxConcurrent = Math.max(1, Math.min(6, Math.round(n)))
    this.pump()
    this.scheduleEmit(true)
  }

  getSnapshot(): TransferSnapshot {
    const list = [...this.transfers.values()]
      .map((t) => ({ ...t.item }))
      .sort((a, b) => {
        const groupRank = (s: TransferItem['status']) => {
          if (s === 'running') return 0
          if (s === 'queued') return 1
          if (s === 'paused') return 2
          if (s === 'error') return 3
          if (s === 'completed') return 4
          return 5
        }
        const gDiff = groupRank(a.status) - groupRank(b.status)
        if (gDiff !== 0) return gDiff
        if (a.status === 'queued' && b.status === 'queued') {
          const pDiff = PRIORITY_RANK[a.priority] - PRIORITY_RANK[b.priority]
          if (pDiff !== 0) return pDiff
        }
        return a.order - b.order
      })

    let activeCount = 0
    let queuedCount = 0
    let pausedCount = 0
    let errorCount = 0
    let completedCount = 0

    for (const item of list) {
      if (item.status === 'running') activeCount++
      else if (item.status === 'queued') queuedCount++
      else if (item.status === 'paused') pausedCount++
      else if (item.status === 'error') errorCount++
      else if (item.status === 'completed') completedCount++
    }

    return {
      items: list,
      activeCount,
      queuedCount,
      pausedCount,
      errorCount,
      completedCount,
      maxConcurrent: this.maxConcurrent
    }
  }

  enqueue(params: {
    hostId: string
    hostName: string
    direction: TransferDirection
    items: EnqueueTransferItemInput[]
    priority?: TransferPriority
  }): TransferSnapshot {
    const priority = params.priority || 'normal'
    const now = Date.now()

    for (const input of params.items) {
      const id = `tx-${now.toString(36)}-${Math.random().toString(36).slice(2, 7)}`
      const finalName = input.targetName?.trim() || input.name
      const targetPath =
        params.direction === 'upload'
          ? posixJoin(input.targetDir, finalName)
          : join(input.targetDir, finalName)

      const item: TransferItem = {
        id,
        hostId: params.hostId,
        hostName: params.hostName,
        direction: params.direction,
        sourcePath: input.sourcePath,
        targetPath,
        name: finalName,
        isDirectory: input.isDirectory,
        status: 'queued',
        priority,
        order: this.nextOrder++,
        bytesTransferred: 0,
        totalBytes: input.isDirectory ? 0 : input.size || 0,
        speedBps: 0,
        etaSeconds: null,
        filesCompleted: 0,
        filesTotal: input.isDirectory ? 0 : 1,
        createdAt: now,
        updatedAt: now
      }

      this.transfers.set(id, {
        item,
        backupBeforeOverwrite: Boolean(input.backupBeforeOverwrite),
        files: null,
        abortReason: null,
        speedWindow: []
      })
    }

    this.pump()
    this.scheduleEmit(true)
    return this.getSnapshot()
  }

  pause(transferId: string): TransferSnapshot {
    const entry = this.transfers.get(transferId)
    if (!entry) return this.getSnapshot()
    if (entry.item.status === 'running') {
      entry.abortReason = 'pause'
      entry.item.status = 'paused'
      entry.item.speedBps = 0
      entry.item.etaSeconds = null
      entry.item.updatedAt = Date.now()
    } else if (entry.item.status === 'queued') {
      entry.item.status = 'paused'
      entry.item.updatedAt = Date.now()
    }
    this.scheduleEmit(true)
    return this.getSnapshot()
  }

  resume(transferId: string): TransferSnapshot {
    const entry = this.transfers.get(transferId)
    if (!entry) return this.getSnapshot()
    if (entry.item.status === 'paused' || entry.item.status === 'error' || entry.item.status === 'cancelled') {
      entry.abortReason = null
      entry.item.status = 'queued'
      entry.item.error = undefined
      entry.item.updatedAt = Date.now()
      this.pump()
      this.scheduleEmit(true)
    }
    return this.getSnapshot()
  }

  cancel(transferId: string): TransferSnapshot {
    const entry = this.transfers.get(transferId)
    if (!entry) return this.getSnapshot()
    if (entry.item.status === 'running') {
      entry.abortReason = 'cancel'
      entry.item.status = 'cancelled'
      entry.item.speedBps = 0
      entry.item.etaSeconds = null
      entry.item.updatedAt = Date.now()
    } else if (entry.item.status === 'queued' || entry.item.status === 'paused') {
      entry.abortReason = 'cancel'
      entry.item.status = 'cancelled'
      entry.item.updatedAt = Date.now()
      void this.cleanupPartFiles(entry)
    }
    this.scheduleEmit(true)
    return this.getSnapshot()
  }

  remove(transferId: string): TransferSnapshot {
    const entry = this.transfers.get(transferId)
    if (!entry) return this.getSnapshot()
    if (entry.item.status === 'running') {
      entry.abortReason = 'cancel'
    }
    void this.cleanupPartFiles(entry)
    this.transfers.delete(transferId)
    this.scheduleEmit(true)
    return this.getSnapshot()
  }

  pauseAll(): TransferSnapshot {
    for (const [id, entry] of this.transfers) {
      if (entry.item.status === 'running' || entry.item.status === 'queued') {
        this.pause(id)
      }
    }
    return this.getSnapshot()
  }

  resumeAll(): TransferSnapshot {
    for (const [id, entry] of this.transfers) {
      if (entry.item.status === 'paused') {
        this.resume(id)
      }
    }
    return this.getSnapshot()
  }

  clearCompleted(): TransferSnapshot {
    for (const [id, entry] of this.transfers) {
      if (entry.item.status === 'completed' || entry.item.status === 'cancelled') {
        this.transfers.delete(id)
      }
    }
    this.scheduleEmit(true)
    return this.getSnapshot()
  }

  setPriority(transferId: string, priority: TransferPriority): TransferSnapshot {
    const entry = this.transfers.get(transferId)
    if (!entry) return this.getSnapshot()
    entry.item.priority = priority
    entry.item.updatedAt = Date.now()
    this.pump()
    this.scheduleEmit(true)
    return this.getSnapshot()
  }

  reorder(transferId: string, move: 'top' | 'up' | 'down' | 'bottom'): TransferSnapshot {
    const target = this.transfers.get(transferId)
    if (!target) return this.getSnapshot()

    const queueable = [...this.transfers.values()]
      .filter((t) => t.item.status === 'queued' || t.item.status === 'paused')
      .sort((a, b) => {
        const pDiff = PRIORITY_RANK[a.item.priority] - PRIORITY_RANK[b.item.priority]
        return pDiff !== 0 ? pDiff : a.item.order - b.item.order
      })

    const idx = queueable.findIndex((t) => t.item.id === transferId)
    if (idx < 0) return this.getSnapshot()

    let nextIdx = idx
    if (move === 'top') {
      nextIdx = 0
      target.item.priority = 'high'
    } else if (move === 'bottom') {
      nextIdx = queueable.length - 1
      target.item.priority = 'low'
    } else if (move === 'up' && idx > 0) {
      nextIdx = idx - 1
      target.item.priority = queueable[nextIdx].item.priority
    } else if (move === 'down' && idx < queueable.length - 1) {
      nextIdx = idx + 1
      target.item.priority = queueable[nextIdx].item.priority
    }

    if (nextIdx !== idx) {
      queueable.splice(idx, 1)
      queueable.splice(nextIdx, 0, target)
    }

    queueable.forEach((t, i) => {
      t.item.order = i + 1
      t.item.updatedAt = Date.now()
    })
    this.nextOrder = Math.max(this.nextOrder, queueable.length + 1)

    this.scheduleEmit(true)
    return this.getSnapshot()
  }

  shutdown(): void {
    if (this.emitTimer) {
      clearTimeout(this.emitTimer)
      this.emitTimer = null
    }
    for (const entry of this.transfers.values()) {
      if (entry.item.status === 'running') {
        entry.abortReason = 'pause'
      }
    }
  }

  private pump(): void {
    while (this.activeIds.size < this.maxConcurrent) {
      const next = this.pickNextQueued()
      if (!next) break
      this.activeIds.add(next.item.id)
      next.abortReason = null
      next.item.status = 'running'
      next.item.error = undefined
      next.item.updatedAt = Date.now()
      this.scheduleEmit(true)
      void this.runTransfer(next)
    }
  }

  private pickNextQueued(): InternalTransfer | undefined {
    const candidates = [...this.transfers.values()].filter((t) => t.item.status === 'queued')
    if (!candidates.length) return undefined
    candidates.sort((a, b) => {
      const pDiff = PRIORITY_RANK[a.item.priority] - PRIORITY_RANK[b.item.priority]
      return pDiff !== 0 ? pDiff : a.item.order - b.item.order
    })
    return candidates[0]
  }

  private async runTransfer(entry: InternalTransfer): Promise<void> {
    try {
      const transport = await this.hooks.getTransport(entry.item.hostId)

      if (!entry.files) {
        entry.files = await this.expandFileTasks(entry.item, transport)
        entry.item.filesTotal = entry.files.length
        entry.item.totalBytes = entry.files.reduce((acc, f) => acc + f.size, 0)
        this.scheduleEmit(false)
      }

      if (entry.files.length === 0 && entry.item.isDirectory) {
        if (entry.item.direction === 'upload') {
          await transport.mkdirRecursive(entry.item.targetPath)
        } else {
          await mkdir(entry.item.targetPath, { recursive: true })
        }
      }

      for (const fileTask of entry.files) {
        if (fileTask.completed) continue
        if (entry.abortReason) break

        if (entry.item.direction === 'upload') {
          await this.uploadSingleFile(entry, fileTask, transport)
        } else {
          await this.downloadSingleFile(entry, fileTask, transport)
        }

        if (entry.abortReason) break
        fileTask.completed = true
        entry.item.filesCompleted = entry.files.filter((f) => f.completed).length
        this.scheduleEmit(false)
      }

      if (entry.abortReason === 'pause') {
        entry.item.status = 'paused'
        entry.item.speedBps = 0
        entry.item.etaSeconds = null
      } else if (entry.abortReason === 'cancel') {
        entry.item.status = 'cancelled'
        entry.item.speedBps = 0
        entry.item.etaSeconds = null
        await this.cleanupPartFiles(entry)
      } else {
        entry.item.status = 'completed'
        entry.item.bytesTransferred = entry.item.totalBytes
        entry.item.filesCompleted = entry.item.filesTotal
        entry.item.speedBps = 0
        entry.item.etaSeconds = 0
        this.batchCompleted++
      }
      entry.item.updatedAt = Date.now()
    } catch (err) {
      if (entry.abortReason === 'pause') {
        entry.item.status = 'paused'
      } else if (entry.abortReason === 'cancel') {
        entry.item.status = 'cancelled'
        await this.cleanupPartFiles(entry)
      } else {
        entry.item.status = 'error'
        entry.item.error = err instanceof Error ? err.message : String(err)
        this.batchFailed++
      }
      entry.item.speedBps = 0
      entry.item.etaSeconds = null
      entry.item.updatedAt = Date.now()
    } finally {
      this.activeIds.delete(entry.item.id)
      this.pump()
      this.scheduleEmit(true)

      const hasPending = [...this.transfers.values()].some(
        (t) => t.item.status === 'running' || t.item.status === 'queued'
      )
      if (!hasPending && (this.batchCompleted > 0 || this.batchFailed > 0)) {
        const summary = { completed: this.batchCompleted, failed: this.batchFailed }
        this.batchCompleted = 0
        this.batchFailed = 0
        this.hooks.onQueueSettled?.(summary)
      }
    }
  }

  private async expandFileTasks(item: TransferItem, transport: RemoteTransport): Promise<FileTask[]> {
    if (!item.isDirectory) {
      let size = item.totalBytes
      if (item.direction === 'upload') {
        const st = await stat(item.sourcePath)
        size = st.size
      } else if (!size) {
        const st = await transport.stat(item.sourcePath)
        size = st.size
      }
      return [
        {
          sourcePath: item.sourcePath,
          targetPath: item.targetPath,
          tempTargetPath: `${item.targetPath}${PART_SUFFIX}`,
          size,
          bytesDone: 0,
          completed: false
        }
      ]
    }

    const tasks: FileTask[] = []
    if (item.direction === 'upload') {
      const walkLocal = async (localDir: string, remoteDir: string) => {
        const entries = await readdir(localDir, { withFileTypes: true })
        for (const e of entries) {
          const src = join(localDir, e.name)
          const dst = posixJoin(remoteDir, e.name)
          if (e.isDirectory()) {
            await walkLocal(src, dst)
          } else if (e.isFile()) {
            const st = await stat(src)
            tasks.push({
              sourcePath: src,
              targetPath: dst,
              tempTargetPath: `${dst}${PART_SUFFIX}`,
              size: st.size,
              bytesDone: 0,
              completed: false
            })
          }
        }
      }
      await walkLocal(item.sourcePath, item.targetPath)
    } else {
      const walkRemote = async (remoteDir: string, localDir: string) => {
        const { entries } = await transport.listDir(remoteDir)
        for (const e of entries) {
          const dst = join(localDir, e.name)
          if (e.isDirectory && !e.isSymlink) {
            await walkRemote(e.path, dst)
          } else if (!e.isDirectory) {
            tasks.push({
              sourcePath: e.path,
              targetPath: dst,
              tempTargetPath: `${dst}${PART_SUFFIX}`,
              size: e.size,
              bytesDone: 0,
              completed: false
            })
          }
        }
      }
      await walkRemote(item.sourcePath, item.targetPath)
    }
    return tasks
  }

  private async uploadSingleFile(
    entry: InternalTransfer,
    task: FileTask,
    transport: RemoteTransport
  ): Promise<void> {
    await transport.mkdirRecursive(posixDirname(task.targetPath))
    const localFd = await openLocalFile(task.sourcePath, 'r')
    const remoteFlags =
      task.bytesDone > 0 ? SFTP_OPEN_FLAGS.WRITE_CREATE_RESUME : SFTP_OPEN_FLAGS.WRITE_CREATE_TRUNC
    const remoteHandle = await transport.openHandle(task.tempTargetPath, remoteFlags)
    const buf = Buffer.allocUnsafe(CHUNK_SIZE)

    try {
      while (task.bytesDone < task.size) {
        if (entry.abortReason) return
        const toRead = Math.min(CHUNK_SIZE, task.size - task.bytesDone)
        const { bytesRead } = await localFd.read(buf, 0, toRead, task.bytesDone)
        if (bytesRead <= 0) break
        await transport.writeChunk(remoteHandle, buf, 0, bytesRead, task.bytesDone)
        task.bytesDone += bytesRead
        this.recordProgress(entry, bytesRead)
      }
    } finally {
      await localFd.close().catch(() => undefined)
      await transport.closeHandle(remoteHandle).catch(() => undefined)
    }

    if (!entry.abortReason) {
      if (entry.backupBeforeOverwrite) {
        await this.backupExistingRemote(task.targetPath, transport)
      }
      await transport.renameExact(task.tempTargetPath, task.targetPath)
    }
  }

  private async backupExistingRemote(targetPath: string, transport: RemoteTransport): Promise<void> {
    try {
      await transport.stat(targetPath)
    } catch {
      return
    }
    const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
    const bakPath = `${targetPath}.bak`
    try {
      await transport.stat(bakPath)
      await transport.renameExact(targetPath, `${targetPath}.${stamp}.bak`)
    } catch {
      await transport.renameExact(targetPath, bakPath)
    }
  }

  private async backupExistingLocal(targetPath: string): Promise<void> {
    try {
      await stat(targetPath)
    } catch {
      return
    }
    const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
    const bakPath = `${targetPath}.bak`
    try {
      await stat(bakPath)
      await rename(targetPath, `${targetPath}.${stamp}.bak`)
    } catch {
      await rename(targetPath, bakPath)
    }
  }

  private async downloadSingleFile(
    entry: InternalTransfer,
    task: FileTask,
    transport: RemoteTransport
  ): Promise<void> {
    await mkdir(dirname(task.targetPath), { recursive: true })
    const remoteHandle = await transport.openHandle(task.sourcePath, SFTP_OPEN_FLAGS.READ)
    const localFlags = task.bytesDone > 0 ? 'r+' : 'w'
    const localFd = await openLocalFile(task.tempTargetPath, localFlags)
    const buf = Buffer.allocUnsafe(CHUNK_SIZE)

    try {
      while (true) {
        if (entry.abortReason) return
        const bytesRead = await transport.readChunk(remoteHandle, buf, 0, CHUNK_SIZE, task.bytesDone)
        if (bytesRead <= 0) break
        await localFd.write(buf, 0, bytesRead, task.bytesDone)
        task.bytesDone += bytesRead
        this.recordProgress(entry, bytesRead)
      }
    } finally {
      await localFd.close().catch(() => undefined)
      await transport.closeHandle(remoteHandle).catch(() => undefined)
    }

    if (!entry.abortReason) {
      if (entry.backupBeforeOverwrite) {
        await this.backupExistingLocal(task.targetPath)
      }
      await rename(task.tempTargetPath, task.targetPath)
    }
  }

  private recordProgress(entry: InternalTransfer, deltaBytes: number): void {
    const now = Date.now()
    entry.item.bytesTransferred += deltaBytes
    entry.item.updatedAt = now
    entry.speedWindow.push({ at: now, bytes: deltaBytes })

    const cutoff = now - 3000
    while (entry.speedWindow.length > 1 && entry.speedWindow[0].at < cutoff) {
      entry.speedWindow.shift()
    }

    const totalWindowBytes = entry.speedWindow.reduce((sum, s) => sum + s.bytes, 0)
    const spanMs = Math.max(250, now - entry.speedWindow[0].at)
    const speedBps = Math.round((totalWindowBytes * 1000) / spanMs)
    entry.item.speedBps = speedBps
    const remaining = Math.max(0, entry.item.totalBytes - entry.item.bytesTransferred)
    entry.item.etaSeconds = speedBps > 0 ? remaining / speedBps : null

    this.scheduleEmit(false)
  }

  private async cleanupPartFiles(entry: InternalTransfer): Promise<void> {
    if (!entry.files) return
    let transport: RemoteTransport | null = null
    for (const f of entry.files) {
      if (f.completed) continue
      if (entry.item.direction === 'download') {
        await unlink(f.tempTargetPath).catch(() => undefined)
      } else {
        try {
          if (!transport) transport = await this.hooks.getTransport(entry.item.hostId)
          await transport.unlink(f.tempTargetPath).catch(() => undefined)
        } catch {
          // ignore cleanup failure if disconnected
        }
      }
    }
  }

  private scheduleEmit(immediate: boolean): void {
    const now = Date.now()
    if (immediate || now - this.lastEmitAt >= 200) {
      if (this.emitTimer) {
        clearTimeout(this.emitTimer)
        this.emitTimer = null
      }
      this.lastEmitAt = now
      this.hooks.onSnapshot(this.getSnapshot())
      return
    }
    if (!this.emitTimer) {
      this.emitTimer = setTimeout(() => {
        this.emitTimer = null
        this.lastEmitAt = Date.now()
        this.hooks.onSnapshot(this.getSnapshot())
      }, 200)
    }
  }
}
