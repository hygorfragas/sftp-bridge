import { formatBytes, formatEta, formatSpeed } from '../../shared/file-utils.ts'
import type { TransferItem, TransferPriority, TransferSnapshot } from '../../shared/types.ts'
import { Icon } from './Icons.tsx'

export interface TransferPanelProps {
  snapshot: TransferSnapshot
  onAction: (
    action: 'pause' | 'resume' | 'cancel' | 'retry' | 'remove' | 'pauseAll' | 'resumeAll' | 'clearCompleted',
    transferId?: string
  ) => void
  onSetPriority: (transferId: string, priority: TransferPriority) => void
  onReorder: (transferId: string, move: 'top' | 'up' | 'down' | 'bottom') => void
}

function statusLabel(status: TransferItem['status']): string {
  switch (status) {
    case 'running':
      return 'Transferindo'
    case 'queued':
      return 'Na fila'
    case 'paused':
      return 'Pausado'
    case 'completed':
      return 'Concluído'
    case 'error':
      return 'Erro'
    case 'cancelled':
      return 'Cancelado'
  }
}

export function TransferPanel({ snapshot, onAction, onSetPriority, onReorder }: TransferPanelProps) {
  const hasRunningOrQueued = snapshot.activeCount + snapshot.queuedCount > 0
  const hasPaused = snapshot.pausedCount > 0
  const hasCompleted = snapshot.items.some((i) => i.status === 'completed' || i.status === 'cancelled')

  return (
    <div class="transfer-panel">
      <div class="transfer-toolbar">
        <div class="transfer-toolbar-row">
          <div class="transfer-stats">
            <span>
              <strong>{snapshot.activeCount}</strong> ativas
            </span>
            <span>·</span>
            <span>
              <strong>{snapshot.queuedCount}</strong> na fila
            </span>
            {snapshot.pausedCount > 0 && (
              <>
                <span>·</span>
                <span>
                  <strong>{snapshot.pausedCount}</strong> pausadas
                </span>
              </>
            )}
          </div>
        </div>

        <div class="tx-btn-group">
          <button
            class="btn xs"
            disabled={!hasRunningOrQueued}
            onClick={() => onAction('pauseAll')}
            title="Pausar todas as transferências ativas e na fila"
          >
            <Icon name="pause" size={11} /> Pausar
          </button>
          <button
            class="btn xs"
            disabled={!hasPaused}
            onClick={() => onAction('resumeAll')}
            title="Retomar todas as transferências pausadas"
          >
            <Icon name="play" size={11} /> Retomar
          </button>
          <button
            class="btn xs ghost"
            disabled={!hasCompleted}
            onClick={() => onAction('clearCompleted')}
            title="Limpar concluídas e canceladas"
          >
            Limpar
          </button>
        </div>
      </div>

      {snapshot.items.length === 0 ? (
        <div class="empty-state">
          <Icon name="sync" size={24} />
          <h3>Nenhuma transferência na fila</h3>
          <p>
            Clique com o botão direito em arquivos ou pastas (ou arraste entre Local e Remoto no modo
            dividido) para iniciar envios e downloads.
          </p>
        </div>
      ) : (
        <div class="transfer-list">
          {snapshot.items.map((item) => {
            const pct =
              item.status === 'completed'
                ? 100
                : item.totalBytes > 0
                  ? Math.min(100, Math.round((item.bytesTransferred / item.totalBytes) * 100))
                  : 0
            const isQueueable = item.status === 'queued' || item.status === 'paused'
            const canPause = item.status === 'running' || item.status === 'queued'
            const canResume = item.status === 'paused' || item.status === 'error' || item.status === 'cancelled'
            const canStop = item.status === 'running' || item.status === 'queued' || item.status === 'paused'

            return (
              <div key={item.id} class="tx-card">
                <div class="tx-top">
                  <div class="tx-name-wrap">
                    <span
                      class={`tx-dir ${item.direction}`}
                      title={item.direction === 'upload' ? 'Upload para servidor' : 'Download para local'}
                    >
                      {item.direction === 'upload' ? '↑' : '↓'}
                    </span>
                    <span class="tx-name" title={item.name}>
                      {item.name}
                    </span>
                  </div>
                  <span class={`pill ${item.status}`}>{statusLabel(item.status)}</span>
                </div>

                <div class="tx-paths" title={`${item.sourcePath} → ${item.targetPath}`}>
                  {item.hostName} · {item.sourcePath} → {item.targetPath}
                </div>

                <div class="tx-progress-track">
                  <div class={`tx-progress-fill ${item.status}`} style={{ width: `${pct}%` }} />
                </div>

                <div class="tx-meta">
                  <span>
                    {pct}% · {formatBytes(item.bytesTransferred)}
                    {item.totalBytes > 0 ? ` / ${formatBytes(item.totalBytes)}` : ''}
                    {item.isDirectory && item.filesTotal > 0
                      ? ` (${item.filesCompleted}/${item.filesTotal} arq.)`
                      : ''}
                  </span>
                  <span>
                    {item.status === 'running'
                      ? `${formatSpeed(item.speedBps)} · ETA ${formatEta(item.etaSeconds)}`
                      : item.status === 'paused'
                        ? 'Pausado (retoma do mesmo ponto)'
                        : ''}
                  </span>
                </div>

                {item.error && (
                  <div style={{ color: 'var(--danger)', fontSize: '11px', wordBreak: 'break-word' }}>
                    {item.error}
                  </div>
                )}

                <div class="tx-controls">
                  <div class="tx-btn-group">
                    {canPause && (
                      <button
                        class="btn xs"
                        title="Pausar transferência"
                        onClick={() => onAction('pause', item.id)}
                      >
                        <Icon name="pause" size={11} /> Pausar
                      </button>
                    )}
                    {canResume && (
                      <button
                        class="btn xs primary"
                        title="Iniciar / retomar transferência"
                        onClick={() => onAction('resume', item.id)}
                      >
                        <Icon name="play" size={11} /> {item.status === 'error' ? 'Tentar' : 'Iniciar'}
                      </button>
                    )}
                    {canStop && (
                      <button
                        class="btn xs"
                        title="Parar / cancelar transferência"
                        onClick={() => onAction('cancel', item.id)}
                      >
                        <Icon name="stop" size={11} /> Parar
                      </button>
                    )}
                    {!canStop && (
                      <button
                        class="icon-btn"
                        title="Remover da lista"
                        onClick={() => onAction('remove', item.id)}
                      >
                        <Icon name="trash" size={12} />
                      </button>
                    )}
                  </div>

                  {isQueueable && (
                    <div class="tx-btn-group">
                      <select
                        class="priority-select"
                        title="Prioridade na fila"
                        value={item.priority}
                        onChange={(e) =>
                          onSetPriority(item.id, (e.target as HTMLSelectElement).value as TransferPriority)
                        }
                      >
                        <option value="high">Alta</option>
                        <option value="normal">Normal</option>
                        <option value="low">Baixa</option>
                      </select>
                      <button
                        class="icon-btn"
                        title="Mover para o topo (baixar/enviar primeiro)"
                        onClick={() => onReorder(item.id, 'top')}
                      >
                        <Icon name="chevrons-up" size={12} />
                      </button>
                      <button
                        class="icon-btn"
                        title="Subir na fila"
                        onClick={() => onReorder(item.id, 'up')}
                      >
                        <Icon name="arrow-up" size={12} />
                      </button>
                      <button
                        class="icon-btn"
                        title="Descer na fila"
                        onClick={() => onReorder(item.id, 'down')}
                      >
                        <Icon name="arrow-down" size={12} />
                      </button>
                    </div>
                  )}
                </div>
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}
