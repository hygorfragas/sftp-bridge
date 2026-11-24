import { useEffect, useRef } from 'preact/hooks'
import { formatBytes, formatSpeed } from '../../shared/file-utils.ts'
import type { ConnectionStatus, HostProfile, LayoutMode, TransferSnapshot } from '../../shared/types.ts'
import { Icon } from './Icons.tsx'

export interface QuickHubPopoverProps {
  connection: ConnectionStatus
  hosts: HostProfile[]
  transfers: TransferSnapshot
  syncBrowsing: boolean
  layout: LayoutMode
  canSplit: boolean
  onClose: () => void
  onConnectHost: (hostId: string) => void
  onDisconnect: () => void
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

  const { transfers, connection, hosts } = props
  const recentTransfers = transfers.items.slice(0, 4)
  const quickHosts = hosts.filter((h) => h.kind === 'orca-ssh' || h.kind === 'orca-env').slice(0, 6)
  const activeTotal = transfers.activeCount + transfers.queuedCount

  return (
    <div ref={ref} class="hub-popover" role="dialog" aria-label="Central SFTP Bridge">
      {/* Header matching Orca's native bottom popovers (e.g. Portas) */}
      <div class="hub-header">
        <div class="hub-header-left">
          <span
            class={`status-dot ${
              connection.connected ? 'connected' : connection.connecting ? 'connecting' : ''
            }`}
          />
          <span class="hub-title">SFTP Bridge</span>
        </div>
        <div class="hub-header-right">
          <span class="hub-subtitle">
            {connection.connected
              ? `${connection.hostName}`
              : 'Desconectado'}
          </span>
          <button class="icon-btn" onClick={props.onClose} title="Fechar (Esc)">
            <Icon name="close" size={13} />
          </button>
        </div>
      </div>

      <div class="hub-body">
        {/* Section 1: Transfers summary & live controls */}
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
                return (
                  <div key={tx.id} class="hub-tx-row">
                    <span class={`tx-dir ${tx.direction}`}>{tx.direction === 'upload' ? '↑' : '↓'}</span>
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
                        <button
                          class="icon-btn"
                          title="Pausar"
                          onClick={() => props.onTransferAction('pause', tx.id)}
                        >
                          <Icon name="pause" size={11} />
                        </button>
                      )}
                      {(tx.status === 'paused' || tx.status === 'error') && (
                        <button
                          class="icon-btn"
                          title="Retomar"
                          onClick={() => props.onTransferAction('resume', tx.id)}
                        >
                          <Icon name="play" size={11} />
                        </button>
                      )}
                      {(tx.status === 'running' || tx.status === 'queued' || tx.status === 'paused') && (
                        <button
                          class="icon-btn"
                          title="Parar"
                          onClick={() => props.onTransferAction('cancel', tx.id)}
                        >
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
            <button
              class="hub-action-item"
              onClick={() => {
                props.onRefreshHosts()
              }}
            >
              <Icon name="refresh" size={13} />
              <span>Atualizar hosts</span>
            </button>
            {connection.connected && (
              <button
                class="hub-action-item danger"
                onClick={() => {
                  props.onDisconnect()
                  props.onClose()
                }}
              >
                <Icon name="plug" size={13} />
                <span>Desconectar</span>
              </button>
            )}
          </div>
        </div>

        {/* Section 3: Quick Host Switcher */}
        {quickHosts.length > 0 && (
          <div class="hub-section">
            <div class="hub-section-head">
              <span>Servidores Orca</span>
              <span>{quickHosts.length}</span>
            </div>
            <div class="hub-host-list">
              {quickHosts.map((h) => {
                const isCurrent = connection.connected && connection.hostId === h.id
                return (
                  <button
                    key={h.id}
                    class={`hub-host-row ${isCurrent ? 'current' : ''}`}
                    onClick={() => {
                      props.onClose()
                      props.onConnectHost(h.id)
                    }}
                  >
                    <span class="hub-host-left">
                      <span class={`status-dot ${isCurrent || h.connected ? 'connected' : ''}`} />
                      <span class="hub-host-name">{h.name}</span>
                    </span>
                    <span class="hub-host-meta">
                      {isCurrent ? 'Conectado' : h.orcaVpnHost || h.hostname || h.sourceLabel}
                    </span>
                  </button>
                )
              })}
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
