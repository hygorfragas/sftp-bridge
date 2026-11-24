import { useEffect, useMemo, useState } from 'preact/hooks'
import { deduplicateHostsForDisplay } from '../../shared/host-display.ts'
import type {
  HostConnectionState,
  HostProfile,
  HostSftpState,
  PaneEndpoint,
  PaneId
} from '../../shared/types.ts'
import { Icon } from './Icons.tsx'

export interface ConnectionsManagerProps {
  hosts: HostProfile[]
  hostStates: Record<string, HostSftpState>
  leftEndpoint: PaneEndpoint
  rightEndpoint: PaneEndpoint | null
  onClose: () => void
  onConnect: (hostId: string, forceReconnect?: boolean) => Promise<void>
  onDisconnect: (hostId: string) => Promise<void>
  onAssignToPane: (pane: PaneId, endpoint: PaneEndpoint) => Promise<void>
  onEditHost: (profile?: Partial<HostProfile>) => void
  onRefreshHosts: () => void
}

function getRealState(hostId: string, hostStates: Record<string, HostSftpState>): HostConnectionState {
  return hostStates[hostId]?.state || 'disconnected'
}

function stateDotClass(state: HostConnectionState): string {
  if (state === 'connected') return 'connected'
  if (state === 'connecting') return 'connecting'
  return 'disconnected'
}

function stateLabel(state: HostConnectionState): string {
  if (state === 'connected') return 'Conectado'
  if (state === 'connecting') return 'Reconectando...'
  if (state === 'error') return 'Erro na conexão'
  return 'Desconectado'
}

export function ConnectionsManager(props: ConnectionsManagerProps) {
  const [search, setSearch] = useState('')

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') props.onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [props])

  const uniqueHosts = useMemo(() => {
    const inUse = new Set<string>()
    if (props.leftEndpoint.kind === 'remote') inUse.add(props.leftEndpoint.hostId)
    if (props.rightEndpoint?.kind === 'remote') inUse.add(props.rightEndpoint.hostId)
    return deduplicateHostsForDisplay(props.hosts, props.hostStates, inUse)
  }, [props.hosts, props.hostStates, props.leftEndpoint, props.rightEndpoint])

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase()
    if (!q) return uniqueHosts
    return uniqueHosts.filter(
      (h) =>
        h.name.toLowerCase().includes(q) ||
        (h.hostname || '').toLowerCase().includes(q) ||
        (h.orcaVpnHost || '').toLowerCase().includes(q) ||
        h.sourceLabel.toLowerCase().includes(q)
    )
  }, [uniqueHosts, search])

  const groups = useMemo(() => {
    const active = filtered.filter((h) => {
      const st = getRealState(h.id, props.hostStates)
      return st === 'connected' || st === 'connecting'
    })
    const activeIds = new Set(active.map((h) => h.id))
    const orcaRemotes = filtered.filter((h) => !activeIds.has(h.id) && h.kind === 'orca-env')
    const sshHosts = filtered.filter(
      (h) => !activeIds.has(h.id) && (h.kind === 'orca-ssh' || h.kind === 'ssh-config')
    )
    const manual = filtered.filter((h) => !activeIds.has(h.id) && h.kind === 'manual')
    return { active, orcaRemotes, sshHosts, manual }
  }, [filtered, props.hostStates])

  const renderHostRow = (host: HostProfile) => {
    const live = props.hostStates[host.id]
    const state = getRealState(host.id, props.hostStates)
    const inLeft = props.leftEndpoint.kind === 'remote' && props.leftEndpoint.hostId === host.id
    const inRight = props.rightEndpoint?.kind === 'remote' && props.rightEndpoint.hostId === host.id
    const subInfo = host.orcaVpnHost || host.hostname || host.sshAlias || ''

    return (
      <div key={host.id} class={`conn-row ${inLeft || inRight ? 'in-use' : ''}`}>
        <div class="conn-row-main">
          <span class={`status-dot ${stateDotClass(state)}`} title={live?.error || stateLabel(state)} />
          <div class="conn-row-info">
            <div class="conn-row-title">
              <span class="conn-row-name">{host.name}</span>
              {inLeft && <span class="pill running">Esq</span>}
              {inRight && <span class="pill running">Dir</span>}
            </div>
            <div class="conn-row-sub">
              <span>{stateLabel(state)}</span>
              {subInfo && <span> · {subInfo}</span>}
            </div>
            {state === 'error' && live?.error && (
              <div class="conn-row-err" title={live.error}>
                {live.error}
              </div>
            )}
          </div>
        </div>

        <div class="conn-row-actions">
          {state === 'connected' ? (
            <>
              {!inRight && (
                <button
                  class="btn xs"
                  title="Abrir este servidor no painel Direito"
                  onClick={() => void props.onAssignToPane('right', { kind: 'remote', hostId: host.id }).then(props.onClose)}
                >
                  Dir
                </button>
              )}
              {!inLeft && (
                <button
                  class="btn xs"
                  title="Abrir este servidor no painel Esquerdo (Remoto × Remoto)"
                  onClick={() => void props.onAssignToPane('left', { kind: 'remote', hostId: host.id }).then(props.onClose)}
                >
                  Esq
                </button>
              )}
              <button
                class="icon-btn"
                title="Reconectar sessão SFTP"
                onClick={() => void props.onConnect(host.id, true)}
              >
                <Icon name="refresh" size={12} />
              </button>
              <button
                class="btn xs ghost"
                title="Desconectar sessão SFTP"
                onClick={() => void props.onDisconnect(host.id)}
              >
                Desconectar
              </button>
            </>
          ) : state === 'connecting' ? (
            <span class="pill paused">Conectando...</span>
          ) : (
            <button
              class="btn xs primary"
              onClick={() => void props.onConnect(host.id, false)}
            >
              Conectar
            </button>
          )}
          <button
            class="icon-btn"
            title="Configurar / editar SSH deste host"
            onClick={() => props.onEditHost(host)}
          >
            <Icon name="settings" size={13} />
          </button>
        </div>
      </div>
    )
  }

  return (
    <div class="editor-overlay">
      <div class="editor-header">
        <div class="editor-title-wrap">
          <div class="editor-title">
            <Icon name="server" size={14} />
            <span>Conexões e Hosts SFTP</span>
          </div>
        </div>

        <div class="header-actions">
          <button class="icon-btn" title="Atualizar hosts da Orca e ~/.ssh/config" onClick={props.onRefreshHosts}>
            <Icon name="refresh" size={14} />
          </button>
          <button class="btn primary xs" onClick={() => props.onEditHost(undefined)}>
            <Icon name="plus" size={12} /> Nova conexão
          </button>
          <button class="icon-btn" title="Fechar (Esc)" onClick={props.onClose}>
            <Icon name="close" size={14} />
          </button>
        </div>
      </div>

      <div class="editor-find-bar">
        <input
          class="search-input"
          style={{ height: '26px', paddingLeft: '8px' }}
          placeholder="Filtrar hosts por nome, IP ou tipo..."
          value={search}
          onInput={(e) => setSearch((e.target as HTMLInputElement).value)}
        />
        {search && (
          <button class="btn xs ghost" onClick={() => setSearch('')}>
            Limpar
          </button>
        )}
      </div>

      <div class="conn-manager-body">
        {groups.active.length > 0 && (
          <div class="conn-group">
            <div class="conn-group-title">Sessões SFTP Ativas ({groups.active.length})</div>
            {groups.active.map(renderHostRow)}
          </div>
        )}

        {groups.orcaRemotes.length > 0 && (
          <div class="conn-group">
            <div class="conn-group-title">Servidores Orca Remotos ({groups.orcaRemotes.length})</div>
            {groups.orcaRemotes.map(renderHostRow)}
          </div>
        )}

        {groups.sshHosts.length > 0 && (
          <div class="conn-group">
            <div class="conn-group-title">Hosts SSH & ~/.ssh/config ({groups.sshHosts.length})</div>
            {groups.sshHosts.map(renderHostRow)}
          </div>
        )}

        {groups.manual.length > 0 && (
          <div class="conn-group">
            <div class="conn-group-title">Conexões Manuais Salvas ({groups.manual.length})</div>
            {groups.manual.map(renderHostRow)}
          </div>
        )}

        {filtered.length === 0 && (
          <div class="empty-state">
            <Icon name="server" size={24} />
            <h3>Nenhum host encontrado</h3>
            <p>Clique em "+ Nova conexão" para adicionar um servidor SSH/SFTP manualmente.</p>
          </div>
        )}
      </div>
    </div>
  )
}
