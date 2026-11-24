import { render } from 'preact'
import { useCallback, useEffect, useMemo, useRef, useState } from 'preact/hooks'
import '../protocol.ts'
import { formatModeOctal, posixBasename, posixDirname, posixJoin } from '../shared/file-utils.ts'
import { deduplicateHostsForDisplay } from '../shared/host-display.ts'
import type {
  ArchiveFormat,
  BookmarkEntry,
  ConnectionStatus,
  EditorFilePayload,
  FileEntry,
  HostConnectionState,
  HostProfile,
  HostSftpState,
  ImagePreviewPayload,
  LayoutMode,
  PaneEndpoint,
  PaneId,
  PluginUserSettings,
  SaveHostInput,
  SearchResultEntry,
  TransferDirection,
  TransferPriority,
  TransferSnapshot,
  WorkspaceHint
} from '../shared/types.ts'
import { ConnectionsManager } from './components/ConnectionsManager.tsx'
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

interface PaneState {
  endpoint: PaneEndpoint | null
  path: string
  homePath: string
  entries: FileEntry[]
  loading: boolean
  error: string | null
  selected: Set<string>
  showHidden: boolean
}

const EMPTY_PANE: PaneState = {
  endpoint: null,
  path: '',
  homePath: '.',
  entries: [],
  loading: false,
  error: null,
  selected: new Set(),
  showHidden: true
}

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

function dotClassForState(state: HostConnectionState): string {
  if (state === 'connected') return 'connected'
  if (state === 'connecting') return 'connecting'
  return 'disconnected'
}

function otherPaneId(pane: PaneId): PaneId {
  return pane === 'left' ? 'right' : 'left'
}

function App() {
  const [layout, setLayout] = useState<LayoutMode>('tabs')
  const [activeTab, setActiveTab] = useState<ActiveTab>('local')
  const [settings, setSettings] = useState<PluginUserSettings>(DEFAULT_SETTINGS)
  const [hosts, setHosts] = useState<HostProfile[]>([])
  const [hostStates, setHostStates] = useState<Record<string, HostSftpState>>({})
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
  const [localHome, setLocalHome] = useState('')

  // Dual symmetric panes — defaults to Local (left) × Remote (right)
  const [leftPane, setLeftPane] = useState<PaneState>({
    ...EMPTY_PANE,
    endpoint: { kind: 'local' }
  })
  const [rightPane, setRightPane] = useState<PaneState>({
    ...EMPTY_PANE,
    endpoint: null
  })

  // UI overlays & split sizing
  const [contextMenu, setContextMenu] = useState<ContextMenuState | null>(null)
  const [editorState, setEditorState] = useState<{ paneId: PaneId; file: EditorFilePayload } | null>(null)
  const [previewState, setPreviewState] = useState<{ paneId: PaneId; image: ImagePreviewPayload } | null>(null)
  const [tailSession, setTailSession] = useState<ActiveTailSession | null>(null)
  const [syncBrowsing, setSyncBrowsing] = useState(false)
  const [hubOpen, setHubOpen] = useState(false)
  const [connectionsOpen, setConnectionsOpen] = useState(false)
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

  // Live refs so async callbacks never read stale pane/host state
  const leftPaneRef = useRef(leftPane)
  leftPaneRef.current = leftPane
  const rightPaneRef = useRef(rightPane)
  rightPaneRef.current = rightPane
  const hostsRef = useRef(hosts)
  hostsRef.current = hosts
  const hostStatesRef = useRef(hostStates)
  hostStatesRef.current = hostStates
  const localHomeRef = useRef(localHome)
  localHomeRef.current = localHome
  const remotePathsByHostRef = useRef<Record<string, string>>({})
  const lastLocalPathRef = useRef<string>('')

  const getPane = useCallback(
    (paneId: PaneId): PaneState => (paneId === 'left' ? leftPaneRef.current : rightPaneRef.current),
    []
  )

  const patchPane = useCallback(
    (paneId: PaneId, updater: Partial<PaneState> | ((prev: PaneState) => PaneState)) => {
      const setter = paneId === 'left' ? setLeftPane : setRightPane
      setter((prev) => (typeof updater === 'function' ? updater(prev) : { ...prev, ...updater }))
    },
    []
  )

  const notify = useCallback((text: string, isError = false) => {
    setToast({ text, isError })
    if (toastTimer.current) clearTimeout(toastTimer.current)
    toastTimer.current = setTimeout(() => setToast(null), isError ? 4500 : 2800)
  }, [])

  const getEndpointTitle = useCallback(
    (endpoint: PaneEndpoint | null): string => {
      if (!endpoint) return 'Remoto'
      if (endpoint.kind === 'local') return 'Local'
      const h = hostsRef.current.find((x) => x.id === endpoint.hostId)
      return h?.name || hostStatesRef.current[endpoint.hostId]?.hostName || 'Remoto'
    },
    []
  )

  const isEndpointConnected = useCallback(
    (endpoint: PaneEndpoint | null, states: Record<string, HostSftpState> = hostStatesRef.current): boolean => {
      if (!endpoint) return false
      if (endpoint.kind === 'local') return true
      return states[endpoint.hostId]?.state === 'connected'
    },
    []
  )

  const computeDirection = useCallback(
    (from: PaneEndpoint | null, to: PaneEndpoint | null): TransferDirection | null => {
      if (!from || !to) return null
      if (from.kind === 'local' && to.kind === 'remote') return 'upload'
      if (from.kind === 'remote' && to.kind === 'local') return 'download'
      if (from.kind === 'remote' && to.kind === 'remote') return 'remote-to-remote'
      return null
    },
    []
  )

  const loadPaneDirectory = useCallback(
    async (paneId: PaneId, endpoint: PaneEndpoint, targetPath?: string) => {
      patchPane(paneId, { loading: true, error: null })
      try {
        const res = await requestWorker('fs.list', {
          side: endpoint.kind,
          path: targetPath,
          hostId: endpoint.kind === 'remote' ? endpoint.hostId : undefined
        })
        if (endpoint.kind === 'local') {
          lastLocalPathRef.current = res.path
        } else {
          remotePathsByHostRef.current[endpoint.hostId] = res.path
        }
        patchPane(paneId, {
          path: res.path,
          entries: res.entries,
          selected: new Set(),
          loading: false,
          error: null
        })
      } catch (err) {
        patchPane(paneId, {
          loading: false,
          error: err instanceof Error ? err.message : String(err)
        })
      }
    },
    [patchPane]
  )

  const connectHostById = useCallback(
    async (
      hostId: string,
      opts?: {
        forceReconnect?: boolean
        attachToPane?: PaneId
        overrideRemotePath?: string
        silent?: boolean
      }
    ) => {
      const profile = hostsRef.current.find((h) => h.id === hostId)
      if (profile?.needsSshBinding) {
        setModal({ kind: 'host', initial: profile, attachToPane: opts?.attachToPane || 'right' })
        return
      }

      if (opts?.attachToPane) {
        const ep: PaneEndpoint = { kind: 'remote', hostId }
        patchPane(opts.attachToPane, {
          endpoint: ep,
          loading: true,
          error: null,
          entries: [],
          selected: new Set()
        })
        void requestWorker(
          'session.save',
          opts.attachToPane === 'left'
            ? { leftEndpoint: ep, lastHostId: hostId }
            : { rightEndpoint: ep, lastHostId: hostId }
        ).catch(() => undefined)
      }

      // Optimistically show yellow connecting dot immediately
      setHostStates((prev) => ({
        ...prev,
        [hostId]: {
          hostId,
          hostName: profile?.name || prev[hostId]?.hostName || hostId,
          state: 'connecting'
        }
      }))

      try {
        const res = await requestWorker('connection.connect', {
          hostId,
          forceReconnect: opts?.forceReconnect
        })
        setConnection(res.connection)
        setHostStates(res.hostStates)
        hostStatesRef.current = res.hostStates
        remotePathsByHostRef.current[hostId] = res.remotePath

        const homePath = res.hostState.remoteHome || res.connection.remoteHome || res.remotePath
        const targetPanes = new Set<PaneId>()
        if (opts?.attachToPane) targetPanes.add(opts.attachToPane)

        const leftEp = leftPaneRef.current.endpoint
        const rightEp = rightPaneRef.current.endpoint
        if (leftEp?.kind === 'remote' && leftEp.hostId === hostId) targetPanes.add('left')
        if (rightEp?.kind === 'remote' && rightEp.hostId === hostId) targetPanes.add('right')

        // If user connected from Connections Manager / QuickHub without specifying a pane,
        // and right pane isn't currently connected to another host, attach to right pane automatically
        if (
          targetPanes.size === 0 &&
          (!rightEp || (rightEp.kind === 'remote' && !isEndpointConnected(rightEp, res.hostStates)))
        ) {
          targetPanes.add('right')
          const ep: PaneEndpoint = { kind: 'remote', hostId }
          void requestWorker('session.save', { rightEndpoint: ep, lastHostId: hostId }).catch(() => undefined)
        }

        for (const paneId of targetPanes) {
          const ep: PaneEndpoint = { kind: 'remote', hostId }
          patchPane(paneId, {
            endpoint: ep,
            homePath,
            error: null
          })
          if (opts?.overrideRemotePath) {
            await loadPaneDirectory(paneId, ep, opts.overrideRemotePath)
          } else {
            patchPane(paneId, {
              path: res.remotePath,
              entries: res.entries,
              selected: new Set(),
              loading: false,
              error: null
            })
          }
        }

        if (!opts?.silent) {
          notify(`Conectado a ${res.hostState.hostName}`)
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        setHostStates((prev) => ({
          ...prev,
          [hostId]: {
            hostId,
            hostName: profile?.name || prev[hostId]?.hostName || hostId,
            state: 'error',
            error: msg
          }
        }))
        for (const paneId of ['left', 'right'] as PaneId[]) {
          const ep = getPane(paneId).endpoint
          if (ep?.kind === 'remote' && ep.hostId === hostId) {
            patchPane(paneId, { loading: false, error: msg })
          }
        }
        if (!opts?.silent) {
          notify(msg, true)
          if (profile && /permission denied|authentication|publickey|passphrase|senha/i.test(msg)) {
            setModal({ kind: 'host', initial: profile, attachToPane: opts?.attachToPane })
          }
        }
      }
    },
    [getPane, isEndpointConnected, loadPaneDirectory, notify, patchPane]
  )

  const disconnectHostById = useCallback(
    async (hostId: string) => {
      try {
        const res = await requestWorker('connection.disconnect', { hostId })
        setConnection(res.connection)
        setHostStates(res.hostStates)
        hostStatesRef.current = res.hostStates
        for (const paneId of ['left', 'right'] as PaneId[]) {
          const ep = getPane(paneId).endpoint
          if (ep?.kind === 'remote' && ep.hostId === hostId) {
            patchPane(paneId, { entries: [], selected: new Set(), error: null, loading: false })
          }
        }
        const hostName = hostsRef.current.find((h) => h.id === hostId)?.name || hostId
        notify(`Desconectado de ${hostName}`)
      } catch (err) {
        notify(err instanceof Error ? err.message : String(err), true)
      }
    },
    [getPane, notify, patchPane]
  )

  const selectPaneEndpoint = useCallback(
    async (paneId: PaneId, endpoint: PaneEndpoint) => {
      void requestWorker(
        'session.save',
        paneId === 'left'
          ? { leftEndpoint: endpoint, ...(endpoint.kind === 'remote' ? { lastHostId: endpoint.hostId } : {}) }
          : { rightEndpoint: endpoint, ...(endpoint.kind === 'remote' ? { lastHostId: endpoint.hostId } : {}) }
      ).catch(() => undefined)

      if (endpoint.kind === 'local') {
        const target = lastLocalPathRef.current || localHomeRef.current || undefined
        patchPane(paneId, {
          endpoint,
          homePath: localHomeRef.current,
          error: null,
          selected: new Set()
        })
        await loadPaneDirectory(paneId, endpoint, target)
        return
      }

      const live = hostStatesRef.current[endpoint.hostId]
      if (live?.state === 'connected') {
        const savedPath = remotePathsByHostRef.current[endpoint.hostId] || live.remoteHome || '.'
        patchPane(paneId, {
          endpoint,
          homePath: live.remoteHome || '.',
          error: null,
          selected: new Set()
        })
        await loadPaneDirectory(paneId, endpoint, savedPath)
      } else {
        await connectHostById(endpoint.hostId, { attachToPane: paneId })
      }
    },
    [connectHostById, loadPaneDirectory, patchPane]
  )

  const refreshPane = useCallback(
    async (paneId: PaneId) => {
      const pane = getPane(paneId)
      if (!pane.endpoint) return
      if (pane.endpoint.kind === 'remote' && !isEndpointConnected(pane.endpoint)) return
      await loadPaneDirectory(paneId, pane.endpoint, pane.path || pane.homePath)
    },
    [getPane, isEndpointConnected, loadPaneDirectory]
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
    })
    const hostStatesSub = orca.plugin.on('hostStates.updated', (states) => {
      setHostStates(states)
      hostStatesRef.current = states
    })
    const hostsSub = orca.plugin.on('hosts.updated', ({ hosts: next }) => {
      setHosts(next)
      hostsRef.current = next
    })
    const wsSub = orca.plugin.on('workspace.hint', (hint) => setWorkspaceHint(hint))
    const hubSub = orca.plugin.on('quickHub.toggle', (ev) => {
      setHubOpen((prev) => (typeof ev?.open === 'boolean' ? ev.open : !prev))
    })

    void (async () => {
      try {
        const boot = await requestWorker('app.bootstrap')
        setLocalHome(boot.localHome)
        localHomeRef.current = boot.localHome
        setSettings(boot.settings)
        setHosts(boot.hosts)
        hostsRef.current = boot.hosts
        setHostStates(boot.hostStates)
        hostStatesRef.current = boot.hostStates
        setConnection(boot.connection)
        setTransfers(boot.transfers)
        prevCompletedRef.current = boot.transfers.completedCount
        setBookmarks(boot.bookmarks)
        setWorkspaceHint(boot.workspaceHint)

        const savedSession = boot.session
        remotePathsByHostRef.current = { ...(savedSession.remotePathsByHost || {}) }

        const storedLayout =
          savedSession.layout || (await orca.storage.get('sftp.layout').catch(() => null))
        setLayout(
          storedLayout === 'split' || storedLayout === 'tabs' ? storedLayout : boot.settings.defaultLayout
        )
        if (typeof savedSession.splitRatio === 'number') {
          setSplitRatio(Math.max(25, Math.min(75, savedSession.splitRatio)))
        }
        if (savedSession.activeTab) {
          setActiveTab(savedSession.activeTab)
        }
        if (typeof savedSession.syncBrowsing === 'boolean') {
          setSyncBrowsing(savedSession.syncBrowsing)
        }

        const hasHost = (id: string | null | undefined): id is string =>
          Boolean(id && boot.hosts.some((h) => h.id === id))

        const resolveEndpoint = (
          candidate: PaneEndpoint | null | undefined,
          fallback: PaneEndpoint | null
        ): PaneEndpoint | null => {
          if (!candidate) return fallback
          if (candidate.kind === 'local') return candidate
          return hasHost(candidate.hostId) ? candidate : fallback
        }

        // Default is always Local (left) × Remote (right)
        const initialLeftEp = resolveEndpoint(savedSession.leftEndpoint, { kind: 'local' })!
        let fallbackRightEp: PaneEndpoint | null = null
        if (boot.connection.connected && hasHost(boot.connection.hostId)) {
          fallbackRightEp = { kind: 'remote', hostId: boot.connection.hostId }
        } else if (hasHost(savedSession.lastHostId)) {
          fallbackRightEp = { kind: 'remote', hostId: savedSession.lastHostId }
        } else if (hasHost(boot.workspaceHint.hostId)) {
          fallbackRightEp = { kind: 'remote', hostId: boot.workspaceHint.hostId }
        } else if (boot.hosts.length > 0) {
          fallbackRightEp = { kind: 'remote', hostId: boot.hosts[0].id }
        }
        const initialRightEp = resolveEndpoint(savedSession.rightEndpoint, fallbackRightEp)

        const initialLocalPath =
          savedSession.lastLocalPath || boot.workspaceHint.localPath || boot.localHome
        lastLocalPathRef.current = initialLocalPath

        const initPane = async (paneId: PaneId, ep: PaneEndpoint | null) => {
          patchPane(paneId, {
            endpoint: ep,
            showHidden: boot.settings.showHiddenFiles,
            homePath: ep?.kind === 'local' ? boot.localHome : '.'
          })
          if (!ep) return

          if (ep.kind === 'local') {
            await loadPaneDirectory(paneId, ep, initialLocalPath)
            return
          }

          const live = boot.hostStates[ep.hostId]
          if (live?.state === 'connected') {
            const targetRemote =
              savedSession.remotePathsByHost[ep.hostId] || live.remoteHome || '.'
            patchPane(paneId, { homePath: live.remoteHome || '.' })
            await loadPaneDirectory(paneId, ep, targetRemote)
          } else if (savedSession.wasConnected) {
            const prof = boot.hosts.find((h) => h.id === ep.hostId)
            if (prof && !prof.needsSshBinding) {
              await connectHostById(ep.hostId, { attachToPane: paneId, silent: true })
            }
          }
        }

        // Sync resolved left/right endpoints to worker so bottom status bar always matches visible panes
        void requestWorker('session.save', {
          leftEndpoint: initialLeftEp,
          rightEndpoint: initialRightEp
        }).catch(() => undefined)

        await Promise.all([initPane('left', initialLeftEp), initPane('right', initialRightEp)])
      } catch (err) {
        notify(err instanceof Error ? err.message : String(err), true)
      }
    })()

    return () => {
      window.removeEventListener('resize', onResize)
      typoSub.dispose()
      txSub.dispose()
      connSub.dispose()
      hostStatesSub.dispose()
      hostsSub.dispose()
      wsSub.dispose()
      hubSub.dispose()
    }
  }, [connectHostById, loadPaneDirectory, notify, patchPane])

  // Refresh connected panes automatically when transfers finish
  useEffect(() => {
    if (transfers.completedCount > 0 && transfers.activeCount === 0 && transfers.queuedCount === 0) {
      void refreshPane('left')
      void refreshPane('right')
    }
  }, [transfers.completedCount, transfers.activeCount, transfers.queuedCount, refreshPane])

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

  const navigatePane = useCallback(
    async (
      paneId: PaneId,
      targetPath: string,
      relativeAction?: { kind: 'enter'; name: string } | { kind: 'up' }
    ) => {
      const pane = getPane(paneId)
      if (!pane.endpoint) return
      await loadPaneDirectory(paneId, pane.endpoint, targetPath)

      if (syncBrowsing && relativeAction) {
        const otherId = otherPaneId(paneId)
        const other = getPane(otherId)
        if (other.endpoint && isEndpointConnected(other.endpoint) && other.path) {
          const mirror =
            relativeAction.kind === 'enter'
              ? posixJoin(other.path, relativeAction.name)
              : posixDirname(other.path)
          try {
            const res = await requestWorker('fs.list', {
              side: other.endpoint.kind,
              path: mirror,
              hostId: other.endpoint.kind === 'remote' ? other.endpoint.hostId : undefined
            })
            if (other.endpoint.kind === 'local') lastLocalPathRef.current = res.path
            else remotePathsByHostRef.current[other.endpoint.hostId] = res.path
            patchPane(otherId, { path: res.path, entries: res.entries, selected: new Set() })
          } catch {
            const otherName = getEndpointTitle(other.endpoint)
            notify(
              relativeAction.kind === 'enter'
                ? `Sync: pasta "${relativeAction.name}" não existe em ${otherName}`
                : `Sync: não foi possível subir pasta em ${otherName}`
            )
          }
        }
      }
    },
    [getEndpointTitle, getPane, isEndpointConnected, loadPaneDirectory, notify, patchPane, syncBrowsing]
  )

  const openImagePreview = useCallback(
    async (paneId: PaneId, entry: { path: string; name: string }) => {
      const pane = getPane(paneId)
      if (!pane.endpoint) return
      try {
        const img = await requestWorker('preview.readImage', {
          side: pane.endpoint.kind,
          path: entry.path,
          hostId: pane.endpoint.kind === 'remote' ? pane.endpoint.hostId : undefined
        })
        setPreviewState({ paneId, image: img })
      } catch (err) {
        notify(err instanceof Error ? err.message : String(err), true)
      }
    },
    [getPane, notify]
  )

  const openLogTail = useCallback(
    async (paneId: PaneId, entry: { path: string; name: string }) => {
      const pane = getPane(paneId)
      if (!pane.endpoint) return
      if (tailSession) {
        void requestWorker('tail.stop', { tailId: tailSession.tailId }).catch(() => undefined)
      }
      try {
        const res = await requestWorker('tail.start', {
          side: pane.endpoint.kind,
          path: entry.path,
          hostId: pane.endpoint.kind === 'remote' ? pane.endpoint.hostId : undefined,
          lines: 200
        })
        setTailSession({ tailId: res.tailId, side: pane.endpoint.kind, path: entry.path, name: entry.name })
      } catch (err) {
        notify(err instanceof Error ? err.message : String(err), true)
      }
    },
    [getPane, notify, tailSession]
  )

  const closeLogTail = useCallback(() => {
    if (!tailSession) return
    const id = tailSession.tailId
    setTailSession(null)
    void requestWorker('tail.stop', { tailId: id }).catch(() => undefined)
  }, [tailSession])

  const openEditorForEntry = useCallback(
    async (paneId: PaneId, entry: FileEntry, forceText = false) => {
      const pane = getPane(paneId)
      if (!pane.endpoint) return
      try {
        const payload = await requestWorker('editor.read', {
          side: pane.endpoint.kind,
          path: entry.path,
          hostId: pane.endpoint.kind === 'remote' ? pane.endpoint.hostId : undefined,
          forceText
        })
        setEditorState({ paneId, file: payload })
      } catch (err) {
        notify(err instanceof Error ? err.message : String(err), true)
      }
    },
    [getPane, notify]
  )

  const dispatchEnqueue = useCallback(
    async (
      fromPane: PaneId,
      entries: FileEntry[],
      priority: TransferPriority = 'normal',
      renameMap?: Record<string, string>,
      backupBeforeOverwrite = false
    ) => {
      const srcPane = getPane(fromPane)
      const dstPane = getPane(otherPaneId(fromPane))
      const srcEp = srcPane.endpoint
      const dstEp = dstPane.endpoint
      const direction = computeDirection(srcEp, dstEp)

      if (!srcEp || !dstEp || !direction) {
        notify('Selecione ao menos um servidor remoto para transferir arquivos.', true)
        return
      }
      if (!isEndpointConnected(srcEp) || !isEndpointConnected(dstEp)) {
        notify('Conecte os servidores envolvidos antes de transferir arquivos.', true)
        return
      }
      if (!entries.length) return

      const targetDir = dstPane.path || dstPane.homePath || '.'
      const sourceHostId = srcEp.kind === 'remote' ? srcEp.hostId : undefined
      const targetHostId = dstEp.kind === 'remote' ? dstEp.hostId : undefined
      const primaryHostId = targetHostId || sourceHostId

      try {
        const res = await requestWorker('transfers.enqueue', {
          hostId: primaryHostId,
          direction,
          sourceSide: srcEp.kind,
          sourceHostId,
          targetSide: dstEp.kind,
          targetHostId,
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
        if (layout === 'split') {
          setDrawerOpen(true)
        }
        const dirLabel =
          direction === 'remote-to-remote'
            ? `${getEndpointTitle(srcEp)} → ${getEndpointTitle(dstEp)} ⇄`
            : direction === 'upload'
              ? 'Upload ↑'
              : 'Download ↓'
        notify(`${entries.length} item(ns) na fila (${dirLabel})`)
      } catch (err) {
        notify(err instanceof Error ? err.message : String(err), true)
      }
    },
    [computeDirection, getEndpointTitle, getPane, isEndpointConnected, layout, notify]
  )

  const enqueueTransfer = useCallback(
    async (fromPane: PaneId, entries: FileEntry[], priority: TransferPriority = 'normal') => {
      const srcPane = getPane(fromPane)
      const dstPane = getPane(otherPaneId(fromPane))
      const srcEp = srcPane.endpoint
      const dstEp = dstPane.endpoint
      const direction = computeDirection(srcEp, dstEp)

      if (!srcEp || !dstEp || !direction) {
        notify('Selecione ao menos um servidor remoto para transferir arquivos.', true)
        return
      }
      if (!isEndpointConnected(srcEp) || !isEndpointConnected(dstEp)) {
        notify('Conecte os servidores envolvidos antes de transferir arquivos.', true)
        return
      }
      if (!entries.length) return

      const targetDir = dstPane.path || dstPane.homePath || '.'
      const sourceHostId = srcEp.kind === 'remote' ? srcEp.hostId : undefined
      const targetHostId = dstEp.kind === 'remote' ? dstEp.hostId : undefined
      const primaryHostId = targetHostId || sourceHostId

      try {
        const check = await requestWorker('transfers.checkConflicts', {
          hostId: primaryHostId,
          direction,
          sourceSide: srcEp.kind,
          sourceHostId,
          targetSide: dstEp.kind,
          targetHostId,
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
            fromPane,
            direction,
            sourceLabel: getEndpointTitle(srcEp),
            targetLabel: getEndpointTitle(dstEp),
            entries,
            conflicts: check.conflicts,
            priority
          })
          return
        }
        await dispatchEnqueue(fromPane, entries, priority)
      } catch (err) {
        notify(err instanceof Error ? err.message : String(err), true)
      }
    },
    [computeDirection, dispatchEnqueue, getEndpointTitle, getPane, isEndpointConnected, notify]
  )

  const uploadExternalFinderFiles = useCallback(
    async (targetPaneId: PaneId, fileList: FileList) => {
      const targetPane = getPane(targetPaneId)
      if (!targetPane.endpoint || targetPane.endpoint.kind !== 'remote' || !isEndpointConnected(targetPane.endpoint)) {
        notify('Conecte-se a um host remoto antes de arrastar arquivos do Finder.', true)
        return
      }
      const targetHostId = targetPane.endpoint.hostId
      const files = Array.from(fileList)
      if (!files.length) return

      // Path A: Electron exposes native File.path -> use full TransferManager queue + conflict check
      const withNativePaths = files as Array<File & { path?: string }>
      const targetDir = targetPane.path || targetPane.homePath || '.'
      if (withNativePaths.every((f) => typeof f.path === 'string' && f.path.length > 0)) {
        try {
          const res = await requestWorker('transfers.enqueue', {
            hostId: targetHostId,
            direction: 'upload',
            sourceSide: 'local',
            targetSide: 'remote',
            targetHostId,
            priority: 'normal',
            items: withNativePaths.map((f) => ({
              sourcePath: f.path!,
              targetDir,
              isDirectory: false,
              name: f.name,
              backupBeforeOverwrite: true,
              size: f.size
            }))
          })
          setTransfers(res.snapshot)
          if (layout === 'split') setDrawerOpen(true)
          notify(`${withNativePaths.length} arquivo(s) do Finder na fila`)
        } catch (err) {
          notify(err instanceof Error ? err.message : String(err), true)
        }
        return
      }

      // Path B: Isolated sandbox frame -> stream in 256 KB base64 chunks
      const CHUNK = 256 * 1024
      let uploaded = 0
      try {
        for (const file of files) {
          notify(`Enviando do Finder: ${file.name}...`)
          const init = await requestWorker('fs.uploadChunkInit', {
            hostId: targetHostId,
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
        await refreshPane(targetPaneId)
      } catch (err) {
        notify(err instanceof Error ? err.message : String(err), true)
      }
    },
    [getPane, isEndpointConnected, layout, notify, refreshPane]
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
      const localPaneId: PaneId =
        leftPaneRef.current.endpoint?.kind === 'local'
          ? 'left'
          : rightPaneRef.current.endpoint?.kind === 'local'
            ? 'right'
            : 'left'
      patchPane(localPaneId, { endpoint: { kind: 'local' }, homePath: localHomeRef.current })
      await loadPaneDirectory(localPaneId, { kind: 'local' }, workspaceHint.localPath)
      notify(`Local sincronizado com ${workspaceHint.workspaceName || 'workspace'}`)
    }
    if (workspaceHint.hostId) {
      const host = hostsRef.current.find((h) => h.id === workspaceHint.hostId)
      if (host) {
        await connectHostById(host.id, {
          attachToPane: 'right',
          overrideRemotePath: workspaceHint.remotePath || undefined
        })
        return
      }
    }
    if (!workspaceHint.localPath && !workspaceHint.hostId) {
      notify('Nenhum workspace focado na Orca para sincronizar.')
    }
  }

  const handleSaveHost = async (input: SaveHostInput, attachToPane?: PaneId) => {
    const res = await requestWorker('hosts.save', input)
    setHosts(res.hosts)
    hostsRef.current = res.hosts
    if (res.host) {
      await connectHostById(res.host.id, {
        forceReconnect: true,
        attachToPane: attachToPane || 'right'
      })
    }
  }

  const handleDeleteHost = async (hostId: string) => {
    const res = await requestWorker('hosts.delete', { hostId })
    setHosts(res.hosts)
    hostsRef.current = res.hosts
    setHostStates((prev) => {
      const copy = { ...prev }
      delete copy[hostId]
      return copy
    })
    for (const paneId of ['left', 'right'] as PaneId[]) {
      const ep = getPane(paneId).endpoint
      if (ep?.kind === 'remote' && ep.hostId === hostId) {
        patchPane(paneId, { endpoint: paneId === 'left' ? { kind: 'local' } : null, entries: [] })
      }
    }
    notify('Conexão removida')
  }

  const handleToggleBookmark = async (paneId: PaneId) => {
    const pane = getPane(paneId)
    if (!pane.endpoint || !pane.path) return
    const res = await requestWorker('bookmarks.toggle', {
      side: pane.endpoint.kind,
      path: pane.path,
      label: posixBasename(pane.path) || pane.path,
      hostId: pane.endpoint.kind === 'remote' ? pane.endpoint.hostId : undefined
    })
    setBookmarks(res.bookmarks)
  }

  const refreshHostsList = useCallback(() => {
    void requestWorker('hosts.list')
      .then((r) => {
        setHosts(r.hosts)
        hostsRef.current = r.hosts
        setHostStates(r.hostStates)
        hostStatesRef.current = r.hostStates
        notify(`${r.hosts.length} host(s) atualizado(s)`)
      })
      .catch((err) => notify(err instanceof Error ? err.message : String(err), true))
  }, [notify])

  // Real overall SFTP connection status across deduplicated hosts
  const displayHosts = useMemo(() => {
    const inUse = new Set<string>()
    if (leftPane.endpoint?.kind === 'remote') inUse.add(leftPane.endpoint.hostId)
    if (rightPane.endpoint?.kind === 'remote') inUse.add(rightPane.endpoint.hostId)
    return deduplicateHostsForDisplay(hosts, hostStates, inUse)
  }, [hosts, hostStates, leftPane.endpoint, rightPane.endpoint])

  const connectedHostCount = useMemo(
    () => displayHosts.filter((h) => hostStates[h.id]?.state === 'connected').length,
    [displayHosts, hostStates]
  )
  const anyConnecting = useMemo(
    () => displayHosts.some((h) => hostStates[h.id]?.state === 'connecting'),
    [displayHosts, hostStates]
  )
  const overallStatus: HostConnectionState = anyConnecting
    ? 'connecting'
    : connectedHostCount > 0
      ? 'connected'
      : 'disconnected'

  const pendingTransfers = transfers.activeCount + transfers.queuedCount

  // Responsive layout breakpoints
  const canSplit = viewportWidth >= 520
  const effectiveLayout: LayoutMode = layout === 'split' && canSplit ? 'split' : 'tabs'
  const useCompactTabMenu = effectiveLayout === 'tabs' && viewportWidth < 310
  const useShortTabLabel = effectiveLayout === 'tabs' && viewportWidth < 370
  const leftPaneNarrow =
    effectiveLayout === 'split' ? viewportWidth * (splitRatio / 100) < 350 : viewportWidth < 350
  const rightPaneNarrow =
    effectiveLayout === 'split' ? viewportWidth * ((100 - splitRatio) / 100) < 350 : viewportWidth < 350

  const runningSummary = useMemo(() => {
    const running = transfers.items.filter((i) => i.status === 'running')
    if (!running.length) return null
    const total = running.reduce((s, i) => s + i.totalBytes, 0)
    const done = running.reduce((s, i) => s + i.bytesTransferred, 0)
    const pct = total > 0 ? Math.min(100, Math.round((done / total) * 100)) : 0
    const sym =
      running[0].direction === 'remote-to-remote' ? '⇄' : running[0].direction === 'upload' ? '↑' : '↓'
    return {
      pct,
      label:
        running.length === 1
          ? `${sym} ${running[0].name} (${pct}%)`
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

  const leftTitle = getEndpointTitle(leftPane.endpoint)
  const rightTitle = getEndpointTitle(rightPane.endpoint)
  const leftConnected = isEndpointConnected(leftPane.endpoint, hostStates)
  const rightConnected = isEndpointConnected(rightPane.endpoint, hostStates)
  const leftToRightDir = computeDirection(leftPane.endpoint, rightPane.endpoint)
  const rightToLeftDir = computeDirection(rightPane.endpoint, leftPane.endpoint)
  const canTransferLeftToRight = Boolean(leftToRightDir && leftConnected && rightConnected)
  const canTransferRightToLeft = Boolean(rightToLeftDir && leftConnected && rightConnected)

  const contextCallbacks = {
    onClose: () => setContextMenu(null),
    onOpenFolder: (paneId: PaneId, entry: FileEntry) => {
      void navigatePane(paneId, entry.path, { kind: 'enter', name: entry.name })
    },
    onTransfer: (paneId: PaneId, entries: FileEntry[], priority: 'high' | 'normal' = 'normal') => {
      void enqueueTransfer(paneId, entries, priority)
    },
    onEdit: (paneId: PaneId, entry: FileEntry, forceText = false) => {
      void openEditorForEntry(paneId, entry, forceText)
    },
    onPreviewImage: (paneId: PaneId, entry: FileEntry) => {
      void openImagePreview(paneId, entry)
    },
    onTailLog: (paneId: PaneId, entry: FileEntry) => {
      void openLogTail(paneId, entry)
    },
    onCompress: (paneId: PaneId, entries: FileEntry[], format: ArchiveFormat) => {
      const ep = getPane(paneId).endpoint
      if (!ep) return
      setModal({ kind: 'compress', paneId, side: ep.kind, entries, defaultFormat: format })
    },
    onExtract: (paneId: PaneId, entry: FileEntry, createSubfolder: boolean) => {
      const pane = getPane(paneId)
      if (!pane.endpoint) return
      notify(`Descompactando ${entry.name}...`)
      void requestWorker('fs.extract', {
        side: pane.endpoint.kind,
        archivePath: entry.path,
        destinationDir: pane.path,
        createSubfolder,
        hostId: pane.endpoint.kind === 'remote' ? pane.endpoint.hostId : undefined
      })
        .then(async (res) => {
          notify(`Extraído em ${res.extractedTo}`)
          await refreshPane(paneId)
        })
        .catch((err) => notify(err instanceof Error ? err.message : String(err), true))
    },
    onNewFolder: (paneId: PaneId) => {
      const ep = getPane(paneId).endpoint
      if (ep) setModal({ kind: 'mkdir', paneId, side: ep.kind })
    },
    onNewFile: (paneId: PaneId) => {
      const ep = getPane(paneId).endpoint
      if (ep) setModal({ kind: 'newFile', paneId, side: ep.kind })
    },
    onRename: (paneId: PaneId, entry: FileEntry) => {
      const ep = getPane(paneId).endpoint
      if (ep) setModal({ kind: 'rename', paneId, side: ep.kind, entry })
    },
    onChmod: (paneId: PaneId, entry: FileEntry) => {
      const ep = getPane(paneId).endpoint
      if (ep) setModal({ kind: 'chmod', paneId, side: ep.kind, entry })
    },
    onCopyPath: (entry: FileEntry) => {
      void navigator.clipboard?.writeText(entry.path).then(() => notify('Caminho copiado'))
    },
    onDelete: (paneId: PaneId, entries: FileEntry[]) => {
      const ep = getPane(paneId).endpoint
      if (ep) setModal({ kind: 'delete', paneId, side: ep.kind, entries })
    },
    onRefresh: (paneId: PaneId) => void refreshPane(paneId),
    canTransfer: contextMenu
      ? contextMenu.paneId === 'left'
        ? canTransferLeftToRight
        : canTransferRightToLeft
      : false
  }

  const handleOpenSearchResult = useCallback(
    async (paneId: PaneId, res: SearchResultEntry) => {
      if (res.isDirectory) {
        await navigatePane(paneId, res.path)
        return
      }
      await navigatePane(paneId, res.parentDir)
      if (res.isImage) {
        await openImagePreview(paneId, { path: res.path, name: res.name })
      } else if (res.isEditableText) {
        await openEditorForEntry(
          paneId,
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
    [navigatePane, openEditorForEntry, openImagePreview]
  )

  const buildPaneElement = (paneId: PaneId) => {
    const pane = paneId === 'left' ? leftPane : rightPane
    const otherId = otherPaneId(paneId)
    const ep = pane.endpoint
    const side = ep?.kind === 'remote' ? 'remote' : 'local'
    const title = paneId === 'left' ? leftTitle : rightTitle
    const otherTitle = paneId === 'left' ? rightTitle : leftTitle
    const connected = paneId === 'left' ? leftConnected : rightConnected
    const transferDir = paneId === 'left' ? leftToRightDir : rightToLeftDir
    const canTransfer = paneId === 'left' ? canTransferLeftToRight : canTransferRightToLeft
    const narrow = paneId === 'left' ? leftPaneNarrow : rightPaneNarrow
    const hostId = ep?.kind === 'remote' ? ep.hostId : undefined
    const profile = hostId ? hosts.find((h) => h.id === hostId) : undefined

    const transferLabel =
      transferDir === 'remote-to-remote'
        ? `Enviar para ${otherTitle}`
        : transferDir === 'download'
          ? 'Baixar para Local'
          : `Enviar para ${otherTitle}`
    const transferIcon: 'upload' | 'download' | 'arrows-up-down' =
      transferDir === 'remote-to-remote'
        ? 'arrows-up-down'
        : transferDir === 'download'
          ? 'download'
          : 'upload'

    const paneBookmarks =
      side === 'local'
        ? bookmarks.filter((b) => b.side === 'local')
        : bookmarks.filter((b) => b.side === 'remote' && (!b.hostId || b.hostId === hostId))

    return (
      <FilePane
        paneId={paneId}
        side={side}
        endpoint={ep}
        title={title}
        hostState={hostId ? hostStates[hostId] : undefined}
        hosts={hosts}
        hostStates={hostStates}
        otherPaneTitle={otherTitle}
        transferDirection={transferDir}
        path={pane.path}
        homePath={pane.homePath}
        entries={pane.entries}
        loading={pane.loading}
        error={pane.error}
        connected={connected}
        showHidden={pane.showHidden}
        narrow={narrow}
        bookmarks={paneBookmarks}
        selectedPaths={pane.selected}
        onSelectEndpoint={(nextEp) => void selectPaneEndpoint(paneId, nextEp)}
        onOpenConnectionsManager={() => setConnectionsOpen(true)}
        onToggleHidden={() => patchPane(paneId, (prev) => ({ ...prev, showHidden: !prev.showHidden }))}
        onNavigate={(p, rel) => void navigatePane(paneId, p, rel)}
        onRefresh={() => void refreshPane(paneId)}
        onToggleBookmark={() => void handleToggleBookmark(paneId)}
        onSelectChange={(next) => patchPane(paneId, { selected: next })}
        onOpenEntry={(entry) => {
          if (entry.isDirectory) void navigatePane(paneId, entry.path, { kind: 'enter', name: entry.name })
          else if (entry.isImage) void openImagePreview(paneId, entry)
          else if (entry.isEditableText) void openEditorForEntry(paneId, entry, false)
          else if (canTransfer) void enqueueTransfer(paneId, [entry])
        }}
        onContextMenu={(e, entries) =>
          setContextMenu({
            x: e.clientX,
            y: e.clientY,
            paneId,
            transferLabel,
            transferIcon,
            entries
          })
        }
        onTransferSelected={(entries) => void enqueueTransfer(paneId, entries)}
        onDropFromOtherPane={(entries) => void enqueueTransfer(otherId, entries)}
        onDropExternalFiles={
          side === 'remote' ? (files) => void uploadExternalFinderFiles(paneId, files) : undefined
        }
        onRecursiveSearch={(q) =>
          requestWorker('fs.search', {
            side,
            rootPath: pane.path || pane.homePath || '.',
            query: q,
            hostId
          })
        }
        onOpenSearchResult={(res) => void handleOpenSearchResult(paneId, res)}
        canTransfer={canTransfer}
        disconnectedAction={
          profile
            ? {
                label: profile.needsSshBinding
                  ? `Vincular SSH em ${profile.name}`
                  : `Conectar a ${profile.name}`,
                hint: profile.needsSshBinding
                  ? `Servidor Orca Remoto encontrado via VPN (${profile.hostname || 'endpoint'}). Configure o vínculo SSH uma vez para navegar via SFTP.`
                  : `Pronto para abrir ponte SFTP em ${profile.name} (${profile.sourceLabel}).`,
                onClick: () => void connectHostById(profile.id, { attachToPane: paneId }),
                secondaryLabel: 'Gerenciar hosts',
                onSecondaryClick: () => setConnectionsOpen(true)
              }
            : {
                label: 'Gerenciar conexões',
                hint: 'Escolha um servidor no título acima ou configure uma nova conexão SSH/SFTP.',
                onClick: () => setConnectionsOpen(true),
                secondaryLabel: 'Nova conexão',
                onSecondaryClick: () => setModal({ kind: 'host', attachToPane: paneId })
              }
        }
      />
    )
  }

  const leftPaneEl = buildPaneElement('left')
  const rightPaneEl = buildPaneElement('right')

  const leftTabLabel = leftPane.endpoint?.kind === 'remote' ? leftTitle : 'Local'
  const rightTabLabel = rightPane.endpoint?.kind === 'remote' ? rightTitle : rightPane.endpoint?.kind === 'local' ? 'Local' : 'Remoto'
  const activeTabLabel =
    activeTab === 'local' ? leftTabLabel : activeTab === 'remote' ? rightTabLabel : 'Transferências'

  const leftRemoteState: HostConnectionState | null =
    leftPane.endpoint?.kind === 'remote'
      ? hostStates[leftPane.endpoint.hostId]?.state || 'disconnected'
      : null
  const rightRemoteState: HostConnectionState | null =
    rightPane.endpoint?.kind === 'remote'
      ? hostStates[rightPane.endpoint.hostId]?.state || 'disconnected'
      : null

  return (
    <div class="app">
      {/* Permanently Fixed Single-Row Top Header */}
      <div class="header">
        <div class="header-top">
          <div class="header-title-group">
            <span
              class={`status-dot ${dotClassForState(overallStatus)}`}
              title={
                overallStatus === 'connected'
                  ? `${connectedHostCount} sessão(ões) SFTP conectada(s)`
                  : overallStatus === 'connecting'
                    ? 'Conectando / reconectando sessão SFTP...'
                    : 'Nenhuma sessão SFTP conectada'
              }
            />
            <span class="header-title">{viewportWidth < 290 ? 'SFTP' : 'SFTP Bridge'}</span>
            {viewportWidth >= 430 && (
              <button
                class={`header-conn-pill ${connectionsOpen ? 'active' : ''}`}
                title="Abrir / fechar Gerenciador de Conexões e Hosts SFTP"
                onClick={() => {
                  setHubOpen(false)
                  setConnectionsOpen((v) => !v)
                }}
              >
                {overallStatus === 'connecting'
                  ? 'Conectando...'
                  : connectedHostCount > 0
                    ? `${connectedHostCount} online`
                    : 'Offline'}
              </button>
            )}
          </div>

          <div class="header-actions">
            {effectiveLayout === 'split' && (
              <>
                <button
                  class={`icon-btn ${syncBrowsing ? 'icon-btn-accent' : ''}`}
                  title={
                    syncBrowsing
                      ? `Navegação Sincronizada ATIVA (${leftTitle} ⇄ ${rightTitle})`
                      : `Ativar Navegação Sincronizada (${leftTitle} ⇄ ${rightTitle})`
                  }
                  onClick={toggleSyncBrowsing}
                >
                  <Icon name="link" size={14} />
                </button>
                <button
                  class={`icon-btn ${drawerOpen ? 'active' : ''}`}
                  title="Abrir / fechar fila de transferências"
                  onClick={() => {
                    setConnectionsOpen(false)
                    setDrawerOpen((v) => !v)
                  }}
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
              onClick={() => {
                setConnectionsOpen(false)
                void handleSyncWorkspace()
              }}
            >
              <Icon name="crosshair" size={14} />
            </button>
            <button
              class={`icon-btn ${connectionsOpen ? 'icon-btn-accent' : ''}`}
              title="Conexões e Hosts SFTP (abrir / fechar)"
              onClick={() => {
                setHubOpen(false)
                setConnectionsOpen((v) => !v)
              }}
            >
              <Icon name="server" size={14} />
            </button>
            <button
              class={`icon-btn ${hubOpen ? 'icon-btn-accent' : ''}`}
              title="Central SFTP (abrir / fechar)"
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
                    ? 'Alternar para modo Dividido (lado a lado)'
                    : 'Alternar para modo Abas (compacto)'
              }
              onClick={() => {
                setConnectionsOpen(false)
                toggleLayout()
              }}
            >
              <Icon name={effectiveLayout === 'tabs' ? 'split' : 'tabs'} size={14} />
            </button>
          </div>
        </div>
      </div>

      {/* Main Content Area below fixed header (overlays live inside here so header never disappears!) */}
      <div class="app-content">

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
                  {activeTab === 'local' && leftRemoteState ? (
                    <span class={`status-dot sm ${dotClassForState(leftRemoteState)}`} />
                  ) : activeTab === 'remote' && rightRemoteState ? (
                    <span class={`status-dot sm ${dotClassForState(rightRemoteState)}`} />
                  ) : (
                    <Icon
                      name={activeTab === 'local' ? 'folder' : activeTab === 'remote' ? 'server' : 'arrows-up-down'}
                      size={13}
                    />
                  )}
                  <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {activeTabLabel}
                  </span>
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
                      {leftRemoteState ? (
                        <span class={`status-dot sm ${dotClassForState(leftRemoteState)}`} />
                      ) : (
                        <Icon name="folder" size={13} />
                      )}
                      <span>{leftTabLabel}</span>
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
                      {rightRemoteState ? (
                        <span class={`status-dot sm ${dotClassForState(rightRemoteState)}`} />
                      ) : (
                        <Icon name="server" size={13} />
                      )}
                      <span>{rightTabLabel}</span>
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
                      <Icon name="arrows-up-down" size={13} /> Transferências
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
                title={leftTabLabel}
              >
                {leftRemoteState && <span class={`status-dot sm ${dotClassForState(leftRemoteState)}`} />}
                <span>{leftTabLabel}</span>
              </button>
              <button
                role="tab"
                aria-selected={activeTab === 'remote'}
                class={`seg-tab ${activeTab === 'remote' ? 'active' : ''}`}
                onClick={() => selectTab('remote')}
                title={rightTabLabel}
              >
                {rightRemoteState && <span class={`status-dot sm ${dotClassForState(rightRemoteState)}`} />}
                <span>{rightTabLabel}</span>
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
            {activeTab === 'local' && leftPaneEl}
            {activeTab === 'remote' && rightPaneEl}
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

      {/* Mode 2: Split Layout (active when >= 520px and Split chosen) */}
      {effectiveLayout === 'split' && (
        <div class="workspace-body">
          <div ref={splitContainerRef} class="split-container">
            <div class="split-pane" style={{ width: `${splitRatio}%` }}>
              {leftPaneEl}
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
              {rightPaneEl}
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

      {/* Full-Panel Connections Manager Overlay */}
      {connectionsOpen && (
        <ConnectionsManager
          hosts={hosts}
          hostStates={hostStates}
          leftEndpoint={leftPane.endpoint || { kind: 'local' }}
          rightEndpoint={rightPane.endpoint}
          onClose={() => setConnectionsOpen(false)}
          onConnect={(id, force) => connectHostById(id, { forceReconnect: force })}
          onDisconnect={disconnectHostById}
          onAssignToPane={selectPaneEndpoint}
          onEditHost={(profile) => setModal({ kind: 'host', initial: profile })}
          onRefreshHosts={refreshHostsList}
        />
      )}

      {/* Shared Full-Panel Overlays: QuickEditor, ImagePreview, LogTailViewer */}
      {editorState && (
        <QuickEditor
          file={editorState.file}
          onSave={async (nextContent) => {
            const { file, paneId } = editorState
            const res = await requestWorker('editor.write', {
              side: file.side,
              path: file.path,
              content: nextContent,
              hostId: file.hostId
            })
            setEditorState((prev) =>
              prev
                ? {
                    ...prev,
                    file: { ...prev.file, content: nextContent, mtimeMs: res.mtimeMs, size: res.size }
                  }
                : null
            )
            notify(`Salvo: ${file.name}`)
            void refreshPane(paneId)
          }}
          onReload={async () => {
            const { file, paneId } = editorState
            const fresh = await requestWorker('editor.read', {
              side: file.side,
              path: file.path,
              hostId: file.hostId,
              forceText: true
            })
            setEditorState({ paneId, file: fresh })
            notify('Arquivo recarregado')
          }}
          onClose={() => setEditorState(null)}
        />
      )}

      {previewState && (
        <ImagePreview
          image={previewState.image}
          canTransfer={previewState.paneId === 'left' ? canTransferLeftToRight : canTransferRightToLeft}
          onTransfer={() => {
            const { image, paneId } = previewState
            void enqueueTransfer(paneId, [
              {
                name: image.name,
                path: image.path,
                isDirectory: false,
                isSymlink: false,
                size: image.size,
                mtimeMs: Date.now(),
                mode: 0o100644,
                permissions: '',
                isHidden: image.name.startsWith('.'),
                isArchive: false,
                archiveType: null,
                isEditableText: false,
                isImage: true
              }
            ])
          }}
          onClose={() => setPreviewState(null)}
        />
      )}

      {tailSession && <LogTailViewer session={tailSession} onStop={closeLogTail} />}
      </div>

      {/* Floating Quick Hub Popover (triggered by Status Bar item or ⚡ button) */}
      {hubOpen && (
        <QuickHubPopover
          hosts={hosts}
          hostStates={hostStates}
          leftEndpoint={leftPane.endpoint || { kind: 'local' }}
          rightEndpoint={rightPane.endpoint}
          transfers={transfers}
          syncBrowsing={syncBrowsing}
          layout={effectiveLayout}
          canSplit={canSplit}
          onClose={() => setHubOpen(false)}
          onConnectHost={(id, force) => void connectHostById(id, { forceReconnect: force })}
          onDisconnectHost={(id) => void disconnectHostById(id)}
          onOpenConnectionsManager={() => setConnectionsOpen(true)}
          onToggleSync={toggleSyncBrowsing}
          onSyncWorkspace={() => void handleSyncWorkspace()}
          onToggleLayout={toggleLayout}
          onRefreshHosts={refreshHostsList}
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
          onSave={(input) => handleSaveHost(input, modal.attachToPane)}
          onDelete={handleDeleteHost}
          onClose={() => setModal(null)}
        />
      )}

      {modal?.kind === 'mkdir' && (
        <PromptModal
          title={`Nova pasta (${getEndpointTitle(getPane(modal.paneId).endpoint)})`}
          label="Nome da pasta"
          placeholder="minha-pasta"
          confirmLabel="Criar pasta"
          onConfirm={async (name) => {
            const pane = getPane(modal.paneId)
            if (!pane.endpoint) return
            await requestWorker('fs.mkdir', {
              side: pane.endpoint.kind,
              parentPath: pane.path,
              name,
              hostId: pane.endpoint.kind === 'remote' ? pane.endpoint.hostId : undefined
            })
            notify(`Pasta "${name}" criada`)
            await refreshPane(modal.paneId)
          }}
          onClose={() => setModal(null)}
        />
      )}

      {modal?.kind === 'newFile' && (
        <PromptModal
          title={`Novo arquivo (${getEndpointTitle(getPane(modal.paneId).endpoint)})`}
          label="Nome do arquivo"
          placeholder="notas.md"
          confirmLabel="Criar e abrir"
          onConfirm={async (name) => {
            const pane = getPane(modal.paneId)
            if (!pane.endpoint) return
            const hostId = pane.endpoint.kind === 'remote' ? pane.endpoint.hostId : undefined
            const res = await requestWorker('fs.createFile', {
              side: pane.endpoint.kind,
              parentPath: pane.path,
              name,
              content: '',
              hostId
            })
            notify(`Arquivo "${name}" criado`)
            await refreshPane(modal.paneId)
            setEditorState({
              paneId: modal.paneId,
              file: {
                side: pane.endpoint.kind,
                hostId,
                path: res.createdPath,
                name,
                content: '',
                size: 0,
                mtimeMs: Date.now(),
                encoding: 'utf-8'
              }
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
            const pane = getPane(modal.paneId)
            if (!pane.endpoint) return
            await requestWorker('fs.rename', {
              side: pane.endpoint.kind,
              oldPath: modal.entry.path,
              newName,
              hostId: pane.endpoint.kind === 'remote' ? pane.endpoint.hostId : undefined
            })
            notify(`Renomeado para "${newName}"`)
            await refreshPane(modal.paneId)
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
            const pane = getPane(modal.paneId)
            if (!pane.endpoint) return
            await requestWorker('fs.chmod', {
              side: pane.endpoint.kind,
              path: modal.entry.path,
              mode,
              hostId: pane.endpoint.kind === 'remote' ? pane.endpoint.hostId : undefined
            })
            notify(`Permissões alteradas para ${mode}`)
            await refreshPane(modal.paneId)
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
            const pane = getPane(modal.paneId)
            if (!pane.endpoint) return
            const res = await requestWorker('fs.compress', {
              side: pane.endpoint.kind,
              cwd: pane.path,
              names: modal.entries.map((e) => e.name),
              archiveName,
              format,
              hostId: pane.endpoint.kind === 'remote' ? pane.endpoint.hostId : undefined
            })
            notify(`Compactado: ${posixBasename(res.archivePath)}`)
            await refreshPane(modal.paneId)
          }}
          onClose={() => setModal(null)}
        />
      )}

      {modal?.kind === 'delete' && (
        <ConfirmDeleteModal
          side={modal.side}
          entries={modal.entries}
          onConfirm={async () => {
            const pane = getPane(modal.paneId)
            if (!pane.endpoint) return
            const res = await requestWorker('fs.delete', {
              side: pane.endpoint.kind,
              paths: modal.entries.map((e) => e.path),
              hostId: pane.endpoint.kind === 'remote' ? pane.endpoint.hostId : undefined
            })
            notify(`${res.deletedCount} item(ns) excluído(s)`)
            await refreshPane(modal.paneId)
          }}
          onClose={() => setModal(null)}
        />
      )}

      {modal?.kind === 'conflict' && (
        <ConflictModal
          direction={modal.direction}
          sourceLabel={modal.sourceLabel}
          targetLabel={modal.targetLabel}
          totalCount={modal.entries.length}
          conflicts={modal.conflicts}
          onRequestDiff={(conflict) => {
            const srcEp = getPane(modal.fromPane).endpoint
            const dstEp = getPane(otherPaneId(modal.fromPane)).endpoint
            const sourceHostId = srcEp?.kind === 'remote' ? srcEp.hostId : undefined
            const targetHostId = dstEp?.kind === 'remote' ? dstEp.hostId : undefined
            return requestWorker('transfers.diffConflict', {
              hostId: targetHostId || sourceHostId || connection.hostId || undefined,
              direction: modal.direction,
              sourceSide: srcEp?.kind,
              sourceHostId,
              targetSide: dstEp?.kind,
              targetHostId,
              sourcePath: conflict.sourcePath,
              targetPath: conflict.targetPath
            })
          }}
          onOverwrite={async (backupBeforeOverwrite) => {
            await dispatchEnqueue(
              modal.fromPane,
              modal.entries,
              modal.priority,
              undefined,
              backupBeforeOverwrite
            )
          }}
          onRename={async (customNames) => {
            await dispatchEnqueue(modal.fromPane, modal.entries, modal.priority, customNames, false)
          }}
          onSkip={async () => {
            const conflictSet = new Set(modal.conflicts.map((c) => c.sourcePath))
            const nonConflicting = modal.entries.filter((e) => !conflictSet.has(e.path))
            if (nonConflicting.length > 0) {
              await dispatchEnqueue(modal.fromPane, nonConflicting, modal.priority)
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
