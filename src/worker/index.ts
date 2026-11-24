import { readdir, stat } from 'node:fs/promises'
import { join } from 'node:path'
import type { OrcaWorkerApi } from 'orca/worker'
import '../protocol.ts'
import { computeLineDiff } from '../shared/diff.ts'
import {
  getImageMimeType,
  looksBinary,
  posixBasename,
  posixJoin,
  suggestNonConflictingName
} from '../shared/file-utils.ts'
import type {
  BookmarkEntry,
  ConnectionStatus,
  HostProfile,
  HostSftpState,
  PersistedSessionState,
  PluginUserSettings,
  Side,
  TransferConflict,
  TransferSnapshot,
  WorkspaceHint
} from '../shared/types.ts'
import {
  buildStoredBindingFromInput,
  discoverAllHosts,
  type StoredHostBinding
} from './host-discovery.ts'
import {
  chmodLocal,
  compressLocal,
  createFileLocal,
  deleteLocal,
  extractLocal,
  getLocalHome,
  listLocalDir,
  mkdirLocal,
  readLocalBytes,
  readLocalImage,
  readLocalText,
  renameLocal,
  searchLocalRecursive,
  startLocalTail,
  writeLocalText
} from './local-fs.ts'
import { type RemoteTransport, SFTP_OPEN_FLAGS, SshSftpTransport } from './ssh-sftp-client.ts'
import { TransferManager } from './transfer-manager.ts'
import type { TailHandle } from './transport-types.ts'

const STORAGE_HOSTS_KEY = 'sftp.savedHosts.v1'
const STORAGE_BOOKMARKS_KEY = 'sftp.bookmarks.v1'
const STORAGE_SESSION_KEY = 'sftp.session.v1'
const SECRET_PREFIX = 'host-secret:'

const DEFAULT_SESSION: PersistedSessionState = {
  lastHostId: null,
  wasConnected: false,
  lastLocalPath: null,
  remotePathsByHost: {},
  activeTab: 'local'
}

const DEFAULT_SETTINGS: PluginUserSettings = {
  defaultLayout: 'tabs',
  maxConcurrentTransfers: 2,
  showHiddenFiles: true,
  defaultArchiveFormat: 'zip',
  notifyOnQueueComplete: true,
  maxEditableFileKB: 1024
}

let activeTransportsRef: Map<string, RemoteTransport> | null = null
let activeManager: TransferManager | null = null
let activeHostPollTimer: ReturnType<typeof setInterval> | null = null
const activeTails = new Map<string, { stop: () => void }>()

export default function activate(orca: OrcaWorkerApi): void {
  const transports = new Map<string, RemoteTransport>()
  activeTransportsRef = transports
  const hostStates = new Map<string, HostSftpState>()
  const manuallyDisconnected = new Set<string>()
  const activeChunkUploads = new Map<
    string,
    {
      transport: RemoteTransport
      handle: Buffer
      tempPath: string
      targetPath: string
      backupBeforeOverwrite: boolean
    }
  >()
  let cachedHosts: HostProfile[] = []
  let connectionStatus: ConnectionStatus = {
    hostId: null,
    hostName: null,
    connected: false,
    connecting: false
  }
  let currentSettings: PluginUserSettings = { ...DEFAULT_SETTINGS }

  function getHostStatesSnapshot(): Record<string, HostSftpState> {
    const out: Record<string, HostSftpState> = {}
    for (const [id, st] of hostStates) {
      if (st.state === 'connected') {
        const t = transports.get(id)
        // If synced from Orca (source === 'orca'), transport opens seamlessly on demand.
        // Only mark dropped if an opened SFTP transport died or a manual SFTP session lost its transport.
        if (t && !t.isAlive) {
          const dropped: HostSftpState = {
            hostId: id,
            hostName: st.hostName,
            state: 'disconnected'
          }
          hostStates.set(id, dropped)
          out[id] = dropped
          continue
        }
        if (!t && st.source !== 'orca') {
          const dropped: HostSftpState = {
            hostId: id,
            hostName: st.hostName,
            state: 'disconnected'
          }
          hostStates.set(id, dropped)
          out[id] = dropped
          continue
        }
      }
      out[id] = { ...st }
    }
    return out
  }

  function syncOrcaHostStates(hosts: HostProfile[]): boolean {
    let changed = false
    const seenIds = new Set<string>()

    for (const profile of hosts) {
      seenIds.add(profile.id)
      const cur = hostStates.get(profile.id)

      if (profile.orcaStatus === 'connecting') {
        if (cur?.state !== 'connecting') {
          hostStates.set(profile.id, {
            hostId: profile.id,
            hostName: profile.name,
            state: 'connecting',
            source: 'orca'
          })
          changed = true
        }
      } else if (
        profile.orcaStatus === 'connected' &&
        !profile.needsSshBinding &&
        !manuallyDisconnected.has(profile.id)
      ) {
        // Already connected in Orca -> automatically available & connected in SFTP Bridge!
        if (!cur || cur.state === 'disconnected' || (cur.state === 'connecting' && cur.source === 'orca')) {
          hostStates.set(profile.id, {
            hostId: profile.id,
            hostName: profile.name,
            state: 'connected',
            source: 'orca',
            remoteHome: cur?.remoteHome
          })
          changed = true
        }
      } else if (
        (profile.kind === 'orca-env' || profile.kind === 'orca-ssh') &&
        profile.orcaStatus === 'disconnected'
      ) {
        // Disconnected in Orca -> mirror disconnected if it was Orca-synced (not manually forced)
        if (cur && cur.source === 'orca' && cur.state !== 'disconnected') {
          const t = transports.get(profile.id)
          if (t) {
            t.destroy()
            transports.delete(profile.id)
          }
          hostStates.set(profile.id, {
            hostId: profile.id,
            hostName: profile.name,
            state: 'disconnected',
            source: 'orca'
          })
          changed = true
        }
      }
    }

    // Remove state entries for Orca hosts that were deleted in Orca settings
    for (const [id, st] of [...hostStates.entries()]) {
      if (!seenIds.has(id) && st.source === 'orca') {
        const t = transports.get(id)
        if (t) {
          t.destroy()
          transports.delete(id)
        }
        hostStates.delete(id)
        changed = true
      }
    }

    return changed
  }

  function setHostState(next: HostSftpState): void {
    hostStates.set(next.hostId, next)
    post('hostStates.updated', getHostStatesSnapshot())
  }

  function refreshLegacyConnectionStatus(): void {
    const connected = Object.values(getHostStatesSnapshot()).filter((s) => s.state === 'connected')
    if (connected.length > 0) {
      const current =
        connected.find((c) => c.hostId === connectionStatus.hostId) || connected[connected.length - 1]
      connectionStatus = {
        hostId: current.hostId,
        hostName: current.hostName,
        connected: true,
        connecting: false,
        transportMode: current.transportMode,
        remoteHome: current.remoteHome
      }
    } else {
      connectionStatus = {
        hostId: null,
        hostName: null,
        connected: false,
        connecting: false
      }
    }
  }

  async function loadSettings(): Promise<PluginUserSettings> {
    try {
      const raw = await orca.settings.get()
      currentSettings = {
        defaultLayout: raw.defaultLayout === 'split' ? 'split' : 'tabs',
        maxConcurrentTransfers:
          typeof raw.maxConcurrentTransfers === 'number' ? raw.maxConcurrentTransfers : 2,
        showHiddenFiles: typeof raw.showHiddenFiles === 'boolean' ? raw.showHiddenFiles : true,
        defaultArchiveFormat: raw.defaultArchiveFormat === 'tar.gz' ? 'tar.gz' : 'zip',
        notifyOnQueueComplete:
          typeof raw.notifyOnQueueComplete === 'boolean' ? raw.notifyOnQueueComplete : true,
        maxEditableFileKB:
          typeof raw.maxEditableFileKB === 'number' ? raw.maxEditableFileKB : 1024
      }
    } catch {
      currentSettings = { ...DEFAULT_SETTINGS }
    }
    return currentSettings
  }

  async function loadSavedBindings(): Promise<StoredHostBinding[]> {
    const raw = await orca.storage.get(STORAGE_HOSTS_KEY)
    return Array.isArray(raw) ? (raw as unknown as StoredHostBinding[]) : []
  }

  function toJson<T>(value: T): T {
    return (value === undefined ? null : JSON.parse(JSON.stringify(value))) as T
  }

  function handle<K extends keyof import('orca').PluginRequests>(
    name: K,
    fn: (
      input: import('orca').PluginRequestInput<K>
    ) =>
      | import('orca').PluginRequestOutput<K>
      | Promise<import('orca').PluginRequestOutput<K>>
  ): void {
    orca.panels.handle(name, async (input) => toJson(await fn(input)))
  }

  function post<K extends keyof import('orca').PluginPanelEvents>(
    event: K,
    payload: import('orca').PluginPanelEvents[K]
  ): void {
    orca.panels.post(event, toJson(payload))
  }

  async function saveBindings(list: StoredHostBinding[]): Promise<void> {
    await orca.storage.set(STORAGE_HOSTS_KEY, toJson(list) as unknown as import('orca/worker').JsonValue)
  }

  async function loadBookmarks(): Promise<BookmarkEntry[]> {
    const raw = await orca.storage.get(STORAGE_BOOKMARKS_KEY)
    return Array.isArray(raw) ? (raw as unknown as BookmarkEntry[]) : []
  }

  async function saveBookmarks(list: BookmarkEntry[]): Promise<void> {
    await orca.storage.set(STORAGE_BOOKMARKS_KEY, toJson(list) as unknown as import('orca/worker').JsonValue)
  }

  let cachedSession: PersistedSessionState | null = null

  async function loadSession(): Promise<PersistedSessionState> {
    if (cachedSession) return cachedSession
    try {
      const raw = (await orca.storage.get(STORAGE_SESSION_KEY)) as Partial<PersistedSessionState> | null
      cachedSession = {
        lastHostId: typeof raw?.lastHostId === 'string' ? raw.lastHostId : null,
        wasConnected: Boolean(raw?.wasConnected),
        lastLocalPath: typeof raw?.lastLocalPath === 'string' ? raw.lastLocalPath : null,
        remotePathsByHost:
          raw?.remotePathsByHost && typeof raw.remotePathsByHost === 'object'
            ? { ...raw.remotePathsByHost }
            : {},
        activeTab:
          raw?.activeTab === 'remote' || raw?.activeTab === 'transfers' ? raw.activeTab : 'local',
        layout: raw?.layout === 'split' || raw?.layout === 'tabs' ? raw.layout : undefined,
        splitRatio: typeof raw?.splitRatio === 'number' ? raw.splitRatio : undefined,
        syncBrowsing: Boolean(raw?.syncBrowsing),
        leftEndpoint:
          raw?.leftEndpoint && (raw.leftEndpoint.kind === 'local' || raw.leftEndpoint.kind === 'remote')
            ? raw.leftEndpoint
            : { kind: 'local' },
        rightEndpoint:
          raw?.rightEndpoint && (raw.rightEndpoint.kind === 'local' || raw.rightEndpoint.kind === 'remote')
            ? raw.rightEndpoint
            : undefined
      }
    } catch {
      cachedSession = { ...DEFAULT_SESSION, remotePathsByHost: {} }
    }
    return cachedSession
  }

  async function patchSession(patch: Partial<PersistedSessionState>): Promise<PersistedSessionState> {
    const cur = await loadSession()
    const next: PersistedSessionState = {
      ...cur,
      ...patch,
      remotePathsByHost: {
        ...cur.remotePathsByHost,
        ...(patch.remotePathsByHost || {})
      }
    }
    cachedSession = next
    await orca.storage.set(STORAGE_SESSION_KEY, toJson(next) as unknown as import('orca/worker').JsonValue)
    return next
  }

  async function refreshHosts(): Promise<HostProfile[]> {
    const bindings = await loadSavedBindings()
    cachedHosts = await discoverAllHosts(bindings)
    syncOrcaHostStates(cachedHosts)
    return cachedHosts
  }

  async function getHostProfile(hostId: string): Promise<HostProfile> {
    if (!cachedHosts.length) await refreshHosts()
    const found = cachedHosts.find((h) => h.id === hostId)
    if (!found) throw new Error(`Host não encontrado: ${hostId}`)
    return found
  }

  function updateStatusBar(snapshot: TransferSnapshot): void {
    const activeTotal = snapshot.activeCount + snapshot.queuedCount
    const allStates = getHostStatesSnapshot()
    const connectedHosts = Object.values(allStates).filter((s) => s.state === 'connected')
    const connectingHosts = Object.values(allStates).filter((s) => s.state === 'connecting')

    // Derive active pane endpoints so the footer accurately reflects Local × Remote vs Remote A ⇄ Remote B
    const leftEp = cachedSession?.leftEndpoint || { kind: 'local' as const }
    const rightEp = cachedSession?.rightEndpoint
    const leftRemote =
      leftEp.kind === 'remote' && allStates[leftEp.hostId]?.state === 'connected'
        ? allStates[leftEp.hostId]
        : null
    const rightRemote =
      rightEp?.kind === 'remote' && allStates[rightEp.hostId]?.state === 'connected'
        ? allStates[rightEp.hostId]
        : null

    let text = 'SFTP'
    let tone: 'neutral' | 'accent' | 'success' | 'warning' | 'danger' = 'neutral'
    let tooltip = 'SFTP Bridge'

    if (activeTotal > 0) {
      const running = snapshot.items.filter((i) => i.status === 'running')
      const totalBytes = running.reduce((s, i) => s + i.totalBytes, 0)
      const doneBytes = running.reduce((s, i) => s + i.bytesTransferred, 0)
      const pct = totalBytes > 0 ? Math.round((doneBytes / totalBytes) * 100) : 0
      text = `SFTP · ${activeTotal} (${pct}%)`
      tone = 'accent'
      tooltip = `Transferências ativas: ${snapshot.activeCount} rodando, ${snapshot.queuedCount} na fila`
    } else if (snapshot.errorCount > 0) {
      text = `SFTP · ${snapshot.errorCount} erro(s)`
      tone = 'danger'
      tooltip = 'Existem transferências com erro no SFTP Bridge'
    } else if (snapshot.pausedCount > 0) {
      text = `SFTP · ${snapshot.pausedCount} pausada(s)`
      tone = 'warning'
      tooltip = 'Transferências pausadas no SFTP Bridge'
    } else if (leftRemote && rightRemote && leftRemote.hostId !== rightRemote.hostId) {
      text = `SFTP · ${leftRemote.hostName} ⇄ ${rightRemote.hostName}`
      tone = 'success'
      tooltip = `Remoto ⇄ Remoto ativo: ${leftRemote.hostName} e ${rightRemote.hostName}`
    } else if (rightRemote || leftRemote) {
      const active = (rightRemote || leftRemote)!
      text = `SFTP · ${active.hostName}`
      tone = 'success'
      tooltip = `Conectado em ${active.hostName} (${connectedHosts.length} host(s) online)`
    } else if (connectingHosts.length > 0) {
      text = `SFTP · conectando...`
      tone = 'warning'
      tooltip = `Conectando a ${connectingHosts.map((h) => h.hostName).join(', ')}`
    } else if (connectedHosts.length > 0) {
      text = `SFTP · ${connectedHosts.length} online`
      tone = 'success'
      tooltip = `${connectedHosts.length} host(s) pronto(s): ${connectedHosts.map((h) => h.hostName).join(', ')}`
    }

    void orca.host
      .call('statusBar.update', { id: 'sftp-status', text, tone, tooltip, visible: true })
      .catch(() => undefined)
  }

  async function getOrConnectTransport(hostId: string, forceReconnect = false): Promise<RemoteTransport> {
    if (forceReconnect) {
      const old = transports.get(hostId)
      if (old) {
        old.destroy()
        transports.delete(hostId)
      }
    } else {
      const existing = transports.get(hostId)
      if (existing && existing.isAlive) return existing
    }

    const profile = await getHostProfile(hostId)
    if (profile.needsSshBinding) {
      const err = new Error(
        `O Servidor Orca Remoto "${profile.name}" precisa vincular usuário/SSH uma vez antes de abrir SFTP.`
      ) as Error & { code?: string }
      err.code = 'invalid_params'
      throw err
    }

    const secret = profile.hasSecret
      ? await orca.secrets.get(`${SECRET_PREFIX}${profile.id}`).catch(() => null)
      : null

    const transport = await SshSftpTransport.connect(profile, secret)
    transports.set(hostId, transport)
    return transport
  }

  async function resolveActiveTransport(hostId?: string): Promise<RemoteTransport> {
    const id = hostId || connectionStatus.hostId
    if (!id) throw new Error('Nenhum host remoto conectado. Selecione um host para abrir a ponte SFTP.')
    const transport = transports.get(id)
    if (transport && transport.isAlive) return transport

    // Seamless on-demand SFTP open for Orca-connected hosts
    const state = hostStates.get(id)
    if (state?.state === 'connected' && state.source === 'orca') {
      try {
        const opened = await getOrConnectTransport(id, false)
        const homePath = await opened.realpath('.').catch(() => '.')
        setHostState({
          hostId: id,
          hostName: state.hostName,
          state: 'connected',
          source: 'orca',
          transportMode: opened.mode,
          remoteHome: homePath
        })
        refreshLegacyConnectionStatus()
        updateStatusBar(transferManager.getSnapshot())
        return opened
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        setHostState({
          hostId: id,
          hostName: state.hostName,
          state: 'error',
          error: message
        })
        throw err
      }
    }

    if (state && state.state === 'connected') {
      setHostState({ hostId: id, hostName: state.hostName, state: 'disconnected' })
    }
    throw new Error('Sessão SFTP desconectada. Clique em reconectar para continuar.')
  }

  async function computeWorkspaceHint(): Promise<WorkspaceHint> {
    try {
      const [ctx, wsList] = await Promise.all([
        orca.host.call('workspace.readContext', {}).catch(() => null),
        orca.host.call('workspace.list', {}).catch(() => null)
      ])
      if (!ctx?.workspaceId || !wsList?.workspaces) {
        return { localPath: null, remotePath: null, hostId: null, workspaceName: ctx?.displayName || null }
      }
      const ws = wsList.workspaces.find((w) => w.id === ctx.workspaceId)
      if (!ws) {
        return { localPath: null, remotePath: null, hostId: null, workspaceName: ctx.displayName }
      }
      if (!ws.hostId || ws.hostId === 'local') {
        return {
          localPath: ws.path,
          remotePath: null,
          hostId: null,
          workspaceName: ws.name
        }
      }
      // Remote workspace: match hostId (`ssh:<id>` or `runtime:<id>`)
      let matchedHostId: string | null = null
      if (ws.hostId.startsWith('ssh:')) {
        matchedHostId = `orca-ssh:${ws.hostId.slice(4)}`
      } else if (ws.hostId.startsWith('runtime:')) {
        matchedHostId = `orca-env:${ws.hostId.slice(8)}`
      }
      return {
        localPath: null,
        remotePath: ws.path,
        hostId: matchedHostId,
        workspaceName: ws.name
      }
    } catch {
      return { localPath: null, remotePath: null, hostId: null, workspaceName: null }
    }
  }

  const transferManager = new TransferManager(
    {
      getTransport: getOrConnectTransport,
      onSnapshot: (snapshot) => {
        post('transfers.updated', snapshot)
        updateStatusBar(snapshot)
      },
      onQueueSettled: ({ completed, failed }) => {
        if (!currentSettings.notifyOnQueueComplete) return
        const title = failed > 0 ? 'SFTP Bridge — Transferências com erro' : 'SFTP Bridge — Concluído'
        const body =
          failed > 0
            ? `${completed} concluída(s), ${failed} com erro.`
            : `${completed} transferência(s) finalizada(s) com sucesso.`
        void orca.host.call('notifications.show', { title, body }).catch(() => undefined)
      }
    },
    currentSettings.maxConcurrentTransfers
  )
  activeManager = transferManager

  // Live settings sync
  void loadSettings().then((s) => transferManager.setMaxConcurrent(s.maxConcurrentTransfers))
  orca.settings.onDidChange(() => {
    void loadSettings().then((s) => transferManager.setMaxConcurrent(s.maxConcurrentTransfers))
  })

  // Live workspace sync
  orca.events.on('workspace.changed', async () => {
    const hint = await computeWorkspaceHint()
    post('workspace.hint', hint)
  })

  // === Panel RPC Handlers ===

  handle('app.bootstrap', async () => {
    const [settings, hosts, bookmarks, workspaceHint, session] = await Promise.all([
      loadSettings(),
      refreshHosts(),
      loadBookmarks(),
      computeWorkspaceHint(),
      loadSession()
    ])
    transferManager.setMaxConcurrent(settings.maxConcurrentTransfers)
    const transfers = transferManager.getSnapshot()
    const states = getHostStatesSnapshot()
    refreshLegacyConnectionStatus()
    updateStatusBar(transfers)
    return {
      localHome: getLocalHome(),
      settings,
      hosts,
      connection: connectionStatus,
      hostStates: states,
      transfers,
      bookmarks,
      workspaceHint,
      session
    }
  })

  handle('session.save', async (patch) => {
    const session = await patchSession(patch)
    if ('leftEndpoint' in patch || 'rightEndpoint' in patch) {
      updateStatusBar(transferManager.getSnapshot())
    }
    return { session }
  })

  handle('hosts.list', async () => {
    const hosts = await refreshHosts()
    return { hosts, hostStates: getHostStatesSnapshot() }
  })

  handle('hosts.save', async (input) => {
    const bindings = await loadSavedBindings()
    const secretVal = input.password || input.passphrase
    const existing = bindings.find(
      (b) =>
        (input.id && b.id === input.id) ||
        (input.orcaEnvironmentId && b.orcaEnvironmentId === input.orcaEnvironmentId)
    )
    const hasSecret = Boolean(secretVal || existing?.hasSecret)
    const stored = buildStoredBindingFromInput(input, hasSecret)

    if (secretVal) {
      await orca.secrets.set(`${SECRET_PREFIX}${stored.id}`, secretVal)
    }

    const next = bindings.filter((b) => b.id !== stored.id)
    next.push(stored)
    await saveBindings(next)

    // Drop stale transport if host config changed
    const oldTransport = transports.get(stored.id)
    if (oldTransport) {
      oldTransport.destroy()
      transports.delete(stored.id)
    }

    const hosts = await refreshHosts()
    const savedProfile = hosts.find((h) => h.id === stored.id) || hosts[0]
    post('hosts.updated', { hosts })
    return { host: savedProfile, hosts }
  })

  handle('hosts.delete', async ({ hostId }) => {
    const bindings = await loadSavedBindings()
    const next = bindings.filter((b) => b.id !== hostId)
    await saveBindings(next)
    await orca.secrets.delete(`${SECRET_PREFIX}${hostId}`).catch(() => undefined)
    const t = transports.get(hostId)
    if (t) {
      t.destroy()
      transports.delete(hostId)
    }
    hostStates.delete(hostId)
    refreshLegacyConnectionStatus()
    post('hostStates.updated', getHostStatesSnapshot())
    post('connection.updated', connectionStatus)
    updateStatusBar(transferManager.getSnapshot())
    const hosts = await refreshHosts()
    post('hosts.updated', { hosts })
    return { hosts }
  })

  handle('connection.connect', async ({ hostId, forceReconnect }) => {
    const profile = await getHostProfile(hostId)
    manuallyDisconnected.delete(profile.id)
    setHostState({
      hostId: profile.id,
      hostName: profile.name,
      state: 'connecting',
      source: 'sftp'
    })
    connectionStatus = {
      hostId: profile.id,
      hostName: profile.name,
      connected: false,
      connecting: true
    }
    post('connection.updated', connectionStatus)
    updateStatusBar(transferManager.getSnapshot())

    try {
      const transport = await getOrConnectTransport(hostId, Boolean(forceReconnect))
      const session = await loadSession()
      const rememberedPath = session.remotePathsByHost[hostId]
      const initialPath = rememberedPath || profile.defaultRemotePath || '.'
      let listing: { path: string; entries: import('../shared/types.ts').FileEntry[] }
      try {
        listing = await transport.listDir(initialPath)
      } catch {
        listing = await transport.listDir('.')
      }
      const homePath = await transport.realpath('.').catch(() => listing.path)
      const nextHostState: HostSftpState = {
        hostId: profile.id,
        hostName: profile.name,
        state: 'connected',
        source: profile.orcaStatus === 'connected' ? 'orca' : 'sftp',
        transportMode: transport.mode,
        remoteHome: homePath
      }
      setHostState(nextHostState)
      connectionStatus = {
        hostId: profile.id,
        hostName: profile.name,
        connected: true,
        connecting: false,
        transportMode: transport.mode,
        remoteHome: homePath
      }
      await patchSession({
        lastHostId: profile.id,
        wasConnected: true,
        remotePathsByHost: { [profile.id]: listing.path }
      })
      post('connection.updated', connectionStatus)
      updateStatusBar(transferManager.getSnapshot())
      return {
        connection: connectionStatus,
        hostState: nextHostState,
        hostStates: getHostStatesSnapshot(),
        remotePath: listing.path,
        entries: listing.entries
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      setHostState({
        hostId: profile.id,
        hostName: profile.name,
        state: 'error',
        error: message
      })
      connectionStatus = {
        hostId: profile.id,
        hostName: profile.name,
        connected: false,
        connecting: false,
        error: message
      }
      await patchSession({ lastHostId: profile.id, wasConnected: false }).catch(() => undefined)
      post('connection.updated', connectionStatus)
      updateStatusBar(transferManager.getSnapshot())
      throw err
    }
  })

  handle('connection.disconnect', async (input) => {
    const targetId = input?.hostId
    if (targetId) {
      manuallyDisconnected.add(targetId)
      const t = transports.get(targetId)
      if (t) {
        t.destroy()
        transports.delete(targetId)
      }
      const prev = hostStates.get(targetId)
      setHostState({
        hostId: targetId,
        hostName: prev?.hostName || targetId,
        state: 'disconnected'
      })
    } else {
      for (const [id, t] of transports) {
        manuallyDisconnected.add(id)
        t.destroy()
        const prev = hostStates.get(id)
        hostStates.set(id, {
          hostId: id,
          hostName: prev?.hostName || id,
          state: 'disconnected'
        })
      }
      transports.clear()
      for (const [id, st] of hostStates) {
        if (st.state === 'connected') {
          manuallyDisconnected.add(id)
          hostStates.set(id, { hostId: id, hostName: st.hostName, state: 'disconnected' })
        }
      }
      post('hostStates.updated', getHostStatesSnapshot())
    }
    refreshLegacyConnectionStatus()
    const stillConnected = Object.values(getHostStatesSnapshot()).some((s) => s.state === 'connected')
    await patchSession({ wasConnected: stillConnected }).catch(() => undefined)
    post('connection.updated', connectionStatus)
    updateStatusBar(transferManager.getSnapshot())
    return { connection: connectionStatus, hostStates: getHostStatesSnapshot() }
  })

  handle('fs.list', async ({ side, path, hostId }) => {
    if (side === 'local') {
      const res = await listLocalDir(path)
      void patchSession({ lastLocalPath: res.path }).catch(() => undefined)
      return { side: 'local' as const, path: res.path, entries: res.entries }
    }
    const transport = await resolveActiveTransport(hostId)
    const res = await transport.listDir(path || '.')
    void patchSession({ remotePathsByHost: { [transport.hostId]: res.path } }).catch(() => undefined)
    return { side: 'remote' as const, path: res.path, entries: res.entries }
  })

  handle('fs.mkdir', async ({ side, parentPath, name, hostId }) => {
    if (side === 'local') {
      return { createdPath: await mkdirLocal(parentPath, name) }
    }
    const transport = await resolveActiveTransport(hostId)
    return { createdPath: await transport.mkdir(parentPath, name) }
  })

  handle('fs.createFile', async ({ side, parentPath, name, content, hostId }) => {
    if (side === 'local') {
      return { createdPath: await createFileLocal(parentPath, name, content) }
    }
    const transport = await resolveActiveTransport(hostId)
    return { createdPath: await transport.createFile(parentPath, name, content) }
  })

  handle('fs.rename', async ({ side, oldPath, newName, hostId }) => {
    if (side === 'local') {
      return { newPath: await renameLocal(oldPath, newName) }
    }
    const transport = await resolveActiveTransport(hostId)
    return { newPath: await transport.rename(oldPath, newName) }
  })

  handle('fs.delete', async ({ side, paths, hostId }) => {
    if (side === 'local') {
      return { deletedCount: await deleteLocal(paths) }
    }
    const transport = await resolveActiveTransport(hostId)
    return { deletedCount: await transport.deletePaths(paths) }
  })

  handle('fs.chmod', async ({ side, path, mode, hostId }) => {
    if (side === 'local') {
      await chmodLocal(path, mode)
      return { ok: true as const }
    }
    const transport = await resolveActiveTransport(hostId)
    await transport.chmod(path, mode)
    return { ok: true as const }
  })

  handle('fs.search', async ({ side, rootPath, query, hostId, maxResults }) => {
    if (side === 'local') {
      return searchLocalRecursive(rootPath, query, maxResults)
    }
    const transport = await resolveActiveTransport(hostId)
    return transport.searchRecursive(rootPath, query, maxResults)
  })

  handle('fs.uploadChunkInit', async ({ hostId, targetDir, name, backupBeforeOverwrite }) => {
    const cleanName = name.trim()
    if (!cleanName || cleanName.includes('/') || cleanName === '.' || cleanName === '..') {
      throw new Error('Nome de arquivo inválido para upload.')
    }
    const transport = await resolveActiveTransport(hostId)
    const targetPath = posixJoin(targetDir, cleanName)
    const tempPath = `${targetPath}.orca-sftp.part`
    const handleBuf = await transport.openHandle(tempPath, SFTP_OPEN_FLAGS.WRITE_CREATE_TRUNC)
    const uploadId = `up-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`
    activeChunkUploads.set(uploadId, {
      transport,
      handle: handleBuf,
      tempPath,
      targetPath,
      backupBeforeOverwrite: Boolean(backupBeforeOverwrite)
    })
    return { uploadId, targetPath }
  })

  handle('fs.uploadChunkWrite', async ({ uploadId, offset, dataBase64 }) => {
    const up = activeChunkUploads.get(uploadId)
    if (!up) throw new Error('Sessão de upload expirada ou inválida.')
    const buf = Buffer.from(dataBase64, 'base64')
    await up.transport.writeChunk(up.handle, buf, 0, buf.length, offset)
    return { bytesWritten: buf.length }
  })

  handle('fs.uploadChunkFinish', async ({ uploadId, cancel }) => {
    const up = activeChunkUploads.get(uploadId)
    if (!up) throw new Error('Sessão de upload não encontrada.')
    activeChunkUploads.delete(uploadId)
    await up.transport.closeHandle(up.handle).catch(() => undefined)
    if (cancel) {
      await up.transport.unlink(up.tempPath).catch(() => undefined)
      return { targetPath: up.targetPath, ok: true as const }
    }
    if (up.backupBeforeOverwrite) {
      try {
        await up.transport.stat(up.targetPath)
        const bak = `${up.targetPath}.bak`
        try {
          await up.transport.stat(bak)
          const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
          await up.transport.renameExact(up.targetPath, `${up.targetPath}.${stamp}.bak`)
        } catch {
          await up.transport.renameExact(up.targetPath, bak)
        }
      } catch {
        // target didn't exist yet
      }
    }
    await up.transport.renameExact(up.tempPath, up.targetPath)
    return { targetPath: up.targetPath, ok: true as const }
  })

  handle('preview.readImage', async ({ side, path, hostId }) => {
    const maxBytes = 650 * 1024
    if (side === 'local') {
      return readLocalImage(path, maxBytes)
    }
    const transport = await resolveActiveTransport(hostId)
    const name = posixBasename(path)
    const mimeType = getImageMimeType(name)
    if (!mimeType) throw new Error(`Formato de imagem não suportado: ${name}`)
    const buf = await transport.readBytes(path, maxBytes)
    return {
      side: 'remote' as const,
      hostId: transport.hostId,
      path,
      name,
      mimeType,
      dataUrl: `data:${mimeType};base64,${buf.toString('base64')}`,
      size: buf.length
    }
  })

  handle('tail.start', async ({ side, path, hostId, lines }) => {
    const tailId = `tail-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`
    let buffer = ''
    let timer: ReturnType<typeof setTimeout> | null = null
    let closed = false

    const flush = () => {
      if (timer) {
        clearTimeout(timer)
        timer = null
      }
      if (!buffer) return
      const payload = buffer.length > 180_000 ? buffer.slice(-180_000) : buffer
      buffer = ''
      post('tail.data', { tailId, chunk: payload })
    }

    const onChunk = (chunk: string) => {
      if (closed) return
      buffer += chunk
      if (buffer.length >= 64 * 1024) {
        flush()
      } else if (!timer) {
        timer = setTimeout(flush, 200)
      }
    }

    const onClose = (reason?: string) => {
      if (closed) return
      closed = true
      flush()
      activeTails.delete(tailId)
      post('tail.closed', { tailId, reason })
    }

    let handleTail: TailHandle
    if (side === 'local') {
      handleTail = startLocalTail(path, lines || 200, onChunk, onClose)
    } else {
      const transport = await resolveActiveTransport(hostId)
      handleTail = transport.startTail(path, lines || 200, onChunk, onClose)
    }

    activeTails.set(tailId, {
      stop: () => {
        closed = true
        if (timer) clearTimeout(timer)
        handleTail.stop()
      }
    })

    return { tailId, path, side }
  })

  handle('tail.stop', async ({ tailId }) => {
    const t = activeTails.get(tailId)
    if (t) {
      t.stop()
      activeTails.delete(tailId)
    }
    return { ok: true as const }
  })

  handle('fs.compress', async ({ side, cwd, names, archiveName, format, hostId }) => {
    if (side === 'local') {
      const archivePath = await compressLocal(cwd, names, archiveName, format)
      return { archivePath }
    }
    const transport = await resolveActiveTransport(hostId)
    const archivePath = await transport.compress(cwd, names, archiveName, format)
    return { archivePath }
  })

  handle('fs.extract', async ({ side, archivePath, destinationDir, createSubfolder, hostId }) => {
    if (side === 'local') {
      const extractedTo = await extractLocal(archivePath, destinationDir, createSubfolder)
      return { extractedTo }
    }
    const transport = await resolveActiveTransport(hostId)
    const extractedTo = await transport.extract(archivePath, destinationDir, createSubfolder)
    return { extractedTo }
  })

  handle('editor.read', async ({ side, path, hostId, forceText }) => {
    // Cap at 700 KB so JSON RPC stays comfortably under Orca's 1 MiB response limit
    const maxBytes = Math.min(currentSettings.maxEditableFileKB * 1024, 700 * 1024)
    if (side === 'local') {
      return readLocalText(path, maxBytes, forceText)
    }
    const transport = await resolveActiveTransport(hostId)
    return transport.readText(path, maxBytes, forceText)
  })

  handle('editor.write', async ({ side, path, content, hostId }) => {
    if (side === 'local') {
      return writeLocalText(path, content)
    }
    const transport = await resolveActiveTransport(hostId)
    return transport.writeText(path, content)
  })

  handle('transfers.checkConflicts', async ({ hostId, targetSide: reqTargetSide, targetHostId, direction, items }) => {
    const conflicts: TransferConflict[] = []
    if (!items.length) return { conflicts }

    const targetSide: Side = reqTargetSide || (direction === 'download' ? 'local' : 'remote')
    const targetTransport =
      targetSide === 'remote' ? await resolveActiveTransport(targetHostId || hostId) : null
    const dirNamesCache = new Map<string, Set<string>>()

    const getExistingNames = async (dir: string): Promise<Set<string>> => {
      const cached = dirNamesCache.get(dir)
      if (cached) return cached
      const names = new Set<string>()
      try {
        if (targetSide === 'local') {
          const list = await readdir(dir)
          for (const n of list) names.add(n)
        } else if (targetTransport) {
          const { entries } = await targetTransport.listDir(dir)
          for (const e of entries) names.add(e.name)
        }
      } catch {
        // Directory may not exist yet -> no conflicts
      }
      dirNamesCache.set(dir, names)
      return names
    }

    for (const item of items) {
      const existingNames = await getExistingNames(item.targetDir)
      if (!existingNames.has(item.name)) continue

      const targetPath =
        targetSide === 'remote'
          ? posixJoin(item.targetDir, item.name)
          : join(item.targetDir, item.name)

      let targetSize = 0
      let targetMtimeMs = 0
      let targetIsDirectory = false

      try {
        if (targetSide === 'local') {
          const st = await stat(targetPath)
          targetSize = st.isDirectory() ? 0 : st.size
          targetMtimeMs = st.mtimeMs
          targetIsDirectory = st.isDirectory()
        } else if (targetTransport) {
          const st = await targetTransport.stat(targetPath)
          targetSize = st.isDirectory ? 0 : st.size
          targetMtimeMs = st.mtimeMs
          targetIsDirectory = st.isDirectory
        }
      } catch {
        continue
      }

      const suggestedName = suggestNonConflictingName(item.name, item.isDirectory, existingNames)
      existingNames.add(suggestedName)

      conflicts.push({
        sourcePath: item.sourcePath,
        targetPath,
        name: item.name,
        isDirectory: item.isDirectory,
        sourceSize: item.size || 0,
        sourceMtimeMs: item.mtimeMs,
        targetSize,
        targetMtimeMs,
        targetIsDirectory,
        suggestedName
      })
    }

    return { conflicts }
  })

  handle(
    'transfers.diffConflict',
    async ({ hostId, sourceSide: reqSrcSide, sourceHostId, targetSide: reqDstSide, targetHostId, direction, sourcePath, targetPath }) => {
      const MAX_DIFF_BYTES = 256 * 1024
      const sourceSide: Side = reqSrcSide || (direction === 'upload' ? 'local' : 'remote')
      const targetSide: Side = reqDstSide || (direction === 'download' ? 'local' : 'remote')
      const srcTransport = sourceSide === 'remote' ? await resolveActiveTransport(sourceHostId || hostId) : null
      const dstTransport = targetSide === 'remote' ? await resolveActiveTransport(targetHostId || hostId) : null

      let sourceBuf: Buffer
      let targetBuf: Buffer
      let sourceSize = 0
      let targetSize = 0

      try {
        const [sStat, tStat] = await Promise.all([
          sourceSide === 'local' ? stat(sourcePath) : srcTransport!.stat(sourcePath),
          targetSide === 'local' ? stat(targetPath) : dstTransport!.stat(targetPath)
        ])
        sourceSize = sStat.size
        targetSize = tStat.size
        if (sourceSize > MAX_DIFF_BYTES || targetSize > MAX_DIFF_BYTES) {
          return { binary: false, tooLarge: true, sourceSize, targetSize, added: 0, removed: 0, lines: [] }
        }
        ;[sourceBuf, targetBuf] = await Promise.all([
          sourceSide === 'local'
            ? readLocalBytes(sourcePath, MAX_DIFF_BYTES)
            : srcTransport!.readBytes(sourcePath, MAX_DIFF_BYTES),
          targetSide === 'local'
            ? readLocalBytes(targetPath, MAX_DIFF_BYTES)
            : dstTransport!.readBytes(targetPath, MAX_DIFF_BYTES)
        ])
      } catch (err) {
        throw new Error(err instanceof Error ? err.message : 'Falha ao ler arquivos para comparação.')
      }

      if (looksBinary(sourceBuf) || looksBinary(targetBuf)) {
        return { binary: true, sourceSize, targetSize, added: 0, removed: 0, lines: [] }
      }

      const diff = computeLineDiff(targetBuf.toString('utf8'), sourceBuf.toString('utf8'))
      return {
        binary: false,
        sourceSize,
        targetSize,
        added: diff.added,
        removed: diff.removed,
        truncated: diff.truncated,
        lines: diff.lines
      }
    }
  )

  handle(
    'transfers.enqueue',
    async ({ hostId, sourceSide: reqSrcSide, sourceHostId, targetSide: reqDstSide, targetHostId, direction, items, priority }) => {
      const sourceSide: Side = reqSrcSide || (direction === 'upload' ? 'local' : 'remote')
      const targetSide: Side = reqDstSide || (direction === 'download' ? 'local' : 'remote')
      const resolvedSrcHostId =
        sourceSide === 'remote' ? sourceHostId || hostId || connectionStatus.hostId || undefined : undefined
      const resolvedDstHostId =
        targetSide === 'remote' ? targetHostId || hostId || connectionStatus.hostId || undefined : undefined

      if (sourceSide === 'remote' && !resolvedSrcHostId) {
        throw new Error('Conecte-se ao host de origem antes de iniciar transferências.')
      }
      if (targetSide === 'remote' && !resolvedDstHostId) {
        throw new Error('Conecte-se ao host de destino antes de iniciar transferências.')
      }

      const srcProfile = resolvedSrcHostId ? await getHostProfile(resolvedSrcHostId) : null
      const dstProfile = resolvedDstHostId ? await getHostProfile(resolvedDstHostId) : null
      const primaryProfile = dstProfile || srcProfile
      if (!primaryProfile) {
        throw new Error('Selecione ao menos um host remoto para transferir.')
      }

      const snapshot = transferManager.enqueue({
        hostId: primaryProfile.id,
        hostName: primaryProfile.name,
        sourceSide,
        sourceHostId: srcProfile?.id,
        sourceHostName: srcProfile?.name,
        targetSide,
        targetHostId: dstProfile?.id,
        targetHostName: dstProfile?.name,
        direction,
        items,
        priority
      })
      return { snapshot }
    }
  )

  handle('transfers.list', async () => ({
    snapshot: transferManager.getSnapshot()
  }))

  handle('transfers.action', async ({ action, transferId }) => {
    let snapshot: TransferSnapshot
    switch (action) {
      case 'pause':
        snapshot = transferId ? transferManager.pause(transferId) : transferManager.getSnapshot()
        break
      case 'resume':
      case 'retry':
        snapshot = transferId ? transferManager.resume(transferId) : transferManager.getSnapshot()
        break
      case 'cancel':
        snapshot = transferId ? transferManager.cancel(transferId) : transferManager.getSnapshot()
        break
      case 'remove':
        snapshot = transferId ? transferManager.remove(transferId) : transferManager.getSnapshot()
        break
      case 'pauseAll':
        snapshot = transferManager.pauseAll()
        break
      case 'resumeAll':
        snapshot = transferManager.resumeAll()
        break
      case 'clearCompleted':
        snapshot = transferManager.clearCompleted()
        break
    }
    return { snapshot }
  })

  handle('transfers.setPriority', async ({ transferId, priority }) => ({
    snapshot: transferManager.setPriority(transferId, priority)
  }))

  handle('transfers.reorder', async ({ transferId, move }) => ({
    snapshot: transferManager.reorder(transferId, move)
  }))

  handle('bookmarks.toggle', async ({ side, path, label, hostId }) => {
    const list = await loadBookmarks()
    const idx = list.findIndex((b) => b.side === side && b.path === path && (b.hostId || '') === (hostId || ''))
    if (idx >= 0) {
      list.splice(idx, 1)
    } else {
      list.push({
        id: `bm-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
        side,
        hostId,
        label: label || path,
        path
      })
    }
    await saveBookmarks(list)
    return { bookmarks: list }
  })

  // === Palette Commands ===

  orca.commands.register('sftp.status', () => {
    post('quickHub.toggle', {})
    const snap = transferManager.getSnapshot()
    const host = connectionStatus.connected ? `Conectado em ${connectionStatus.hostName}` : 'Desconectado'
    return `${host} · ${snap.activeCount} ativa(s), ${snap.queuedCount} na fila, ${snap.pausedCount} pausada(s), ${snap.completedCount} concluída(s).`
  })

  orca.commands.register('sftp.pauseAll', () => {
    transferManager.pauseAll()
    return 'Todas as transferências SFTP foram pausadas.'
  })

  orca.commands.register('sftp.resumeAll', () => {
    transferManager.resumeAll()
    return 'Transferências SFTP pausadas foram retomadas.'
  })

  orca.commands.register('sftp.refreshHosts', async () => {
    const hosts = await refreshHosts()
    post('hosts.updated', { hosts })
    return `${hosts.length} host(s) descoberto(s) na Orca e ~/.ssh/config.`
  })

  // Background auto-sync with Orca's live hosts (picks up new, connected, reconnecting or disconnected hosts automatically)
  let hostPollBusy = false
  let lastHostsSignature = ''
  if (activeHostPollTimer) clearInterval(activeHostPollTimer)
  activeHostPollTimer = setInterval(() => {
    if (hostPollBusy || !cachedHosts.length) return
    hostPollBusy = true
    void (async () => {
      try {
        const bindings = await loadSavedBindings()
        const fresh = await discoverAllHosts(bindings)
        const prevStatesSig = JSON.stringify(getHostStatesSnapshot())
        const sig = JSON.stringify(
          fresh.map((h) => [h.id, h.name, h.orcaStatus, h.hostname, h.orcaVpnHost, h.needsSshBinding])
        )
        cachedHosts = fresh
        const stateChanged = syncOrcaHostStates(fresh)
        const nextStatesSnap = getHostStatesSnapshot()
        const nextStatesSig = JSON.stringify(nextStatesSnap)
        if (sig !== lastHostsSignature) {
          lastHostsSignature = sig
          post('hosts.updated', { hosts: fresh })
        }
        if (stateChanged || nextStatesSig !== prevStatesSig) {
          refreshLegacyConnectionStatus()
          post('hostStates.updated', nextStatesSnap)
          post('connection.updated', connectionStatus)
          updateStatusBar(transferManager.getSnapshot())
        }
      } catch {
        // Ignore transient Orca CLI poll errors
      } finally {
        hostPollBusy = false
      }
    })()
  }, 10_000)
  activeHostPollTimer.unref?.()

  orca.log('SFTP Bridge worker activated')
}

export async function deactivate(): Promise<void> {
  if (activeHostPollTimer) {
    clearInterval(activeHostPollTimer)
    activeHostPollTimer = null
  }
  for (const t of activeTails.values()) t.stop()
  activeTails.clear()
  activeManager?.shutdown()
  if (activeTransportsRef) {
    for (const t of activeTransportsRef.values()) t.destroy()
    activeTransportsRef.clear()
  }
  activeTransportsRef = null
  activeManager = null
}
