import { useEffect, useMemo, useRef } from 'preact/hooks'
import { formatBytes, formatSpeed } from '../../shared/file-utils.ts'
import { deduplicateHostsForDisplay } from '../../shared/host-display.ts'
import type {
  HostConnectionState,
  HostProfile,
  HostSftpState,
  LayoutMode,
  PaneEndpoint,
  TransferSnapshot
} from '../../shared/types.ts'
import { Icon } from './Icons.tsx'

export interface QuickHubPopoverProps {
  hosts: HostProfile[]
  hostStates: Record<string, HostSftpState>
  leftEndpoint: PaneEndpoint
  rightEndpoint: PaneEndpoint | null
  transfers: TransferSnapshot
  syncBrowsing: boolean
  layout: LayoutMode
  canSplit: boolean
  onClose: () => void
  onConnectHost: (hostId: string, forceReconnect?: boolean) => void
  onDisconnectHost: (hostId: string) => void
  onOpenConnectionsManager: () => void
  onToggleSync: () => void
  onSyncWorkspace: () => void
  onToggleLayout: () => void
  onRefreshHosts: () => void
  onNewHost: () => void
  onOpenFullTransfers: () => void
  onTransferAction: (
    action: 'pause' | 'resume' | 'cancel' | 'pauseAll' | 'resumeAll' | 'clearCompleted',
    transferId?: string
  ) => void
}

function getState(hostId: string, map: Record<string, HostSftpState>): HostConnectionState {
  return map[hostId]?.state || 'disconnected'
}

function dotClass(state: HostConnectionState): string {
  if (state === 'connected') return 'connected'
  if (state === 'connecting') return 'connecting'
  return 'disconnected'
}

function stateText(state: HostConnectionState): string {
  if (state === 'connected') return 'Conectado'
  if (state === 'connecting') return 'Reconectando...'
  if (state === 'error') return 'Erro'
  return 'Desconectado'
}

export function QuickHubPopover(props: QuickHubPopoverProps) {
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        props.onClose()
      }
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') props.onClose()
    }
    window.addEventListener('mousedown', onDown)
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('mousedown', onDown)
      window.removeEventListener('keydown', onKey)
    }
  }, [props])

  const { transfers, hosts, hostStates, leftEndpoint, rightEndpoint } = props
  const recentTransfers = transfers.items.slice(0, 4)
  const activeTotal = transfers.activeCount + transfers.queuedCount

  const hostById = useMemo(() => {
    const m = new Map<string, HostProfile>()
    for (const h of hosts) m.set(h.id, h)
    return m
  }, [hosts])

  const leftName =
    leftEndpoint.kind === 'local' ? 'Local' : hostById.get(leftEndpoint.hostId)?.name || 'Remoto'
  const rightName = !rightEndpoint
    ? 'Desconectado'
    : rightEndpoint.kind === 'local'
      ? 'Local'
      : hostById.get(rightEndpoint.hostId)?.name || 'Remoto'

  // Deduplicate hosts preferring in-use or connected, hiding duplicate orca-ssh wrappers
  const uniqueHosts = useMemo(() => {
    const inUseIds = new Set<string>()
    if (leftEndpoint.kind === 'remote') inUseIds.add(leftEndpoint.hostId)
    if (rightEndpoint?.kind === 'remote') inUseIds.add(rightEndpoint.hostId)
    return deduplicateHostsForDisplay(hosts, hostStates, inUseIds)
  }, [hosts, hostStates, leftEndpoint, rightEndpoint])

  const connectedStates = useMemo(
    () => uniqueHosts.filter((h) => getState(h.id, hostStates) === 'connected'),
    [uniqueHosts, hostStates]
  )
  const anyConnecting = useMemo(
    () => uniqueHosts.some((h) => getState(h.id, hostStates) === 'connecting'),
    [uniqueHosts, hostStates]
  )
  const overallDot: HostConnectionState = anyConnecting
    ? 'connecting'
    : connectedStates.length > 0
      ? 'connected'
      : 'disconnected'

  const quickHosts = useMemo(() => {
    const inUseIds = new Set<string>()
    if (leftEndpoint.kind === 'remote') inUseIds.add(leftEndpoint.hostId)
    if (rightEndpoint?.kind === 'remote') inUseIds.add(rightEndpoint.hostId)

    return [...uniqueHosts]
      .filter((h) => getState(h.id, hostStates) !== 'connecting')
      .sort((a, b) => {
        const score = (h: HostProfile) => {
          if (inUseIds.has(h.id)) return 0
          const st = getState(h.id, hostStates)
          if (st === 'connected') return 1
          if (h.kind === 'orca-env') return 2
          if (h.kind === 'orca-ssh') return 3
          return 4
        }
        return score(a) - score(b) || a.name.localeCompare(b.name)
      })
      .slice(0, 6)
  }, [uniqueHosts, hostStates, leftEndpoint, rightEndpoint])

  return (
    <div ref={ref} class="hub-popover" role="dialog" aria-label="Central SFTP Bridge">
      <div class="hub-header">
        <div class="hub-header-left">
          <span class={`status-dot ${dotClass(overallDot)}`} />
          <span class="hub-title">SFTP Bridge</span>
        </div>
        <div class="hub-header-right">
          <span class="hub-subtitle" title={`${leftName} ⇄ ${rightName}`}>
            {leftName} ⇄ {rightName}
          </span>
          <button class="icon-btn" onClick={props.onClose} title="Fechar (Esc)">
            <Icon name="close" size={13} />
          </button>
        </div>
      </div>

      <div class="hub-body">
        {/* Section 1: Transfers */}
        <div class="hub-section">
          <div class="hub-section-head">
            <span>
              Transferências ·{' '}
              {activeTotal > 0
                ? `${transfers.activeCount} ativa(s), ${transfers.queuedCount} fila`
                : transfers.pausedCount > 0
                  ? `${transfers.pausedCount} pausada(s)`
                  : `${transfers.completedCount} concluída(s)`}
            </span>
            <button
              class="hub-link-btn"
              onClick={() => {
                props.onClose()
                props.onOpenFullTransfers()
              }}
            >
              Ver fila
            </button>
          </div>

          <div class="hub-quick-bar">
            <button
              class="btn xs"
              disabled={activeTotal === 0}
              onClick={() => props.onTransferAction('pauseAll')}
            >
              <Icon name="pause" size={11} /> Pausar tudo
            </button>
            <button
              class="btn xs"
              disabled={transfers.pausedCount === 0}
              onClick={() => props.onTransferAction('resumeAll')}
            >
              <Icon name="play" size={11} /> Retomar
            </button>
            <button
              class="btn xs ghost"
              disabled={transfers.completedCount === 0}
              onClick={() => props.onTransferAction('clearCompleted')}
            >
              Limpar
            </button>
          </div>

          {recentTransfers.length === 0 ? (
            <div class="hub-empty">Nenhuma transferência ativa no momento.</div>
          ) : (
            <div class="hub-tx-list">
              {recentTransfers.map((tx) => {
                const pct =
                  tx.status === 'completed'
                    ? 100
                    : tx.totalBytes > 0
                      ? Math.min(100, Math.round((tx.bytesTransferred / tx.totalBytes) * 100))
                      : 0
                const dirSymbol =
                  tx.direction === 'remote-to-remote' ? '⇄' : tx.direction === 'upload' ? '↑' : '↓'
                return (
                  <div key={tx.id} class="hub-tx-row">
                    <span class={`tx-dir ${tx.direction}`}>{dirSymbol}</span>
                    <div class="hub-tx-info">
                      <div class="hub-tx-name" title={tx.name}>
                        {tx.name}
                      </div>
                      <div class="hub-tx-sub">
                        {pct}% · {formatBytes(tx.bytesTransferred)}
                        {tx.status === 'running' && tx.speedBps > 0 ? ` · ${formatSpeed(tx.speedBps)}` : ''}
                      </div>
                    </div>
                    <div class="hub-tx-actions">
                      {(tx.status === 'running' || tx.status === 'queued') && (
                        <button class="icon-btn" title="Pausar" onClick={() => props.onTransferAction('pause', tx.id)}>
                          <Icon name="pause" size={11} />
                        </button>
                      )}
                      {(tx.status === 'paused' || tx.status === 'error') && (
                        <button class="icon-btn" title="Retomar" onClick={() => props.onTransferAction('resume', tx.id)}>
                          <Icon name="play" size={11} />
                        </button>
                      )}
                      {(tx.status === 'running' || tx.status === 'queued' || tx.status === 'paused') && (
                        <button class="icon-btn" title="Parar" onClick={() => props.onTransferAction('cancel', tx.id)}>
                          <Icon name="stop" size={11} />
                        </button>
                      )}
                    </div>
                  </div>
                )
              })}
            </div>
          )}
        </div>

        {/* Section 2: Quick Actions */}
        <div class="hub-section">
          <div class="hub-section-head">
            <span>Ações rápidas</span>
          </div>
          <div class="hub-actions-grid">
            <button
              class={`hub-action-item ${props.syncBrowsing ? 'active' : ''}`}
              onClick={props.onToggleSync}
            >
              <Icon name="link" size={13} />
              <span>Sync Pastas: {props.syncBrowsing ? 'ON' : 'OFF'}</span>
            </button>
            <button
              class="hub-action-item"
              onClick={() => {
                props.onClose()
                props.onSyncWorkspace()
              }}
            >
              <Icon name="crosshair" size={13} />
              <span>Ir p/ Workspace</span>
            </button>
            <button
              class="hub-action-item"
              disabled={!props.canSplit && props.layout === 'tabs'}
              onClick={() => {
                props.onToggleLayout()
                props.onClose()
              }}
            >
              <Icon name={props.layout === 'tabs' ? 'split' : 'tabs'} size={13} />
              <span>{props.layout === 'tabs' ? 'Modo Dividido' : 'Modo Abas'}</span>
            </button>
            <button
              class="hub-action-item"
              onClick={() => {
                props.onClose()
                props.onNewHost()
              }}
            >
              <Icon name="plus" size={13} />
              <span>Nova conexão</span>
            </button>
          </div>
        </div>

        {/* Section 3: Hosts with REAL live SFTP status + in-use indicator */}
        <div class="hub-section">
          <div class="hub-section-head">
            <span>Conexões SFTP ({connectedStates.length} online)</span>
            <button
              class="hub-link-btn"
              onClick={() => {
                props.onClose()
                props.onOpenConnectionsManager()
              }}
            >
              Gerenciar hosts...
            </button>
          </div>
          <div class="hub-host-list">
            {quickHosts.map((h) => {
              const st = getState(h.id, hostStates)
              const inLeft = leftEndpoint.kind === 'remote' && leftEndpoint.hostId === h.id
              const inRight = rightEndpoint?.kind === 'remote' && rightEndpoint.hostId === h.id
              const inUse = inLeft || inRight

              return (
                <div key={h.id} class={`hub-host-row ${inUse ? 'current' : ''}`}>
                  <button
                    class="hub-host-select-area"
                    onClick={() => {
                      props.onClose()
                      props.onConnectHost(h.id, false)
                    }}
                    title={hostStates[h.id]?.error || `${h.name} — ${stateText(st)}`}
                  >
                    <span class={`status-dot ${dotClass(st)}`} />
                    <span class="hub-host-name">{h.name}</span>
                    {inLeft && <span class="pill running">Esq</span>}
                    {inRight && <span class="pill running">Dir</span>}
                  </button>

                  <div class="hub-host-right-actions">
                    <span class="hub-host-meta">{stateText(st)}</span>
                    {st === 'connected' ? (
                      <>
                        <button
                          class="icon-btn"
                          title="Reconectar"
                          onClick={() => props.onConnectHost(h.id, true)}
                        >
                          <Icon name="refresh" size={11} />
                        </button>
                        <button
                          class="icon-btn"
                          title="Desconectar"
                          onClick={() => props.onDisconnectHost(h.id)}
                        >
                          <Icon name="close" size={11} />
                        </button>
                      </>
                    ) : st === 'connecting' ? null : (
                      <button
                        class="hub-link-btn"
                        onClick={() => props.onConnectHost(h.id, false)}
                      >
                        Conectar
                      </button>
                    )}
                  </div>
                </div>
              )
            })}
          </div>
        </div>
      </div>
    </div>
  )
}
