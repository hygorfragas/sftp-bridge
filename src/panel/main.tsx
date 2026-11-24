import { render } from 'preact'
import { useCallback, useEffect, useMemo, useRef, useState } from 'preact/hooks'
import '../protocol.ts'
import { formatModeOctal, posixBasename, posixDirname, posixJoin } from '../shared/file-utils.ts'
import type {
  ArchiveFormat,
  BookmarkEntry,
  ConnectionStatus,
  EditorFilePayload,
  FileEntry,
  HostProfile,
  ImagePreviewPayload,
  LayoutMode,
  PluginUserSettings,
  SaveHostInput,
  SearchResultEntry,
  Side,
  TransferPriority,
  TransferSnapshot,
  WorkspaceHint
} from '../shared/types.ts'
import { ContextMenu, type ContextMenuState } from './components/ContextMenu.tsx'
import { FilePane } from './components/FilePane.tsx'
import { Icon } from './components/Icons.tsx'
import { ImagePreview } from './components/ImagePreview.tsx'
import { type ActiveTailSession, LogTailViewer } from './components/LogTailViewer.tsx'
import {
  CompressModal,
  ConfirmDeleteModal,
  ConflictModal,
  HostModal,
  type ModalState,
  PromptModal
} from './components/Modals.tsx'
import { QuickEditor } from './components/QuickEditor.tsx'
import { QuickHubPopover } from './components/QuickHubPopover.tsx'
import { TransferPanel } from './components/TransferPanel.tsx'

type ActiveTab = 'local' | 'remote' | 'transfers'

const EMPTY_TRANSFERS: TransferSnapshot = {
  items: [],
  activeCount: 0,
  queuedCount: 0,
  pausedCount: 0,
  errorCount: 0,
  completedCount: 0,
  maxConcurrent: 2
}

const DEFAULT_SETTINGS: PluginUserSettings = {
  defaultLayout: 'tabs',
  maxConcurrentTransfers: 2,
  showHiddenFiles: true,
  defaultArchiveFormat: 'zip',
  notifyOnQueueComplete: true,
  maxEditableFileKB: 1024
}

function cleanJson<T>(value: T): T {
  return value === undefined ? (undefined as T) : (JSON.parse(JSON.stringify(value)) as T)
}

function requestWorker<K extends keyof import('orca').PluginRequests>(
  name: K,
  ...args: import('orca').PluginRequestArgs<K>
): Promise<import('orca').PluginRequestOutput<K>> {
  const [input, options] = args
  if (input === undefined) {
    return (orca.plugin.request as (n: K) => Promise<import('orca').PluginRequestOutput<K>>)(name)
  }
  return (
    orca.plugin.request as (
      n: K,
      i: unknown,
      o?: unknown
    ) => Promise<import('orca').PluginRequestOutput<K>>
  )(name, cleanJson(input), options)
}

function applyTypographyVars(typo: { cssFontFamily?: string; fontSize?: number; lineHeight?: number }): void {
  const root = document.documentElement.style
  if (typo.cssFontFamily) root.setProperty('--font-mono', typo.cssFontFamily)
  if (typo.fontSize) root.setProperty('--editor-font-size', `${Math.max(11, Math.min(16, typo.fontSize))}px`)
  if (typo.lineHeight) root.setProperty('--editor-line-height', String(typo.lineHeight))
}

function App() {
  const [layout, setLayout] = useState<LayoutMode>('tabs')
  const [activeTab, setActiveTab] = useState<ActiveTab>('local')
  const [settings, setSettings] = useState<PluginUserSettings>(DEFAULT_SETTINGS)
  const [hosts, setHosts] = useState<HostProfile[]>([])
  const [selectedHostId, setSelectedHostId] = useState<string>('')
  const [connection, setConnection] = useState<ConnectionStatus>({
    hostId: null,
    hostName: null,
    connected: false,
    connecting: false
  })
  const [transfers, setTransfers] = useState<TransferSnapshot>(EMPTY_TRANSFERS)
  const [bookmarks, setBookmarks] = useState<BookmarkEntry[]>([])
  const [workspaceHint, setWorkspaceHint] = useState<WorkspaceHint>({
    localPath: null,
    remotePath: null,
    hostId: null,
    workspaceName: null
  })

  // Local pane state
  const [localHome, setLocalHome] = useState('')
  const [localPath, setLocalPath] = useState('')
  const [localEntries, setLocalEntries] = useState<FileEntry[]>([])
  const [localLoading, setLocalLoading] = useState(false)
  const [localError, setLocalError] = useState<string | null>(null)
  const [localSelected, setLocalSelected] = useState<Set<string>>(new Set())
  const [showHiddenLocal, setShowHiddenLocal] = useState(true)

  // Remote pane state
  const [remoteHome, setRemoteHome] = useState('.')
  const [remotePath, setRemotePath] = useState('')
  const [remoteEntries, setRemoteEntries] = useState<FileEntry[]>([])
  const [remoteLoading, setRemoteLoading] = useState(false)
  const [remoteError, setRemoteError] = useState<string | null>(null)
  const [remoteSelected, setRemoteSelected] = useState<Set<string>>(new Set())
  const [showHiddenRemote, setShowHiddenRemote] = useState(true)

  // UI overlays & split sizing
  const [contextMenu, setContextMenu] = useState<ContextMenuState | null>(null)
  const [editorFile, setEditorFile] = useState<EditorFilePayload | null>(null)
  const [previewImage, setPreviewImage] = useState<ImagePreviewPayload | null>(null)
  const [tailSession, setTailSession] = useState<ActiveTailSession | null>(null)
  const [syncBrowsing, setSyncBrowsing] = useState(false)
  const [hubOpen, setHubOpen] = useState(false)
  const [modal, setModal] = useState<ModalState>(null)
  const [toast, setToast] = useState<{ text: string; isError?: boolean } | null>(null)
  const [splitRatio, setSplitRatio] = useState(50)
  const [draggingSplit, setDraggingSplit] = useState(false)
  const [drawerOpen, setDrawerOpen] = useState(false)
  const [compactTabMenuOpen, setCompactTabMenuOpen] = useState(false)
  const [viewportWidth, setViewportWidth] = useState(window.innerWidth)

  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const splitContainerRef = useRef<HTMLDivElement>(null)
  const compactMenuRef = useRef<HTMLDivElement>(null)
  const prevCompletedRef = useRef(0)

  const notify = useCallback((text: string, isError = false) => {
    setToast({ text, isError })
    if (toastTimer.current) clearTimeout(toastTimer.current)
    toastTimer.current = setTimeout(() => setToast(null), isError ? 4500 : 2800)
  }, [])

  const loadLocal = useCallback(async (targetPath?: string) => {
    setLocalLoading(true)
    setLocalError(null)
    try {
      const res = await requestWorker('fs.list', { side: 'local', path: targetPath })
      setLocalPath(res.path)
      setLocalEntries(res.entries)
      setLocalSelected(new Set())
    } catch (err) {
      setLocalError(err instanceof Error ? err.message : String(err))
    } finally {
      setLocalLoading(false)
    }
  }, [])

  const loadRemote = useCallback(async (targetPath?: string, hostId?: string) => {
    setRemoteLoading(true)
    setRemoteError(null)
    try {
      const res = await requestWorker('fs.list', { side: 'remote', path: targetPath, hostId })
      setRemotePath(res.path)
      setRemoteEntries(res.entries)
      setRemoteSelected(new Set())
    } catch (err) {
      setRemoteError(err instanceof Error ? err.message : String(err))
    } finally {
      setRemoteLoading(false)
    }
  }, [])

  const connectHost = useCallback(
    async (hostId: string, overrideRemotePath?: string, silent = false) => {
      const profile = hosts.find((h) => h.id === hostId)
      if (profile?.needsSshBinding) {
        setModal({ kind: 'host', initial: profile })
        return
      }
      setSelectedHostId(hostId)
      void requestWorker('session.save', { lastHostId: hostId }).catch(() => undefined)
      setRemoteLoading(true)
      setRemoteError(null)
      try {
        const res = await requestWorker('connection.connect', { hostId })
        setConnection(res.connection)
        setRemoteHome(res.connection.remoteHome || res.remotePath)
        if (overrideRemotePath) {
          await loadRemote(overrideRemotePath, hostId)
        } else {
          setRemotePath(res.remotePath)
          setRemoteEntries(res.entries)
          setRemoteSelected(new Set())
        }
        if (!silent) notify(`Conectado a ${res.connection.hostName}`)
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        setRemoteError(msg)
        if (!silent) {
          notify(msg, true)
          if (
            profile &&
            /permission denied|authentication|publickey|passphrase|senha/i.test(msg)
          ) {
            setModal({ kind: 'host', initial: profile })
          }
        }
      } finally {
        setRemoteLoading(false)
      }
    },
    [hosts, loadRemote, notify]
  )

  // Initial bootstrap + Orca events + resize listener
  useEffect(() => {
    const onResize = () => setViewportWidth(window.innerWidth)
    window.addEventListener('resize', onResize)

    if (orca.host.has('editor.readTypography')) {
      void orca.host
        .call('editor.readTypography', {})
        .then(applyTypographyVars)
        .catch(() => undefined)
    }
    const typoSub = orca.on('editor.typography.changed', (t) => applyTypographyVars(t))
    const txSub = orca.plugin.on('transfers.updated', (snap) => {
      setTransfers(snap)
      if (snap.completedCount > prevCompletedRef.current) {
        prevCompletedRef.current = snap.completedCount
      }
    })
    const connSub = orca.plugin.on('connection.updated', (status) => {
      setConnection(status)
      if (status.hostId) setSelectedHostId(status.hostId)
    })
    const hostsSub = orca.plugin.on('hosts.updated', ({ hosts: next }) => setHosts(next))
    const wsSub = orca.plugin.on('workspace.hint', (hint) => setWorkspaceHint(hint))
    const hubSub = orca.plugin.on('quickHub.toggle', (ev) => {
      setHubOpen((prev) => (typeof ev?.open === 'boolean' ? ev.open : !prev))
    })

    void (async () => {
      try {
        const boot = await requestWorker('app.bootstrap')
        setLocalHome(boot.localHome)
        setSettings(boot.settings)
        setShowHiddenLocal(boot.settings.showHiddenFiles)
        setShowHiddenRemote(boot.settings.showHiddenFiles)
        setHosts(boot.hosts)
        setConnection(boot.connection)
        setTransfers(boot.transfers)
        prevCompletedRef.current = boot.transfers.completedCount
        setBookmarks(boot.bookmarks)
        setWorkspaceHint(boot.workspaceHint)

        const savedSession = boot.session
        const storedLayout =
          savedSession.layout || (await orca.storage.get('sftp.layout').catch(() => null))
        setLayout(storedLayout === 'split' || storedLayout === 'tabs' ? storedLayout : boot.settings.defaultLayout)
        if (typeof savedSession.splitRatio === 'number') {
          setSplitRatio(Math.max(25, Math.min(75, savedSession.splitRatio)))
        }
        if (savedSession.activeTab) {
          setActiveTab(savedSession.activeTab)
        }
        if (typeof savedSession.syncBrowsing === 'boolean') {
          setSyncBrowsing(savedSession.syncBrowsing)
        }

        const initialLocal = savedSession.lastLocalPath || boot.workspaceHint.localPath || boot.localHome
        await loadLocal(initialLocal)

        const hasHost = (id: string | null | undefined): id is string =>
          Boolean(id && boot.hosts.some((h) => h.id === id))

        if (boot.connection.connected && boot.connection.hostId) {
          setSelectedHostId(boot.connection.hostId)
          setRemoteHome(boot.connection.remoteHome || '.')
          const targetRemote =
            savedSession.remotePathsByHost[boot.connection.hostId] || boot.connection.remoteHome || '.'
          await loadRemote(targetRemote, boot.connection.hostId)
        } else if (hasHost(savedSession.lastHostId)) {
          setSelectedHostId(savedSession.lastHostId)
          if (savedSession.wasConnected) {
            // Auto-reconnect seamlessly to the exact host & folder user was on
            try {
              const res = await requestWorker('connection.connect', { hostId: savedSession.lastHostId })
              setConnection(res.connection)
              setRemoteHome(res.connection.remoteHome || res.remotePath)
              setRemotePath(res.remotePath)
              setRemoteEntries(res.entries)
              setRemoteSelected(new Set())
            } catch {
              // Keep selectedHostId preserved so user can click Conectar without losing selection
            }
          }
        } else if (hasHost(boot.workspaceHint.hostId)) {
          setSelectedHostId(boot.workspaceHint.hostId)
        } else if (boot.hosts.length > 0) {
          setSelectedHostId(boot.hosts[0].id)
        }
      } catch (err) {
        notify(err instanceof Error ? err.message : String(err), true)
      }
    })()

    return () => {
      window.removeEventListener('resize', onResize)
      typoSub.dispose()
      txSub.dispose()
      connSub.dispose()
      hostsSub.dispose()
      wsSub.dispose()
      hubSub.dispose()
    }
  }, [loadLocal, loadRemote, notify])

  // Refresh panes automatically when a transfer finishes
  useEffect(() => {
    if (transfers.completedCount > 0 && transfers.activeCount === 0 && transfers.queuedCount === 0) {
      if (localPath) void loadLocal(localPath)
      if (connection.connected && remotePath) void loadRemote(remotePath)
    }
  }, [transfers.completedCount, transfers.activeCount, transfers.queuedCount])

  // Close compact tab dropdown on outside click
  useEffect(() => {
    if (!compactTabMenuOpen) return
    const onDown = (e: MouseEvent) => {
      if (compactMenuRef.current && !compactMenuRef.current.contains(e.target as Node)) {
        setCompactTabMenuOpen(false)
      }
    }
    window.addEventListener('mousedown', onDown)
    return () => window.removeEventListener('mousedown', onDown)
  }, [compactTabMenuOpen])

  // Resizable split divider drag handling
  useEffect(() => {
    if (!draggingSplit) return
    let latestRatio = splitRatio
    const onMove = (e: MouseEvent) => {
      const el = splitContainerRef.current
      if (!el) return
      const rect = el.getBoundingClientRect()
      const pct = ((e.clientX - rect.left) / rect.width) * 100
      latestRatio = Math.max(25, Math.min(75, pct))
      setSplitRatio(latestRatio)
    }
    const onUp = () => {
      setDraggingSplit(false)
      void requestWorker('session.save', { splitRatio: Math.round(latestRatio) }).catch(() => undefined)
    }
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
    return () => {
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
    }
  }, [draggingSplit])

  const toggleLayout = () => {
    const next: LayoutMode = layout === 'tabs' ? 'split' : 'tabs'
    setLayout(next)
    void requestWorker('session.save', { layout: next }).catch(() => undefined)
  }

  const selectTab = (tab: ActiveTab) => {
    setActiveTab(tab)
    void requestWorker('session.save', { activeTab: tab }).catch(() => undefined)
  }

  const toggleSyncBrowsing = () => {
    const next = !syncBrowsing
    setSyncBrowsing(next)
    void requestWorker('session.save', { syncBrowsing: next }).catch(() => undefined)
    notify(next ? 'Navegação sincronizada (🔗) ativada' : 'Navegação sincronizada desativada')
  }

  const navigateSide = useCallback(
    async (
      side: Side,
      targetPath: string,
      relativeAction?: { kind: 'enter'; name: string } | { kind: 'up' }
    ) => {
      if (side === 'local') {
        await loadLocal(targetPath)
        if (syncBrowsing && connection.connected && relativeAction && remotePath) {
          const mirror =
            relativeAction.kind === 'enter'
              ? posixJoin(remotePath, relativeAction.name)
              : posixDirname(remotePath)
          try {
            const res = await requestWorker('fs.list', { side: 'remote', path: mirror })
            setRemotePath(res.path)
            setRemoteEntries(res.entries)
            setRemoteSelected(new Set())
          } catch {
            notify(
              relativeAction.kind === 'enter'
                ? `Sync: pasta "${relativeAction.name}" não existe no Remoto`
                : 'Sync: não foi possível subir pasta no Remoto'
            )
          }
        }
      } else {
        await loadRemote(targetPath)
        if (syncBrowsing && relativeAction && localPath) {
          const mirror =
            relativeAction.kind === 'enter'
              ? posixJoin(localPath, relativeAction.name)
              : posixDirname(localPath)
          try {
            const res = await requestWorker('fs.list', { side: 'local', path: mirror })
            setLocalPath(res.path)
            setLocalEntries(res.entries)
            setLocalSelected(new Set())
          } catch {
            notify(
              relativeAction.kind === 'enter'
                ? `Sync: pasta "${relativeAction.name}" não existe no Local`
                : 'Sync: não foi possível subir pasta no Local'
            )
          }
        }
      }
    },
    [connection.connected, loadLocal, loadRemote, localPath, notify, remotePath, syncBrowsing]
  )

  const openImagePreview = useCallback(
    async (side: Side, entry: { path: string; name: string }) => {
      try {
        const img = await requestWorker('preview.readImage', {
          side,
          path: entry.path,
          hostId: side === 'remote' ? connection.hostId || undefined : undefined
        })
        setPreviewImage(img)
      } catch (err) {
        notify(err instanceof Error ? err.message : String(err), true)
      }
    },
    [connection.hostId, notify]
  )

  const openLogTail = useCallback(
    async (side: Side, entry: { path: string; name: string }) => {
      if (tailSession) {
        void requestWorker('tail.stop', { tailId: tailSession.tailId }).catch(() => undefined)
      }
      try {
        const res = await requestWorker('tail.start', {
          side,
          path: entry.path,
          hostId: side === 'remote' ? connection.hostId || undefined : undefined,
          lines: 200
        })
        setTailSession({ tailId: res.tailId, side, path: entry.path, name: entry.name })
      } catch (err) {
        notify(err instanceof Error ? err.message : String(err), true)
      }
    },
    [connection.hostId, notify, tailSession]
  )

  const closeLogTail = useCallback(() => {
    if (!tailSession) return
    const id = tailSession.tailId
    setTailSession(null)
    void requestWorker('tail.stop', { tailId: id }).catch(() => undefined)
  }, [tailSession])

  const uploadExternalFinderFiles = useCallback(
    async (fileList: FileList) => {
      if (!connection.connected || !connection.hostId) {
        notify('Conecte-se a um host remoto antes de arrastar arquivos do Finder.', true)
        return
      }
      const files = Array.from(fileList)
      if (!files.length) return

      // Path A: Electron exposes native File.path -> use full TransferManager queue + conflict modal!
      const withNativePaths = files as Array<File & { path?: string }>
      if (withNativePaths.every((f) => typeof f.path === 'string' && f.path.length > 0)) {
        const fakeEntries: FileEntry[] = withNativePaths.map((f) => ({
          name: f.name,
          path: f.path!,
          isDirectory: false,
          isSymlink: false,
          size: f.size,
          mtimeMs: f.lastModified || Date.now(),
          mode: 0o100644,
          permissions: 'rw-r--r--',
          isHidden: f.name.startsWith('.'),
          isArchive: false,
          archiveType: null,
          isEditableText: false
        }))
        await enqueueTransfer('local', fakeEntries, 'normal')
        return
      }

      // Path B: Isolated sandbox frame (no File.path) -> stream in 256 KB base64 chunks!
      const targetDir = remotePath || remoteHome || '.'
      const CHUNK = 256 * 1024
      let uploaded = 0
      try {
        for (const file of files) {
          notify(`Enviando do Finder: ${file.name}...`)
          const init = await requestWorker('fs.uploadChunkInit', {
            hostId: connection.hostId,
            targetDir,
            name: file.name,
            backupBeforeOverwrite: true
          })
          try {
            const buf = new Uint8Array(await file.arrayBuffer())
            let offset = 0
            while (offset < buf.length) {
              const slice = buf.subarray(offset, Math.min(buf.length, offset + CHUNK))
              let binary = ''
              for (let i = 0; i < slice.length; i++) binary += String.fromCharCode(slice[i])
              const dataBase64 = btoa(binary)
              await requestWorker('fs.uploadChunkWrite', {
                uploadId: init.uploadId,
                offset,
                dataBase64
              })
              offset += slice.length
            }
            await requestWorker('fs.uploadChunkFinish', { uploadId: init.uploadId })
            uploaded++
          } catch (innerErr) {
            await requestWorker('fs.uploadChunkFinish', {
              uploadId: init.uploadId,
              cancel: true
            }).catch(() => undefined)
            throw innerErr
          }
        }
        notify(`${uploaded} arquivo(s) enviado(s) do Finder para ${targetDir}`)
        await loadRemote(targetDir)
      } catch (err) {
        notify(err instanceof Error ? err.message : String(err), true)
      }
    },
    [connection.connected, connection.hostId, loadRemote, notify, remoteHome, remotePath]
  )

  const refreshSide = useCallback(
    async (side: Side) => {
      if (side === 'local') await loadLocal(localPath || localHome)
      else if (connection.connected) await loadRemote(remotePath || remoteHome)
    },
    [connection.connected, loadLocal, loadRemote, localHome, localPath, remoteHome, remotePath]
  )

  const openEditorForEntry = useCallback(
    async (side: Side, entry: FileEntry, forceText = false) => {
      try {
        const payload = await requestWorker('editor.read', {
          side,
          path: entry.path,
          hostId: side === 'remote' ? connection.hostId || undefined : undefined,
          forceText
        })
        setEditorFile(payload)
      } catch (err) {
        notify(err instanceof Error ? err.message : String(err), true)
      }
    },
    [connection.hostId, notify]
  )

  const dispatchEnqueue = useCallback(
    async (
      fromSide: Side,
      entries: FileEntry[],
      priority: TransferPriority = 'normal',
      renameMap?: Record<string, string>,
      backupBeforeOverwrite = false
    ) => {
      if (!connection.connected || !connection.hostId) {
        notify('Conecte-se a um host remoto antes de transferir arquivos.', true)
        return
      }
      if (!entries.length) return
      const direction = fromSide === 'local' ? 'upload' : 'download'
      const targetDir = direction === 'upload' ? remotePath || remoteHome : localPath || localHome
      try {
        const res = await requestWorker('transfers.enqueue', {
          hostId: connection.hostId,
          direction,
          priority,
          items: entries.map((e) => ({
            sourcePath: e.path,
            targetDir,
            isDirectory: e.isDirectory,
            name: e.name,
            targetName: renameMap?.[e.path],
            backupBeforeOverwrite,
            size: e.size
          }))
        })
        setTransfers(res.snapshot)
        // Auto-open transfer drawer in Split mode so activity is immediately visible
        if (layout === 'split') {
          setDrawerOpen(true)
        }
        notify(
          `${entries.length} item(ns) na fila (${direction === 'upload' ? 'Upload ↑' : 'Download ↓'})`
        )
      } catch (err) {
        notify(err instanceof Error ? err.message : String(err), true)
      }
    },
    [connection.connected, connection.hostId, layout, localHome, localPath, notify, remoteHome, remotePath]
  )

  const enqueueTransfer = useCallback(
    async (fromSide: Side, entries: FileEntry[], priority: TransferPriority = 'normal') => {
      if (!connection.connected || !connection.hostId) {
        notify('Conecte-se a um host remoto antes de transferir arquivos.', true)
        return
      }
      if (!entries.length) return
      const direction = fromSide === 'local' ? 'upload' : 'download'
      const targetDir = direction === 'upload' ? remotePath || remoteHome : localPath || localHome
      try {
        const check = await requestWorker('transfers.checkConflicts', {
          hostId: connection.hostId,
          direction,
          items: entries.map((e) => ({
            sourcePath: e.path,
            targetDir,
            isDirectory: e.isDirectory,
            name: e.name,
            size: e.size,
            mtimeMs: e.mtimeMs
          }))
        })
        if (check.conflicts.length > 0) {
          setModal({
            kind: 'conflict',
            fromSide,
            direction,
            entries,
            conflicts: check.conflicts,
            priority
          })
          return
        }
        await dispatchEnqueue(fromSide, entries, priority)
      } catch (err) {
        notify(err instanceof Error ? err.message : String(err), true)
      }
    },
    [connection.connected, connection.hostId, dispatchEnqueue, localHome, localPath, notify, remoteHome, remotePath]
  )

  const handleTransferAction = useCallback(
    async (
      action: 'pause' | 'resume' | 'cancel' | 'retry' | 'remove' | 'pauseAll' | 'resumeAll' | 'clearCompleted',
      transferId?: string
    ) => {
      const res = await requestWorker('transfers.action', { action, transferId })
      setTransfers(res.snapshot)
    },
    []
  )

  const handleSetPriority = useCallback(async (transferId: string, priority: TransferPriority) => {
    const res = await requestWorker('transfers.setPriority', { transferId, priority })
    setTransfers(res.snapshot)
  }, [])

  const handleReorder = useCallback(
    async (transferId: string, move: 'top' | 'up' | 'down' | 'bottom') => {
      const res = await requestWorker('transfers.reorder', { transferId, move })
      setTransfers(res.snapshot)
    },
    []
  )

  const handleSyncWorkspace = async () => {
    if (workspaceHint.localPath) {
      await loadLocal(workspaceHint.localPath)
      notify(`Local sincronizado com ${workspaceHint.workspaceName || 'workspace'}`)
    }
    if (workspaceHint.hostId) {
      const host = hosts.find((h) => h.id === workspaceHint.hostId)
      if (host) {
        await connectHost(host.id, workspaceHint.remotePath || undefined)
        return
      }
    }
    if (!workspaceHint.localPath && !workspaceHint.hostId) {
      notify('Nenhum workspace focado na Orca para sincronizar.')
    }
  }

  const handleSaveHost = async (input: SaveHostInput) => {
    const res = await requestWorker('hosts.save', input)
    setHosts(res.hosts)
    if (res.host) {
      setSelectedHostId(res.host.id)
      // Connect immediately after saving
      const conn = await requestWorker('connection.connect', { hostId: res.host.id })
      setConnection(conn.connection)
      setRemoteHome(conn.connection.remoteHome || conn.remotePath)
      setRemotePath(conn.remotePath)
      setRemoteEntries(conn.entries)
      notify(`Host "${res.host.name}" salvo e conectado`)
    }
  }

  const handleDeleteHost = async (hostId: string) => {
    const res = await requestWorker('hosts.delete', { hostId })
    setHosts(res.hosts)
    notify('Conexão removida')
  }

  const handleToggleBookmark = async (side: Side) => {
    const currentPath = side === 'local' ? localPath : remotePath
    if (!currentPath) return
    const res = await requestWorker('bookmarks.toggle', {
      side,
      path: currentPath,
      label: posixBasename(currentPath) || currentPath,
      hostId: side === 'remote' ? connection.hostId || undefined : undefined
    })
    setBookmarks(res.bookmarks)
  }

  // Group hosts cleanly for the dropdown
  const hostGroups = useMemo(() => {
    return {
      orcaSsh: hosts.filter((h) => h.kind === 'orca-ssh'),
      orcaEnv: hosts.filter((h) => h.kind === 'orca-env'),
      sshConfig: hosts.filter((h) => h.kind === 'ssh-config'),
      manual: hosts.filter((h) => h.kind === 'manual')
    }
  }, [hosts])

  const selectedProfile = hosts.find((h) => h.id === selectedHostId)
  const pendingTransfers = transfers.activeCount + transfers.queuedCount
  const showRedDot = pendingTransfers > 0 || transfers.errorCount > 0

  // Responsive layout breakpoints:
  // - < 520px: automatically uses Tabs mode (never cramped stacked split!)
  // - < 310px: segmented tabs turn into a clean dropdown menu (never clipped text!)
  const canSplit = viewportWidth >= 520
  const effectiveLayout: LayoutMode = layout === 'split' && canSplit ? 'split' : 'tabs'
  const useCompactTabMenu = effectiveLayout === 'tabs' && viewportWidth < 310
  const useShortTabLabel = effectiveLayout === 'tabs' && viewportWidth < 370
  const paneNarrow = effectiveLayout === 'split' ? viewportWidth * (splitRatio / 100) < 350 : viewportWidth < 350
  const remotePaneNarrow =
    effectiveLayout === 'split' ? viewportWidth * ((100 - splitRatio) / 100) < 350 : viewportWidth < 350

  const runningSummary = useMemo(() => {
    const running = transfers.items.filter((i) => i.status === 'running')
    if (!running.length) return null
    const total = running.reduce((s, i) => s + i.totalBytes, 0)
    const done = running.reduce((s, i) => s + i.bytesTransferred, 0)
    const pct = total > 0 ? Math.min(100, Math.round((done / total) * 100)) : 0
    return {
      pct,
      label:
        running.length === 1
          ? `${running[0].direction === 'upload' ? '↑' : '↓'} ${running[0].name} (${pct}%)`
          : `${running.length} transferindo (${pct}%)`
    }
  }, [transfers.items])

  const renderTransferBadge = () => {
    if (pendingTransfers > 0) {
      return (
        <>
          <span class="tab-dot" />
          <span class="tab-badge">{pendingTransfers}</span>
        </>
      )
    }
    if (transfers.errorCount > 0) {
      return <span class="tab-badge">{transfers.errorCount}</span>
    }
    if (transfers.pausedCount > 0) {
      return <span class="tab-badge paused">{transfers.pausedCount}</span>
    }
    return null
  }

  const contextCallbacks = {
    onClose: () => setContextMenu(null),
    onOpenFolder: (entry: FileEntry) => {
      if (!contextMenu) return
      void navigateSide(contextMenu.side, entry.path, { kind: 'enter', name: entry.name })
    },
    onTransfer: (side: Side, entries: FileEntry[], priority: 'high' | 'normal' = 'normal') => {
      void enqueueTransfer(side, entries, priority)
    },
    onEdit: (side: Side, entry: FileEntry, forceText = false) => {
      void openEditorForEntry(side, entry, forceText)
    },
    onPreviewImage: (side: Side, entry: FileEntry) => {
      void openImagePreview(side, entry)
    },
    onTailLog: (side: Side, entry: FileEntry) => {
      void openLogTail(side, entry)
    },
    onCompress: (side: Side, entries: FileEntry[], format: ArchiveFormat) => {
      setModal({ kind: 'compress', side, entries, defaultFormat: format })
    },
    onExtract: (side: Side, entry: FileEntry, createSubfolder: boolean) => {
      const dest = side === 'local' ? localPath : remotePath
      notify(`Descompactando ${entry.name}...`)
      void orca.plugin
        .request('fs.extract', {
          side,
          archivePath: entry.path,
          destinationDir: dest,
          createSubfolder,
          hostId: side === 'remote' ? connection.hostId || undefined : undefined
        })
        .then(async (res) => {
          notify(`Extraído em ${res.extractedTo}`)
          await refreshSide(side)
        })
        .catch((err) => notify(err instanceof Error ? err.message : String(err), true))
    },
    onNewFolder: (side: Side) => setModal({ kind: 'mkdir', side }),
    onNewFile: (side: Side) => setModal({ kind: 'newFile', side }),
    onRename: (side: Side, entry: FileEntry) => setModal({ kind: 'rename', side, entry }),
    onChmod: (side: Side, entry: FileEntry) => setModal({ kind: 'chmod', side, entry }),
    onCopyPath: (entry: FileEntry) => {
      void navigator.clipboard?.writeText(entry.path).then(() => notify('Caminho copiado'))
    },
    onDelete: (side: Side, entries: FileEntry[]) => setModal({ kind: 'delete', side, entries }),
    onRefresh: (side: Side) => void refreshSide(side),
    canTransfer: connection.connected
  }

  const handleOpenSearchResult = useCallback(
    async (side: Side, res: SearchResultEntry) => {
      if (res.isDirectory) {
        await navigateSide(side, res.path)
        return
      }
      await navigateSide(side, res.parentDir)
      if (res.isImage) {
        await openImagePreview(side, { path: res.path, name: res.name })
      } else if (res.isEditableText) {
        await openEditorForEntry(
          side,
          {
            name: res.name,
            path: res.path,
            isDirectory: false,
            isSymlink: false,
            size: 0,
            mtimeMs: 0,
            mode: 0,
            permissions: '',
            isHidden: res.name.startsWith('.'),
            isArchive: false,
            archiveType: null,
            isEditableText: true
          },
          false
        )
      }
    },
    [navigateSide, openEditorForEntry, openImagePreview]
  )

  const localPane = (
    <FilePane
      side="local"
      title="Local"
      path={localPath}
      homePath={localHome}
      entries={localEntries}
      loading={localLoading}
      error={localError}
      connected={true}
      showHidden={showHiddenLocal}
      narrow={paneNarrow}
      bookmarks={bookmarks}
      selectedPaths={localSelected}
      onToggleHidden={() => setShowHiddenLocal((v) => !v)}
      onNavigate={(p, rel) => void navigateSide('local', p, rel)}
      onRefresh={() => void loadLocal(localPath || localHome)}
      onToggleBookmark={() => void handleToggleBookmark('local')}
      onSelectChange={setLocalSelected}
      onOpenEntry={(entry) => {
        if (entry.isDirectory) void navigateSide('local', entry.path, { kind: 'enter', name: entry.name })
        else if (entry.isImage) void openImagePreview('local', entry)
        else if (entry.isEditableText) void openEditorForEntry('local', entry, false)
        else if (connection.connected) void enqueueTransfer('local', [entry])
      }}
      onContextMenu={(e, entries) => setContextMenu({ x: e.clientX, y: e.clientY, side: 'local', entries })}
      onTransferSelected={(entries) => void enqueueTransfer('local', entries)}
      onDropFromOtherSide={(entries) => void enqueueTransfer('remote', entries)}
      onRecursiveSearch={(q) =>
        requestWorker('fs.search', { side: 'local', rootPath: localPath || localHome, query: q })
      }
      onOpenSearchResult={(res) => void handleOpenSearchResult('local', res)}
      canTransfer={connection.connected}
    />
  )

  const remotePane = (
    <FilePane
      side="remote"
      title={connection.hostName || selectedProfile?.name || 'Remoto'}
      path={remotePath}
      homePath={remoteHome}
      entries={remoteEntries}
      loading={remoteLoading}
      error={remoteError}
      connected={connection.connected}
      showHidden={showHiddenRemote}
      narrow={remotePaneNarrow}
      bookmarks={bookmarks.filter((b) => !b.hostId || b.hostId === connection.hostId)}
      selectedPaths={remoteSelected}
      onToggleHidden={() => setShowHiddenRemote((v) => !v)}
      onNavigate={(p, rel) => void navigateSide('remote', p, rel)}
      onRefresh={() => void loadRemote(remotePath || remoteHome)}
      onToggleBookmark={() => void handleToggleBookmark('remote')}
      onSelectChange={setRemoteSelected}
      onOpenEntry={(entry) => {
        if (entry.isDirectory) void navigateSide('remote', entry.path, { kind: 'enter', name: entry.name })
        else if (entry.isImage) void openImagePreview('remote', entry)
        else if (entry.isEditableText) void openEditorForEntry('remote', entry, false)
        else void enqueueTransfer('remote', [entry])
      }}
      onContextMenu={(e, entries) => setContextMenu({ x: e.clientX, y: e.clientY, side: 'remote', entries })}
      onTransferSelected={(entries) => void enqueueTransfer('remote', entries)}
      onDropFromOtherSide={(entries) => void enqueueTransfer('local', entries)}
      onDropExternalFiles={(files) => void uploadExternalFinderFiles(files)}
      onRecursiveSearch={(q) =>
        requestWorker('fs.search', {
          side: 'remote',
          rootPath: remotePath || remoteHome || '.',
          query: q,
          hostId: connection.hostId || undefined
        })
      }
      onOpenSearchResult={(res) => void handleOpenSearchResult('remote', res)}
      canTransfer={connection.connected}
      disconnectedAction={
        selectedProfile
          ? {
              label: selectedProfile.needsSshBinding
                ? `Vincular SSH em ${selectedProfile.name}`
                : `Conectar a ${selectedProfile.name}`,
              hint: selectedProfile.needsSshBinding
                ? `Servidor Orca Remoto encontrado via VPN (${selectedProfile.hostname || 'endpoint'}). Configure o vínculo SSH uma vez para navegar via SFTP.`
                : `Pronto para abrir ponte SFTP em ${selectedProfile.name} (${selectedProfile.sourceLabel}).`,
              onClick: () => void connectHost(selectedProfile.id)
            }
          : {
              label: 'Nova conexão SSH',
              hint: 'Adicione uma conexão SSH manual ou atualize a lista de hosts da Orca.',
              onClick: () => setModal({ kind: 'host' })
            }
      }
    />
  )

  const activeTabLabel =
    activeTab === 'local' ? 'Local' : activeTab === 'remote' ? 'Remoto' : 'Transferências'

  return (
    <div class="app">
      {/* Top Header */}
      <div class="header">
        <div class="header-top">
          <div class="header-title-group">
            <span
              class={`status-dot ${
                connection.connecting
                  ? 'connecting'
                  : connection.connected
                    ? 'connected'
                    : connection.error
                      ? 'error'
                      : ''
              }`}
              title={
                connection.connected
                  ? `Conectado via ${connection.transportMode}`
                  : connection.connecting
                    ? 'Conectando...'
                    : 'Desconectado'
              }
            />
            <span class="header-title">{viewportWidth < 290 ? 'SFTP' : 'SFTP Bridge'}</span>
          </div>

          <div class="header-actions">
            {effectiveLayout === 'split' && (
              <>
                <button
                  class={`icon-btn ${syncBrowsing ? 'icon-btn-accent' : ''}`}
                  title={
                    syncBrowsing
                      ? 'Navegação Sincronizada ATIVA (Local ⇄ Remoto)'
                      : 'Ativar Navegação Sincronizada (Local ⇄ Remoto)'
                  }
                  onClick={toggleSyncBrowsing}
                >
                  <Icon name="link" size={14} />
                </button>
                <button
                  class={`icon-btn ${drawerOpen ? 'active' : ''}`}
                  title="Abrir / fechar fila de transferências"
                  onClick={() => setDrawerOpen((v) => !v)}
                >
                  <Icon name="arrows-up-down" size={14} />
                  {pendingTransfers > 0 && <span class="icon-corner-badge">{pendingTransfers}</span>}
                  {pendingTransfers === 0 && transfers.errorCount > 0 && (
                    <span class="icon-corner-badge">{transfers.errorCount}</span>
                  )}
                  {pendingTransfers === 0 && transfers.errorCount === 0 && transfers.pausedCount > 0 && (
                    <span class="icon-corner-badge paused">{transfers.pausedCount}</span>
                  )}
                </button>
              </>
            )}
            <button
              class="icon-btn"
              title="Ir para o diretório do Workspace ativo na Orca"
              onClick={() => void handleSyncWorkspace()}
            >
              <Icon name="crosshair" size={14} />
            </button>
            <button
              class="icon-btn"
              title="Atualizar lista de hosts Orca e ~/.ssh/config"
              onClick={() =>
                void requestWorker('hosts.list')
                  .then((r) => {
                    setHosts(r.hosts)
                    notify(`${r.hosts.length} host(s) atualizado(s)`)
                  })
                  .catch((err) => notify(err instanceof Error ? err.message : String(err), true))
              }
            >
              <Icon name="refresh" size={14} />
            </button>
            <button
              class="icon-btn"
              title="Nova conexão SSH"
              onClick={() => setModal({ kind: 'host' })}
            >
              <Icon name="plus" size={14} />
            </button>
            <button
              class={`icon-btn ${hubOpen ? 'icon-btn-accent' : ''}`}
              title="Central SFTP (transferências, ações rápidas e servidores)"
              onClick={() => setHubOpen((v) => !v)}
            >
              <Icon name="zap" size={14} />
            </button>
            <button
              class={`icon-btn ${effectiveLayout === 'split' ? 'active' : ''}`}
              disabled={!canSplit && layout === 'tabs'}
              title={
                !canSplit
                  ? 'Amplie a barra lateral (>= 520px) para ativar o modo Dividido'
                  : effectiveLayout === 'tabs'
                    ? 'Alternar para modo Dividido (Electerm)'
                    : 'Alternar para modo Abas (Compacto)'
              }
              onClick={toggleLayout}
            >
              <Icon name={effectiveLayout === 'tabs' ? 'split' : 'tabs'} size={14} />
            </button>
          </div>
        </div>

        <div class="host-bar">
          <div class="host-select-wrap">
            <select
              class="host-select"
              value={selectedHostId}
              onChange={(e) => {
                const id = (e.target as HTMLSelectElement).value
                setSelectedHostId(id)
                if (id) void connectHost(id)
              }}
            >
              <option value="">Selecionar host remoto...</option>
              {hostGroups.orcaSsh.length > 0 && (
                <optgroup label="Orca · Hosts SSH">
                  {hostGroups.orcaSsh.map((h) => (
                    <option key={h.id} value={h.id}>
                      {h.connected ? '● ' : '○ '}
                      {h.name} ({h.sourceLabel})
                    </option>
                  ))}
                </optgroup>
              )}
              {hostGroups.orcaEnv.length > 0 && (
                <optgroup label="Orca · Servidores Remotos">
                  {hostGroups.orcaEnv.map((h) => (
                    <option key={h.id} value={h.id}>
                      {h.needsSshBinding ? '⚡ ' : '● '}
                      {h.name} ({h.sourceLabel})
                    </option>
                  ))}
                </optgroup>
              )}
              {hostGroups.sshConfig.length > 0 && (
                <optgroup label="~/.ssh/config">
                  {hostGroups.sshConfig.map((h) => (
                    <option key={h.id} value={h.id}>
                      {h.name} ({h.hostname})
                    </option>
                  ))}
                </optgroup>
              )}
              {hostGroups.manual.length > 0 && (
                <optgroup label="Conexões Salvas">
                  {hostGroups.manual.map((h) => (
                    <option key={h.id} value={h.id}>
                      {h.name} ({h.username}@{h.hostname})
                    </option>
                  ))}
                </optgroup>
              )}
            </select>
            <span class="host-select-chevron">
              <Icon name="chevron-down" size={13} />
            </span>
          </div>

          {selectedProfile && (
            <button
              class="icon-btn"
              title="Configurar / vincular SSH deste host"
              onClick={() => setModal({ kind: 'host', initial: selectedProfile })}
            >
              <Icon name="settings" size={13} />
            </button>
          )}

          {connection.connected ? (
            <button
              class="btn xs"
              title="Desconectar sessão SFTP"
              onClick={() =>
                void requestWorker('connection.disconnect').then((r) => {
                  setConnection(r.connection)
                  setRemoteEntries([])
                  notify('Desconectado')
                })
              }
            >
              Sair
            </button>
          ) : (
            <button
              class="btn primary xs"
              disabled={!selectedHostId || connection.connecting}
              onClick={() => selectedHostId && void connectHost(selectedHostId)}
            >
              {connection.connecting ? '...' : 'Conectar'}
            </button>
          )}
        </div>
      </div>

      {/* Mode 1: Tabbed Layout (auto-used when < 520px or user selected Tabs) */}
      {effectiveLayout === 'tabs' && (
        <>
          {useCompactTabMenu ? (
            <div ref={compactMenuRef} class="compact-tab-menu-wrap">
              <button
                class="compact-tab-trigger"
                aria-expanded={compactTabMenuOpen}
                onClick={() => setCompactTabMenuOpen((v) => !v)}
              >
                <span class="compact-tab-trigger-left">
                  <Icon
                    name={activeTab === 'local' ? 'folder' : activeTab === 'remote' ? 'plug' : 'sync'}
                    size={13}
                  />
                  <span>{activeTabLabel}</span>
                  {activeTab !== 'transfers' && renderTransferBadge()}
                </span>
                <Icon name={compactTabMenuOpen ? 'chevron-up' : 'chevron-down'} size={14} />
              </button>

              {compactTabMenuOpen && (
                <div class="compact-tab-dropdown" role="menu">
                  <button
                    class={`compact-tab-option ${activeTab === 'local' ? 'active' : ''}`}
                    onClick={() => {
                      selectTab('local')
                      setCompactTabMenuOpen(false)
                    }}
                  >
                    <span class="compact-tab-trigger-left">
                      <Icon name="folder" size={13} /> Local
                    </span>
                    {activeTab === 'local' && <Icon name="check" size={13} />}
                  </button>
                  <button
                    class={`compact-tab-option ${activeTab === 'remote' ? 'active' : ''}`}
                    onClick={() => {
                      selectTab('remote')
                      setCompactTabMenuOpen(false)
                    }}
                  >
                    <span class="compact-tab-trigger-left">
                      <Icon name="plug" size={13} /> Remoto
                    </span>
                    {activeTab === 'remote' && <Icon name="check" size={13} />}
                  </button>
                  <button
                    class={`compact-tab-option ${activeTab === 'transfers' ? 'active' : ''}`}
                    onClick={() => {
                      selectTab('transfers')
                      setCompactTabMenuOpen(false)
                    }}
                  >
                    <span class="compact-tab-trigger-left">
                      <Icon name="sync" size={13} /> Transferências
                    </span>
                    <span style={{ display: 'inline-flex', alignItems: 'center', gap: '4px' }}>
                      {renderTransferBadge()}
                      {activeTab === 'transfers' && <Icon name="check" size={13} />}
                    </span>
                  </button>
                </div>
              )}
            </div>
          ) : (
            <div class="segmented-bar" role="tablist">
              <button
                role="tab"
                aria-selected={activeTab === 'local'}
                class={`seg-tab ${activeTab === 'local' ? 'active' : ''}`}
                onClick={() => selectTab('local')}
              >
                <span>Local</span>
              </button>
              <button
                role="tab"
                aria-selected={activeTab === 'remote'}
                class={`seg-tab ${activeTab === 'remote' ? 'active' : ''}`}
                onClick={() => selectTab('remote')}
              >
                <span>Remoto</span>
              </button>
              <button
                role="tab"
                aria-selected={activeTab === 'transfers'}
                class={`seg-tab ${activeTab === 'transfers' ? 'active' : ''}`}
                onClick={() => selectTab('transfers')}
                title="Fila de Transferências"
              >
                <span>{useShortTabLabel ? 'Transf.' : 'Transferências'}</span>
                {renderTransferBadge()}
              </button>
            </div>
          )}

          <div class="workspace-body">
            {activeTab === 'local' && localPane}
            {activeTab === 'remote' && remotePane}
            {activeTab === 'transfers' && (
              <TransferPanel
                snapshot={transfers}
                onAction={(a, id) => void handleTransferAction(a, id)}
                onSetPriority={(id, p) => void handleSetPriority(id, p)}
                onReorder={(id, m) => void handleReorder(id, m)}
              />
            )}
          </div>
        </>
      )}

      {/* Mode 2: Split Layout (Electerm — active when >= 520px and Split chosen) */}
      {effectiveLayout === 'split' && (
        <div class="workspace-body">
          <div ref={splitContainerRef} class="split-container">
            <div class="split-pane" style={{ width: `${splitRatio}%` }}>
              {localPane}
            </div>
            <div
              class={`split-divider ${draggingSplit ? 'dragging' : ''}`}
              onMouseDown={(e) => {
                e.preventDefault()
                setDraggingSplit(true)
              }}
              title="Arraste para redimensionar"
            />
            <div class="split-pane" style={{ width: `${100 - splitRatio}%` }}>
              {remotePane}
            </div>
          </div>

          <div
            class={`transfer-drawer ${drawerOpen ? 'open' : ''} ${
              pendingTransfers > 0 ? 'has-activity' : transfers.errorCount > 0 ? 'has-error' : ''
            }`}
          >
            <div class="transfer-drawer-header" onClick={() => setDrawerOpen((v) => !v)}>
              <div style={{ display: 'flex', alignItems: 'center', gap: '6px', fontWeight: 600, minWidth: 0 }}>
                <span>Transferências</span>
                {renderTransferBadge()}
                {runningSummary && <span class="transfer-drawer-summary">{runningSummary.label}</span>}
                {!runningSummary && transfers.pausedCount > 0 && (
                  <span class="transfer-drawer-summary">{transfers.pausedCount} pausada(s)</span>
                )}
                {!runningSummary && !transfers.pausedCount && transfers.completedCount > 0 && (
                  <span class="transfer-drawer-summary">{transfers.completedCount} concluída(s)</span>
                )}
              </div>
              <Icon name={drawerOpen ? 'chevron-down' : 'chevron-up'} size={14} />
              {runningSummary && (
                <div class="transfer-drawer-progress" style={{ width: `${runningSummary.pct}%` }} />
              )}
            </div>
            {drawerOpen && (
              <div class="transfer-drawer-body">
                <TransferPanel
                  snapshot={transfers}
                  onAction={(a, id) => void handleTransferAction(a, id)}
                  onSetPriority={(id, p) => void handleSetPriority(id, p)}
                  onReorder={(id, m) => void handleReorder(id, m)}
                />
              </div>
            )}
          </div>
        </div>
      )}

      {/* Shared Full-Panel Overlays: QuickEditor, ImagePreview, LogTailViewer */}
      {editorFile && (
        <QuickEditor
          file={editorFile}
          onSave={async (nextContent) => {
            const res = await requestWorker('editor.write', {
              side: editorFile.side,
              path: editorFile.path,
              content: nextContent,
              hostId: editorFile.hostId
            })
            setEditorFile((prev) =>
              prev ? { ...prev, content: nextContent, mtimeMs: res.mtimeMs, size: res.size } : null
            )
            notify(`Salvo: ${editorFile.name}`)
            void refreshSide(editorFile.side)
          }}
          onReload={async () => {
            const fresh = await requestWorker('editor.read', {
              side: editorFile.side,
              path: editorFile.path,
              hostId: editorFile.hostId,
              forceText: true
            })
            setEditorFile(fresh)
            notify('Arquivo recarregado')
          }}
          onClose={() => setEditorFile(null)}
        />
      )}

      {previewImage && (
        <ImagePreview
          image={previewImage}
          canTransfer={connection.connected}
          onTransfer={() => {
            void enqueueTransfer(previewImage.side, [
              {
                name: previewImage.name,
                path: previewImage.path,
                isDirectory: false,
                isSymlink: false,
                size: previewImage.size,
                mtimeMs: Date.now(),
                mode: 0o100644,
                permissions: '',
                isHidden: previewImage.name.startsWith('.'),
                isArchive: false,
                archiveType: null,
                isEditableText: false,
                isImage: true
              }
            ])
          }}
          onClose={() => setPreviewImage(null)}
        />
      )}

      {tailSession && <LogTailViewer session={tailSession} onStop={closeLogTail} />}

      {/* Floating Quick Hub Popover (triggered by Status Bar item or ⚡ button) */}
      {hubOpen && (
        <QuickHubPopover
          connection={connection}
          hosts={hosts}
          transfers={transfers}
          syncBrowsing={syncBrowsing}
          layout={effectiveLayout}
          canSplit={canSplit}
          onClose={() => setHubOpen(false)}
          onConnectHost={(id) => void connectHost(id)}
          onDisconnect={() => {
            void requestWorker('connection.disconnect').then((r) => {
              setConnection(r.connection)
              setRemoteEntries([])
              notify('Desconectado')
            })
          }}
          onToggleSync={toggleSyncBrowsing}
          onSyncWorkspace={() => void handleSyncWorkspace()}
          onToggleLayout={toggleLayout}
          onRefreshHosts={() => {
            void requestWorker('hosts.list')
              .then((r) => {
                setHosts(r.hosts)
                notify(`${r.hosts.length} host(s) atualizado(s)`)
              })
              .catch((err) => notify(err instanceof Error ? err.message : String(err), true))
          }}
          onNewHost={() => setModal({ kind: 'host' })}
          onOpenFullTransfers={() => {
            if (effectiveLayout === 'split') setDrawerOpen(true)
            else selectTab('transfers')
          }}
          onTransferAction={(a, id) => void handleTransferAction(a, id)}
        />
      )}

      {/* Right-click Context Menu */}
      {contextMenu && <ContextMenu menu={contextMenu} callbacks={contextCallbacks} />}

      {/* Modals */}
      {modal?.kind === 'host' && (
        <HostModal
          initial={modal.initial}
          onSave={handleSaveHost}
          onDelete={handleDeleteHost}
          onClose={() => setModal(null)}
        />
      )}

      {modal?.kind === 'mkdir' && (
        <PromptModal
          title={`Nova pasta (${modal.side === 'remote' ? 'Remoto' : 'Local'})`}
          label="Nome da pasta"
          placeholder="minha-pasta"
          confirmLabel="Criar pasta"
          onConfirm={async (name) => {
            await requestWorker('fs.mkdir', {
              side: modal.side,
              parentPath: modal.side === 'local' ? localPath : remotePath,
              name,
              hostId: modal.side === 'remote' ? connection.hostId || undefined : undefined
            })
            notify(`Pasta "${name}" criada`)
            await refreshSide(modal.side)
          }}
          onClose={() => setModal(null)}
        />
      )}

      {modal?.kind === 'newFile' && (
        <PromptModal
          title={`Novo arquivo (${modal.side === 'remote' ? 'Remoto' : 'Local'})`}
          label="Nome do arquivo"
          placeholder="notas.md"
          confirmLabel="Criar e abrir"
          onConfirm={async (name) => {
            const res = await requestWorker('fs.createFile', {
              side: modal.side,
              parentPath: modal.side === 'local' ? localPath : remotePath,
              name,
              content: '',
              hostId: modal.side === 'remote' ? connection.hostId || undefined : undefined
            })
            notify(`Arquivo "${name}" criado`)
            await refreshSide(modal.side)
            setEditorFile({
              side: modal.side,
              hostId: modal.side === 'remote' ? connection.hostId || undefined : undefined,
              path: res.createdPath,
              name,
              content: '',
              size: 0,
              mtimeMs: Date.now(),
              encoding: 'utf-8'
            })
          }}
          onClose={() => setModal(null)}
        />
      )}

      {modal?.kind === 'rename' && (
        <PromptModal
          title="Renomear"
          label="Novo nome"
          initialValue={modal.entry.name}
          confirmLabel="Renomear"
          onConfirm={async (newName) => {
            await requestWorker('fs.rename', {
              side: modal.side,
              oldPath: modal.entry.path,
              newName,
              hostId: modal.side === 'remote' ? connection.hostId || undefined : undefined
            })
            notify(`Renomeado para "${newName}"`)
            await refreshSide(modal.side)
          }}
          onClose={() => setModal(null)}
        />
      )}

      {modal?.kind === 'chmod' && (
        <PromptModal
          title={`Permissões (chmod) — ${modal.entry.name}`}
          description={`Atual: ${modal.entry.permissions} (${formatModeOctal(modal.entry.mode)})`}
          label="Modo octal (ex.: 644, 755, 600)"
          initialValue={formatModeOctal(modal.entry.mode)}
          confirmLabel="Aplicar"
          onConfirm={async (mode) => {
            await requestWorker('fs.chmod', {
              side: modal.side,
              path: modal.entry.path,
              mode,
              hostId: modal.side === 'remote' ? connection.hostId || undefined : undefined
            })
            notify(`Permissões alteradas para ${mode}`)
            await refreshSide(modal.side)
          }}
          onClose={() => setModal(null)}
        />
      )}

      {modal?.kind === 'compress' && (
        <CompressModal
          side={modal.side}
          entries={modal.entries}
          defaultFormat={modal.defaultFormat || settings.defaultArchiveFormat}
          onConfirm={async (archiveName, format) => {
            const cwd = modal.side === 'local' ? localPath : remotePath
            const res = await requestWorker('fs.compress', {
              side: modal.side,
              cwd,
              names: modal.entries.map((e) => e.name),
              archiveName,
              format,
              hostId: modal.side === 'remote' ? connection.hostId || undefined : undefined
            })
            notify(`Compactado: ${posixBasename(res.archivePath)}`)
            await refreshSide(modal.side)
          }}
          onClose={() => setModal(null)}
        />
      )}

      {modal?.kind === 'delete' && (
        <ConfirmDeleteModal
          side={modal.side}
          entries={modal.entries}
          onConfirm={async () => {
            const res = await requestWorker('fs.delete', {
              side: modal.side,
              paths: modal.entries.map((e) => e.path),
              hostId: modal.side === 'remote' ? connection.hostId || undefined : undefined
            })
            notify(`${res.deletedCount} item(ns) excluído(s)`)
            await refreshSide(modal.side)
          }}
          onClose={() => setModal(null)}
        />
      )}

      {modal?.kind === 'conflict' && (
        <ConflictModal
          direction={modal.direction}
          totalCount={modal.entries.length}
          conflicts={modal.conflicts}
          onRequestDiff={(conflict) =>
            requestWorker('transfers.diffConflict', {
              hostId: connection.hostId || undefined,
              direction: modal.direction,
              sourcePath: conflict.sourcePath,
              targetPath: conflict.targetPath
            })
          }
          onOverwrite={async (backupBeforeOverwrite) => {
            await dispatchEnqueue(modal.fromSide, modal.entries, modal.priority, undefined, backupBeforeOverwrite)
          }}
          onRename={async (customNames) => {
            await dispatchEnqueue(modal.fromSide, modal.entries, modal.priority, customNames, false)
          }}
          onSkip={async () => {
            const conflictSet = new Set(modal.conflicts.map((c) => c.sourcePath))
            const nonConflicting = modal.entries.filter((e) => !conflictSet.has(e.path))
            if (nonConflicting.length > 0) {
              await dispatchEnqueue(modal.fromSide, nonConflicting, modal.priority)
            }
          }}
          onClose={() => setModal(null)}
        />
      )}

      {toast && <div class={`toast ${toast.isError ? 'error' : ''}`}>{toast.text}</div>}
    </div>
  )
}

const mountEl = document.getElementById('root')
if (mountEl) {
  render(<App />, mountEl)
}
