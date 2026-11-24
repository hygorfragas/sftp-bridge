import { useEffect, useMemo, useRef, useState } from 'preact/hooks'
import type { Side } from '../../shared/types.ts'
import { Icon } from './Icons.tsx'

export interface ActiveTailSession {
  tailId: string
  side: Side
  path: string
  name: string
}

const MAX_LOG_LINES = 3000

export function LogTailViewer({
  session,
  onStop
}: {
  session: ActiveTailSession
  onStop: () => void
}) {
  const [rawText, setRawText] = useState('')
  const [filter, setFilter] = useState('')
  const [paused, setPaused] = useState(false)
  const [wrap, setWrap] = useState(true)
  const [closedReason, setClosedReason] = useState<string | null>(null)
  const preRef = useRef<HTMLPreElement>(null)
  const pausedRef = useRef(paused)
  pausedRef.current = paused

  useEffect(() => {
    setRawText('')
    setClosedReason(null)
    const dataSub = orca.plugin.on('tail.data', (ev) => {
      if (ev.tailId !== session.tailId) return
      setRawText((prev) => {
        const next = prev + ev.chunk
        // Cap memory to ~400 KB of most recent output
        if (next.length > 420_000) {
          const cut = next.slice(-360_000)
          const nl = cut.indexOf('\n')
          return nl >= 0 ? cut.slice(nl + 1) : cut
        }
        return next
      })
    })
    const closeSub = orca.plugin.on('tail.closed', (ev) => {
      if (ev.tailId !== session.tailId) return
      setClosedReason(ev.reason || 'Stream finalizado.')
    })

    return () => {
      dataSub.dispose()
      closeSub.dispose()
    }
  }, [session.tailId])

  const allLines = useMemo(() => {
    if (!rawText) return []
    const split = rawText.replace(/\r\n/g, '\n').split('\n')
    return split.length > MAX_LOG_LINES ? split.slice(-MAX_LOG_LINES) : split
  }, [rawText])

  const visibleLines = useMemo(() => {
    const q = filter.trim().toLowerCase()
    if (!q) return allLines
    return allLines.filter((l) => l.toLowerCase().includes(q))
  }, [allLines, filter])

  useEffect(() => {
    if (!pausedRef.current && preRef.current) {
      preRef.current.scrollTop = preRef.current.scrollHeight
    }
  }, [visibleLines])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onStop()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onStop])

  return (
    <div class="editor-overlay">
      <div class="editor-header">
        <div class="editor-title-wrap">
          <div class="editor-title">
            <span class={`pill ${closedReason ? 'error' : 'completed'}`}>
              {closedReason ? 'Encerrado' : '● AO VIVO'}
            </span>
            <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              tail -f · {session.name}
            </span>
          </div>
          <div class="editor-path" title={session.path}>
            {session.side === 'remote' ? 'Remoto' : 'Local'} · {session.path}
          </div>
        </div>

        <div class="header-actions">
          <button
            class={`btn xs ${paused ? 'primary' : ''}`}
            onClick={() => setPaused((p) => !p)}
            title={paused ? 'Retomar rolagem automática' : 'Pausar rolagem automática'}
          >
            <Icon name={paused ? 'play' : 'pause'} size={11} /> {paused ? 'Retomar' : 'Pausar'}
          </button>
          <button
            class={`icon-btn ${wrap ? 'active' : ''}`}
            onClick={() => setWrap((w) => !w)}
            title="Quebra de linha"
          >
            <Icon name="wrap" size={14} />
          </button>
          <button class="btn xs ghost" onClick={() => setRawText('')} title="Limpar log exibido">
            Limpar
          </button>
          <button class="icon-btn" onClick={onStop} title="Parar tail -f e fechar (Esc)">
            <Icon name="close" size={14} />
          </button>
        </div>
      </div>

      <div class="editor-find-bar">
        <input
          class="search-input"
          style={{ height: '24px', paddingLeft: '8px' }}
          placeholder="Filtrar linhas em tempo real (ex.: ERROR, WARN, timeout)..."
          value={filter}
          onInput={(e) => setFilter((e.target as HTMLInputElement).value)}
        />
        {filter && (
          <button class="btn xs ghost" onClick={() => setFilter('')}>
            Limpar
          </button>
        )}
      </div>

      {closedReason && (
        <div class="banner-error" style={{ margin: 0, borderRadius: 0 }}>
          <span>{closedReason}</span>
        </div>
      )}

      <pre
        ref={preRef}
        class={`log-tail-pre ${wrap ? 'wrap' : ''}`}
        onScroll={(e) => {
          const el = e.currentTarget as HTMLPreElement
          const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 36
          if (!nearBottom && !paused) setPaused(true)
        }}
      >
        {visibleLines.length === 0 ? (
          <span style={{ color: 'var(--muted-fg)' }}>
            {filter ? `Nenhuma linha corresponde a "${filter}".` : 'Aguardando saída de tail -f...'}
          </span>
        ) : (
          visibleLines.join('\n')
        )}
      </pre>

      <div class="editor-footer">
        <span>
          {visibleLines.length} linha(s)
          {filter ? ` filtrada(s) de ${allLines.length}` : ''}
        </span>
        <span>{paused ? 'Scroll pausado' : 'Acompanhando ao vivo'}</span>
      </div>
    </div>
  )
}
