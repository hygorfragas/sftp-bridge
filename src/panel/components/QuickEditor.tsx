import { useEffect, useMemo, useRef, useState } from 'preact/hooks'
import { formatBytes, isMarkdownFile } from '../../shared/file-utils.ts'
import type { EditorFilePayload } from '../../shared/types.ts'
import { Icon } from './Icons.tsx'
import { MarkdownPreview } from './MarkdownPreview.tsx'

export function QuickEditor({
  file,
  onSave,
  onReload,
  onClose
}: {
  file: EditorFilePayload
  onSave: (content: string) => Promise<void>
  onReload: () => Promise<void>
  onClose: () => void
}) {
  const [content, setContent] = useState(file.content)
  const [savedContent, setSavedContent] = useState(file.content)
  const [saving, setSaving] = useState(false)
  const [wrap, setWrap] = useState(false)
  const [mdMode, setMdMode] = useState<'edit' | 'preview'>('edit')
  const [showFind, setShowFind] = useState(false)
  const [findQuery, setFindQuery] = useState('')
  const [saveError, setSaveError] = useState<string | null>(null)
  const [confirmDiscard, setConfirmDiscard] = useState(false)

  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const gutterRef = useRef<HTMLDivElement>(null)
  const isMd = useMemo(() => isMarkdownFile(file.name), [file.name])

  useEffect(() => {
    setContent(file.content)
    setSavedContent(file.content)
    setSaveError(null)
  }, [file.path, file.mtimeMs])

  const dirty = content !== savedContent
  const lineCount = useMemo(() => Math.max(1, content.split('\n').length), [content])

  const handleSave = async () => {
    if (saving) return
    setSaving(true)
    setSaveError(null)
    try {
      await onSave(content)
      setSavedContent(content)
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : String(err))
    } finally {
      setSaving(false)
    }
  }

  const handleClose = () => {
    if (dirty && !confirmDiscard) {
      setConfirmDiscard(true)
      return
    }
    onClose()
  }

  const handleFindNext = () => {
    const ta = textareaRef.current
    if (!ta || !findQuery) return
    const lowerText = content.toLowerCase()
    const lowerQ = findQuery.toLowerCase()
    const start = ta.selectionEnd || 0
    let idx = lowerText.indexOf(lowerQ, start)
    if (idx < 0) idx = lowerText.indexOf(lowerQ, 0)
    if (idx >= 0) {
      ta.focus()
      ta.setSelectionRange(idx, idx + findQuery.length)
    }
  }

  const onKeyDown = (e: KeyboardEvent) => {
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 's') {
      e.preventDefault()
      void handleSave()
    } else if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'f') {
      e.preventDefault()
      setShowFind((v) => !v)
    } else if (e.key === 'Escape') {
      if (showFind) setShowFind(false)
      else if (confirmDiscard) setConfirmDiscard(false)
      else handleClose()
    }
  }

  const handleTextareaKeyDown = (e: KeyboardEvent) => {
    if (e.key === 'Tab') {
      e.preventDefault()
      const ta = e.currentTarget as HTMLTextAreaElement
      const start = ta.selectionStart
      const end = ta.selectionEnd
      const next = `${content.slice(0, start)}  ${content.slice(end)}`
      setContent(next)
      requestAnimationFrame(() => {
        ta.selectionStart = ta.selectionEnd = start + 2
      })
    }
  }

  return (
    <div class="editor-overlay" onKeyDown={onKeyDown}>
      <div class="editor-header">
        <div class="editor-title-wrap">
          <div class="editor-title">
            <span class="pill">{file.side === 'remote' ? 'Remoto' : 'Local'}</span>
            <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {file.name}
            </span>
            {dirty && <span class="dirty-dot" title="Alterações não salvas" />}
          </div>
          <div class="editor-path" title={file.path}>
            {file.path}
          </div>
        </div>

        <div class="header-actions">
          {isMd && (
            <button
              class={`btn xs ${mdMode === 'preview' ? 'primary' : ''}`}
              onClick={() => setMdMode((m) => (m === 'edit' ? 'preview' : 'edit'))}
              title="Alternar entre edição e preview Markdown"
            >
              {mdMode === 'preview' ? 'Editar' : 'Preview'}
            </button>
          )}
          <button
            class={`icon-btn ${wrap ? 'active' : ''}`}
            title="Quebra de linha"
            onClick={() => setWrap((w) => !w)}
          >
            <Icon name="wrap" size={14} />
          </button>
          <button
            class={`icon-btn ${showFind ? 'active' : ''}`}
            title="Buscar no arquivo (⌘F)"
            onClick={() => setShowFind((v) => !v)}
          >
            <Icon name="search" size={14} />
          </button>
          <button class="icon-btn" title="Recarregar do disco" onClick={() => void onReload()}>
            <Icon name="refresh" size={14} />
          </button>
          <button
            class="btn primary xs"
            disabled={saving || !dirty}
            onClick={() => void handleSave()}
            title="Salvar alterações (⌘S)"
          >
            <Icon name="save" size={12} /> {saving ? 'Salvando...' : 'Salvar'}
          </button>
          <button class="icon-btn" title="Fechar editor" onClick={handleClose}>
            <Icon name="close" size={14} />
          </button>
        </div>
      </div>

      {confirmDiscard && (
        <div class="banner-error" style={{ margin: '0', borderRadius: 0 }}>
          <span>Existem alterações não salvas em {file.name}. Deseja descartar?</span>
          <div style={{ display: 'flex', gap: '4px', flexShrink: 0 }}>
            <button class="btn xs primary" onClick={() => void handleSave().then(() => setConfirmDiscard(false))}>
              Salvar
            </button>
            <button class="btn xs danger" onClick={onClose}>
              Descartar
            </button>
            <button class="btn xs" onClick={() => setConfirmDiscard(false)}>
              Cancelar
            </button>
          </div>
        </div>
      )}

      {saveError && (
        <div class="banner-error" style={{ margin: '0', borderRadius: 0 }}>
          <span>Erro ao salvar: {saveError}</span>
          <button class="icon-btn" onClick={() => setSaveError(null)}>
            <Icon name="close" size={12} />
          </button>
        </div>
      )}

      {showFind && (
        <div class="editor-find-bar">
          <input
            class="search-input"
            style={{ height: '24px', paddingLeft: '8px' }}
            placeholder="Buscar texto..."
            value={findQuery}
            autoFocus
            onInput={(e) => setFindQuery((e.target as HTMLInputElement).value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') handleFindNext()
            }}
          />
          <button class="btn xs" onClick={handleFindNext}>
            Próximo
          </button>
          <button class="icon-btn" onClick={() => setShowFind(false)}>
            <Icon name="close" size={12} />
          </button>
        </div>
      )}

      <div class="editor-body">
        {isMd && mdMode === 'preview' ? (
          <MarkdownPreview content={content} />
        ) : (
          <>
            <div ref={gutterRef} class="editor-gutter" aria-hidden="true">
              {Array.from({ length: lineCount }, (_, i) => (
                <div key={i}>{i + 1}</div>
              ))}
            </div>
            <textarea
              ref={textareaRef}
              class={`editor-textarea ${wrap ? 'wrap' : ''}`}
              value={content}
              spellcheck={false}
              onInput={(e) => setContent((e.target as HTMLTextAreaElement).value)}
              onKeyDown={handleTextareaKeyDown}
              onScroll={(e) => {
                if (gutterRef.current) {
                  gutterRef.current.scrollTop = (e.target as HTMLTextAreaElement).scrollTop
                }
              }}
            />
          </>
        )}
      </div>

      <div class="editor-footer">
        <span>
          {lineCount} linha(s) · {formatBytes(new Blob([content]).size)} · UTF-8
        </span>
        <span>{dirty ? 'Modificado (⌘S para salvar)' : 'Salvo'}</span>
      </div>
    </div>
  )
}
