import { useEffect, useMemo, useRef, useState } from 'preact/hooks'
import { formatBytes, formatTimestamp, posixDirname } from '../../shared/file-utils.ts'
import { deduplicateHostsForDisplay } from '../../shared/host-display.ts'
import type {
  BookmarkEntry,
  FileEntry,
  HostConnectionState,
  HostProfile,
  HostSftpState,
  PaneEndpoint,
  PaneId,
  SearchResultEntry,
  Side,
  TransferDirection
} from '../../shared/types.ts'
import { Icon } from './Icons.tsx'

type SortField = 'name' | 'size' | 'mtime'
type SortDir = 'asc' | 'desc'

export interface FilePaneProps {
  paneId: PaneId
  side: Side
  endpoint: PaneEndpoint | null
  title: string
  hostState?: HostSftpState
  hosts: HostProfile[]
  hostStates: Record<string, HostSftpState>
  otherPaneTitle?: string
  transferDirection?: TransferDirection | null
  path: string
  homePath: string
  entries: FileEntry[]
  loading: boolean
  error: string | null
  connected: boolean
  showHidden: boolean
  narrow?: boolean
  bookmarks: BookmarkEntry[]
  selectedPaths: Set<string>
  onSelectEndpoint: (endpoint: PaneEndpoint) => void
  onOpenConnectionsManager: () => void
  onToggleHidden: () => void
  onNavigate: (path: string, relativeAction?: { kind: 'enter'; name: string } | { kind: 'up' }) => void
  onRefresh: () => void
  onToggleBookmark: () => void
  onSelectChange: (next: Set<string>) => void
  onOpenEntry: (entry: FileEntry) => void
  onContextMenu: (e: MouseEvent, entries: FileEntry[]) => void
  onTransferSelected: (entries: FileEntry[]) => void
  onDropFromOtherPane: (entries: FileEntry[]) => void
  onDropExternalFiles?: (files: FileList) => void
  onRecursiveSearch: (query: string) => Promise<{ results: SearchResultEntry[]; truncated: boolean }>
  onOpenSearchResult: (result: SearchResultEntry) => void
  canTransfer: boolean
  disconnectedAction?: { label: string; onClick: () => void; hint: string; secondaryLabel?: string; onSecondaryClick?: () => void }
}

function getRealState(hostId: string, hostStates: Record<string, HostSftpState>): HostConnectionState {
  return hostStates[hostId]?.state || 'disconnected'
}

function dotClass(state: HostConnectionState): string {
  if (state === 'connected') return 'connected'
  if (state === 'connecting') return 'connecting'
  return 'disconnected'
}

export function FilePane(props: FilePaneProps) {
  const [pathDraft, setPathDraft] = useState(props.path)
  const [search, setSearch] = useState('')
  const [recursiveMode, setRecursiveMode] = useState(false)
  const [recursiveLoading, setRecursiveLoading] = useState(false)
  const [recursiveResults, setRecursiveResults] = useState<SearchResultEntry[]>([])
  const [recursiveTruncated, setRecursiveTruncated] = useState(false)
  const [sortField, setSortField] = useState<SortField>('name')
  const [sortDir, setSortDir] = useState<SortDir>('asc')
  const [dragOver, setDragOver] = useState(false)
  const [dragHint, setDragHint] = useState<string | null>(null)
  const [showBookmarks, setShowBookmarks] = useState(false)
  const [endpointMenuOpen, setEndpointMenuOpen] = useState(false)
  const lastClickedIdx = useRef<number>(-1)
  const endpointMenuRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    setPathDraft(props.path)
    if (recursiveMode) {
      setRecursiveResults([])
    }
  }, [props.path])

  // Close endpoint selector menu on outside click / Escape
  useEffect(() => {
    if (!endpointMenuOpen) return
    const onDown = (e: MouseEvent) => {
      if (endpointMenuRef.current && !endpointMenuRef.current.contains(e.target as Node)) {
        setEndpointMenuOpen(false)
      }
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setEndpointMenuOpen(false)
    }
    window.addEventListener('mousedown', onDown)
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('mousedown', onDown)
      window.removeEventListener('keydown', onKey)
    }
  }, [endpointMenuOpen])

  // Debounced recursive subfolder search
  useEffect(() => {
    if (!recursiveMode) {
      setRecursiveResults([])
      setRecursiveTruncated(false)
      return
    }
    const q = search.trim()
    if (q.length < 2) {
      setRecursiveResults([])
      setRecursiveTruncated(false)
      return
    }
    let cancelled = false
    const timer = setTimeout(() => {
      setRecursiveLoading(true)
      void props
        .onRecursiveSearch(q)
        .then((res) => {
          if (cancelled) return
          setRecursiveResults(res.results)
          setRecursiveTruncated(res.truncated)
        })
        .catch(() => {
          if (!cancelled) setRecursiveResults([])
        })
        .finally(() => {
          if (!cancelled) setRecursiveLoading(false)
        })
    }, 320)
    return () => {
      cancelled = true
      clearTimeout(timer)
    }
  }, [recursiveMode, search, props.path])

  const filteredEntries = useMemo(() => {
    const q = search.trim().toLowerCase()
    const list = props.entries.filter((entry) => {
      if (!props.showHidden && entry.isHidden) return false
      if (q && !entry.name.toLowerCase().includes(q)) return false
      return true
    })

    list.sort((a, b) => {
      if (a.isDirectory !== b.isDirectory) return a.isDirectory ? -1 : 1
      let cmp = 0
      if (sortField === 'name') cmp = a.name.localeCompare(b.name, undefined, { sensitivity: 'base' })
      else if (sortField === 'size') cmp = a.size - b.size
      else cmp = a.mtimeMs - b.mtimeMs
      return sortDir === 'asc' ? cmp : -cmp
    })

    return list
  }, [props.entries, props.showHidden, search, sortField, sortDir])

  const isBookmarked = useMemo(
    () => props.bookmarks.some((b) => b.side === props.side && b.path === props.path),
    [props.bookmarks, props.side, props.path]
  )

  const sideBookmarks = useMemo(
    () => props.bookmarks.filter((b) => b.side === props.side),
    [props.bookmarks, props.side]
  )

  // Sort hosts for the pane endpoint picker: active SFTP/Orca sessions first, then available hosts.
  // Hide hosts currently in 'connecting' state (user can monitor/reconnect them in Orca or Connections Manager).
  const sortedMenuHosts = useMemo(() => {
    const inUse = new Set<string>()
    if (props.endpoint?.kind === 'remote') inUse.add(props.endpoint.hostId)
    const uniqueHosts = deduplicateHostsForDisplay(props.hosts, props.hostStates, inUse)

    const connected: HostProfile[] = []
    const others: HostProfile[] = []
    for (const h of uniqueHosts) {
      const st = getRealState(h.id, props.hostStates)
      if (st === 'connecting') continue
      if (st === 'connected') connected.push(h)
      else others.push(h)
    }
    return { connected, others }
  }, [props.endpoint, props.hosts, props.hostStates])

  const toggleSort = (field: SortField) => {
    if (sortField === field) {
      setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'))
    } else {
      setSortField(field)
      setSortDir(field === 'mtime' ? 'desc' : 'asc')
    }
  }

  const handleRowClick = (e: MouseEvent, entry: FileEntry, idx: number) => {
    const next = new Set(props.selectedPaths)
    if (e.shiftKey && lastClickedIdx.current >= 0) {
      const start = Math.min(lastClickedIdx.current, idx)
      const end = Math.max(lastClickedIdx.current, idx)
      if (!e.metaKey && !e.ctrlKey) next.clear()
      for (let i = start; i <= end; i++) {
        if (filteredEntries[i]) next.add(filteredEntries[i].path)
      }
    } else if (e.metaKey || e.ctrlKey) {
      if (next.has(entry.path)) next.delete(entry.path)
      else next.add(entry.path)
      lastClickedIdx.current = idx
    } else {
      next.clear()
      next.add(entry.path)
      lastClickedIdx.current = idx
    }
    props.onSelectChange(next)
  }

  const getSelectedEntries = (): FileEntry[] =>
    filteredEntries.filter((e) => props.selectedPaths.has(e.path))

  const handleRowContextMenu = (e: MouseEvent, entry: FileEntry) => {
    e.preventDefault()
    e.stopPropagation()
    let entriesToAct: FileEntry[]
    if (props.selectedPaths.has(entry.path)) {
      entriesToAct = getSelectedEntries()
    } else {
      props.onSelectChange(new Set([entry.path]))
      entriesToAct = [entry]
    }
    props.onContextMenu(e, entriesToAct)
  }

  const handleBgContextMenu = (e: MouseEvent) => {
    e.preventDefault()
    props.onContextMenu(e, [])
  }

  const handleDragStart = (e: DragEvent, entry: FileEntry) => {
    const dragging = props.selectedPaths.has(entry.path) ? getSelectedEntries() : [entry]
    e.dataTransfer?.setData(
      'application/x-orca-sftp-entries',
      JSON.stringify({ paneId: props.paneId, side: props.side, entries: dragging })
    )
    if (e.dataTransfer) e.dataTransfer.effectAllowed = 'copy'
  }

  const handleDragOver = (e: DragEvent) => {
    if (!props.connected) return
    const types = e.dataTransfer?.types || []
    if (types.includes('application/x-orca-sftp-entries')) {
      e.preventDefault()
      if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy'
      setDragOver(true)
      setDragHint(
        props.side === 'remote' ? `Solte para enviar para ${props.title}` : 'Solte para baixar para Local'
      )
    } else if (props.side === 'remote' && props.onDropExternalFiles && types.includes('Files')) {
      e.preventDefault()
      if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy'
      setDragOver(true)
      setDragHint(`Solte arquivos do Finder para enviar para ${props.title}`)
    }
  }

  const handleDrop = (e: DragEvent) => {
    e.preventDefault()
    setDragOver(false)
    setDragHint(null)
    if (!props.connected) return

    const raw = e.dataTransfer?.getData('application/x-orca-sftp-entries')
    if (raw) {
      try {
        const parsed = JSON.parse(raw) as { paneId?: PaneId; side: Side; entries: FileEntry[] }
        const isFromOther = parsed.paneId ? parsed.paneId !== props.paneId : parsed.side !== props.side
        if (isFromOther && Array.isArray(parsed.entries) && parsed.entries.length) {
          props.onDropFromOtherPane(parsed.entries)
        }
      } catch {
        // ignore
      }
      return
    }

    if (props.side === 'remote' && props.onDropExternalFiles && e.dataTransfer?.files?.length) {
      props.onDropExternalFiles(e.dataTransfer.files)
    }
  }

  const parentPath = posixDirname(props.path || '/')
  const selectedEntries = getSelectedEntries()
  const entryIcon = (entry: FileEntry) => {
    if (entry.isDirectory) return 'folder'
    if (entry.isSymlink) return 'symlink'
    if (entry.isArchive) return 'archive'
    if (entry.isImage) return 'image'
    if (entry.isLogFile) return 'terminal'
    if (entry.isEditableText) return 'file-text'
    return 'file'
  }

  const isLocal = props.endpoint?.kind === 'local'
  const currentHostId = props.endpoint?.kind === 'remote' ? props.endpoint.hostId : null
  const currentRemoteState: HostConnectionState = currentHostId
    ? props.hostState?.state || getRealState(currentHostId, props.hostStates)
    : 'disconnected'

  const renderEndpointSubbar = () => {
    const transferIcon =
      props.transferDirection === 'remote-to-remote'
        ? 'arrows-up-down'
        : props.transferDirection === 'download'
          ? 'download'
          : 'upload'
    const transferText =
      props.transferDirection === 'remote-to-remote'
        ? props.narrow
          ? 'Enviar'
          : `Enviar → ${props.otherPaneTitle || 'Remoto'}`
        : props.transferDirection === 'download'
          ? 'Baixar'
          : 'Enviar'

    return (
      <div class="pane-subbar">
        <div ref={endpointMenuRef} class="pane-endpoint-wrap">
          <button
            class={`pane-endpoint-btn ${endpointMenuOpen ? 'open' : ''}`}
            title={
              isLocal
                ? 'Clique para trocar este painel por outro servidor remoto (Remoto × Remoto)'
                : `${props.title} — clique para trocar servidor ou alternar para Local`
            }
            onClick={() => setEndpointMenuOpen((v) => !v)}
          >
            {!isLocal && (
              <span class={`status-dot sm ${dotClass(currentRemoteState)}`} />
            )}
            <span class="pane-endpoint-text">
              {isLocal ? 'Local' : currentHostId ? `Remoto · ${props.title}` : 'Remoto · Selecionar'}
            </span>
            <span class="pane-endpoint-chevron">
              <Icon name="chevron-down" size={11} />
            </span>
          </button>

          {endpointMenuOpen && (
            <div class="pane-endpoint-menu" role="menu">
              <div class="pane-endpoint-menu-section">Origem deste painel</div>
              <button
                class={`pane-endpoint-option ${isLocal ? 'selected' : ''}`}
                onClick={() => {
                  setEndpointMenuOpen(false)
                  props.onSelectEndpoint({ kind: 'local' })
                }}
              >
                <span class="pane-endpoint-option-left">
                  <Icon name="folder" size={12} />
                  <span>Este computador (Local)</span>
                </span>
                {isLocal && <Icon name="check" size={12} />}
              </button>

              {sortedMenuHosts.connected.length > 0 && (
                <>
                  <div class="ctx-sep" />
                  <div class="pane-endpoint-menu-section">Sessões SFTP ativas</div>
                  {sortedMenuHosts.connected.map((h) => {
                    const st = getRealState(h.id, props.hostStates)
                    const active = currentHostId === h.id
                    return (
                      <button
                        key={h.id}
                        class={`pane-endpoint-option ${active ? 'selected' : ''}`}
                        title={`${h.name} (${h.sourceLabel})`}
                        onClick={() => {
                          setEndpointMenuOpen(false)
                          props.onSelectEndpoint({ kind: 'remote', hostId: h.id })
                        }}
                      >
                        <span class="pane-endpoint-option-left">
                          <span class={`status-dot sm ${dotClass(st)}`} />
                          <span class="pane-endpoint-option-name">{h.name}</span>
                        </span>
                        {active && <Icon name="check" size={12} />}
                      </button>
                    )
                  })}
                </>
              )}

              {sortedMenuHosts.others.length > 0 && (
                <>
                  <div class="ctx-sep" />
                  <div class="pane-endpoint-menu-section">Servidores disponíveis</div>
                  {sortedMenuHosts.others.map((h) => {
                    const st = getRealState(h.id, props.hostStates)
                    const active = currentHostId === h.id
                    return (
                      <button
                        key={h.id}
                        class={`pane-endpoint-option ${active ? 'selected' : ''}`}
                        title={`${h.name} (${h.sourceLabel})`}
                        onClick={() => {
                          setEndpointMenuOpen(false)
                          props.onSelectEndpoint({ kind: 'remote', hostId: h.id })
                        }}
                      >
                        <span class="pane-endpoint-option-left">
                          <span class={`status-dot sm ${dotClass(st)}`} />
                          <span class="pane-endpoint-option-name">{h.name}</span>
                        </span>
                        <span class="pane-endpoint-option-tag">
                          {h.kind === 'orca-env' ? 'Orca' : h.kind === 'orca-ssh' ? 'SSH' : h.kind === 'ssh-config' ? 'cfg' : 'manual'}
                        </span>
                      </button>
                    )
                  })}
                </>
              )}

              <div class="ctx-sep" />
              <button
                class="pane-endpoint-option manage"
                onClick={() => {
                  setEndpointMenuOpen(false)
                  props.onOpenConnectionsManager()
                }}
              >
                <span class="pane-endpoint-option-left">
                  <Icon name="server" size={12} />
                  <span>Gerenciar conexões / Nova...</span>
                </span>
              </button>
            </div>
          )}
        </div>

        {props.connected && selectedEntries.length > 0 && props.canTransfer && (
          <button
            class="btn primary xs"
            onClick={() => props.onTransferSelected(selectedEntries)}
          >
            <Icon name={transferIcon} size={11} />
            {transferText} ({selectedEntries.length})
          </button>
        )}
      </div>
    )
  }

  if (props.side === 'remote' && !props.connected) {
    const isConnecting = currentRemoteState === 'connecting'
    return (
      <div class={`file-pane ${props.narrow ? 'narrow' : ''}`}>
        {renderEndpointSubbar()}
        <div class="empty-state">
          <Icon name={isConnecting ? 'refresh' : 'plug'} size={26} />
          <h3>
            {isConnecting
              ? `Conectando a ${props.title}...`
              : currentHostId
                ? `${props.title} desconectado`
                : 'Nenhum host remoto selecionado'}
          </h3>
          <p>
            {props.error ||
              props.disconnectedAction?.hint ||
              'Clique no título acima para escolher um servidor ou abra o Gerenciador de Conexões.'}
          </p>
          {!isConnecting && props.disconnectedAction && (
            <div style={{ display: 'flex', gap: '6px', flexWrap: 'wrap', justifyContent: 'center' }}>
              <button class="btn primary" onClick={props.disconnectedAction.onClick}>
                {props.disconnectedAction.label}
              </button>
              {props.disconnectedAction.secondaryLabel && props.disconnectedAction.onSecondaryClick && (
                <button class="btn" onClick={props.disconnectedAction.onSecondaryClick}>
                  {props.disconnectedAction.secondaryLabel}
                </button>
              )}
            </div>
          )}
        </div>
      </div>
    )
  }

  return (
    <div
      class={`file-pane ${props.narrow ? 'narrow' : ''} ${dragOver ? 'drag-over' : ''}`}
      onDragOver={handleDragOver}
      onDragLeave={() => setDragOver(false)}
      onDrop={handleDrop}
      onContextMenu={handleBgContextMenu}
    >
      {renderEndpointSubbar()}

      <div class={`path-toolbar ${props.narrow ? 'compact' : ''}`}>
        <div class="path-toolbar-icons">
          <div class="path-toolbar-icons-left">
            <button
              class={`icon-btn ${props.showHidden ? 'active' : ''}`}
              title={props.showHidden ? 'Ocultar dotfiles' : 'Mostrar arquivos ocultos'}
              onClick={props.onToggleHidden}
            >
              <Icon name={props.showHidden ? 'eye' : 'eye-off'} size={13} />
            </button>
            <button
              class="icon-btn"
              title="Subir um nível (..)"
              disabled={!props.path || props.path === '/'}
              onClick={() => props.onNavigate(parentPath, { kind: 'up' })}
            >
              <Icon name="up" size={13} />
            </button>
            <button
              class="icon-btn"
              title="Diretório inicial (Home)"
              onClick={() => props.onNavigate(props.homePath || '.')}
            >
              <Icon name="home" size={13} />
            </button>

            <div style={{ position: 'relative' }}>
              <button
                class={`icon-btn ${isBookmarked ? 'active' : ''}`}
                title="Favoritos de diretório"
                onClick={() => setShowBookmarks((v) => !v)}
              >
                <Icon name="star" size={13} color={isBookmarked ? '#eab308' : undefined} />
              </button>
              {showBookmarks && (
                <div class="popover-menu" style={props.narrow ? { left: 0, right: 'auto' } : undefined}>
                  <button
                    class="ctx-item"
                    onClick={() => {
                      props.onToggleBookmark()
                      setShowBookmarks(false)
                    }}
                  >
                    <span class="ctx-item-left">
                      <Icon name="star" size={12} />
                      {isBookmarked ? 'Remover pasta atual' : 'Favoritar pasta atual'}
                    </span>
                  </button>
                  {sideBookmarks.length > 0 && <div class="ctx-sep" />}
                  {sideBookmarks.map((bm) => (
                    <button
                      key={bm.id}
                      class="ctx-item"
                      title={bm.path}
                      onClick={() => {
                        props.onNavigate(bm.path)
                        setShowBookmarks(false)
                      }}
                    >
                      <span class="ctx-item-left" style={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>
                        <Icon name="folder" size={12} />
                        <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                          {bm.label}
                        </span>
                      </span>
                    </button>
                  ))}
                </div>
              )}
            </div>
          </div>

          {props.narrow && (
            <button class="icon-btn" title="Atualizar lista" onClick={props.onRefresh}>
              <Icon name="refresh" size={13} />
            </button>
          )}
        </div>

        <input
          class="path-input"
          value={pathDraft}
          title={props.path || 'Pressione Enter para navegar'}
          onInput={(e) => setPathDraft((e.target as HTMLInputElement).value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              const next = pathDraft.trim()
              if (next) props.onNavigate(next)
            }
          }}
        />

        {!props.narrow && (
          <button class="icon-btn" title="Atualizar lista" onClick={props.onRefresh}>
            <Icon name="refresh" size={13} />
          </button>
        )}
      </div>

      <div class="search-row">
        <div class="search-wrap">
          <span class="search-icon">
            <Icon name="search" size={12} />
          </span>
          <input
            class="search-input"
            placeholder={
              recursiveMode
                ? 'Buscar em subpastas (mín. 2 letras)...'
                : props.side === 'local'
                  ? 'Buscar arquivos locais...'
                  : 'Buscar arquivos remotos...'
            }
            value={search}
            onInput={(e) => setSearch((e.target as HTMLInputElement).value)}
          />
          {search && (
            <button class="search-clear" onClick={() => setSearch('')} title="Limpar filtro">
              ✕
            </button>
          )}
        </div>
        <button
          class={`btn xs ${recursiveMode ? 'primary' : ''}`}
          title="Buscar recursivamente em todas as subpastas a partir deste diretório"
          onClick={() => setRecursiveMode((v) => !v)}
        >
          Subpastas
        </button>
      </div>

      {dragOver && dragHint && <div class="drop-hint-banner">{dragHint}</div>}

      {props.error && (
        <div class="banner-error">
          <span>{props.error}</span>
          <button class="btn xs" onClick={props.onRefresh}>
            Tentar
          </button>
        </div>
      )}

      {recursiveMode && search.trim().length >= 2 ? (
        <div class="file-list">
          {recursiveLoading && (
            <div class="empty-state">
              <p>Buscando em subpastas...</p>
            </div>
          )}
          {!recursiveLoading && recursiveResults.length === 0 && (
            <div class="empty-state">
              <p>Nenhum arquivo encontrado em subpastas para "{search}".</p>
            </div>
          )}
          {!recursiveLoading &&
            recursiveResults.map((res) => (
              <div
                key={res.path}
                class="search-result-row"
                onClick={() => props.onOpenSearchResult(res)}
                title={res.path}
              >
                <div class="file-name-cell">
                  <Icon
                    name={res.isDirectory ? 'folder' : res.isImage ? 'image' : res.isEditableText ? 'file-text' : 'file'}
                    size={14}
                  />
                  <div style={{ minWidth: 0, flex: 1 }}>
                    <div class="file-name">{res.name}</div>
                    <div class="search-result-rel">{res.relativePath}</div>
                  </div>
                </div>
              </div>
            ))}
          {recursiveTruncated && (
            <div style={{ padding: '6px 10px', fontSize: '11px', color: 'var(--muted-fg)' }}>
              Mostrando os primeiros resultados. Refine a busca para ver mais.
            </div>
          )}
        </div>
      ) : (
        <>
          <div class="file-table-head">
            <button class="sort-col" onClick={() => toggleSort('name')}>
              Nome {sortField === 'name' ? (sortDir === 'asc' ? '▲' : '▼') : ''}
            </button>
            <button class="sort-col right" onClick={() => toggleSort('size')}>
              Tam. {sortField === 'size' ? (sortDir === 'asc' ? '▲' : '▼') : ''}
            </button>
            <button class="sort-col right col-mtime" onClick={() => toggleSort('mtime')}>
              Modificado {sortField === 'mtime' ? (sortDir === 'asc' ? '▲' : '▼') : ''}
            </button>
          </div>

          <div class="file-list">
            {props.path && props.path !== '/' && !search && (
              <div
                class="file-row"
                onDblClick={() => props.onNavigate(parentPath, { kind: 'up' })}
                title="Voltar para diretório pai"
              >
                <div class="file-name-cell">
                  <Icon name="folder" size={14} />
                  <span class="file-name">..</span>
                </div>
                <div class="file-size-cell" />
                <div class="file-mtime-cell col-mtime" />
              </div>
            )}

            {props.loading && filteredEntries.length === 0 && (
              <div class="empty-state">
                <p>Carregando diretório...</p>
              </div>
            )}

            {!props.loading && filteredEntries.length === 0 && (
              <div class="empty-state">
                <p>{search ? `Nenhum item encontrado para "${search}".` : 'Pasta vazia.'}</p>
              </div>
            )}

            {filteredEntries.map((entry, idx) => {
              const isSelected = props.selectedPaths.has(entry.path)
              return (
                <div
                  key={entry.path}
                  class={`file-row ${isSelected ? 'selected' : ''} ${entry.isHidden ? 'hidden-file' : ''}`}
                  draggable
                  onClick={(e) => handleRowClick(e, entry, idx)}
                  onDblClick={() => props.onOpenEntry(entry)}
                  onContextMenu={(e) => handleRowContextMenu(e, entry)}
                  onDragStart={(e) => handleDragStart(e, entry)}
                  title={`${entry.path}\n${entry.permissions}${entry.isDirectory ? '' : ` · ${formatBytes(entry.size)}`}`}
                >
                  <div class="file-name-cell">
                    <Icon name={entryIcon(entry)} size={14} />
                    <span class="file-name">{entry.name}</span>
                  </div>
                  <div class="file-size-cell">{entry.isDirectory ? '—' : formatBytes(entry.size)}</div>
                  <div class="file-mtime-cell col-mtime">{formatTimestamp(entry.mtimeMs)}</div>
                </div>
              )
            })}
          </div>
        </>
      )}

      <div class="pane-footer">
        <span>
          {filteredEntries.length} item(ns)
          {selectedEntries.length > 0 ? ` · ${selectedEntries.length} sel.` : ''}
        </span>
        <span class="pane-footer-hint" style={{ opacity: 0.75 }}>
          Clique direito p/ opções
        </span>
      </div>
    </div>
  )
}
