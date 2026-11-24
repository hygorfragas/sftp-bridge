import { useEffect, useRef } from 'preact/hooks'
import type { FileEntry, Side } from '../../shared/types.ts'
import { Icon } from './Icons.tsx'

export interface ContextMenuState {
  x: number
  y: number
  side: Side
  entries: FileEntry[]
}

export interface ContextMenuCallbacks {
  onClose: () => void
  onOpenFolder: (entry: FileEntry) => void
  onTransfer: (side: Side, entries: FileEntry[], priority?: 'high' | 'normal') => void
  onEdit: (side: Side, entry: FileEntry, forceText?: boolean) => void
  onPreviewImage: (side: Side, entry: FileEntry) => void
  onTailLog: (side: Side, entry: FileEntry) => void
  onCompress: (side: Side, entries: FileEntry[], format: 'zip' | 'tar.gz') => void
  onExtract: (side: Side, entry: FileEntry, createSubfolder: boolean) => void
  onNewFolder: (side: Side) => void
  onNewFile: (side: Side) => void
  onRename: (side: Side, entry: FileEntry) => void
  onChmod: (side: Side, entry: FileEntry) => void
  onCopyPath: (entry: FileEntry) => void
  onDelete: (side: Side, entries: FileEntry[]) => void
  onRefresh: (side: Side) => void
  canTransfer: boolean
}

export function ContextMenu({
  menu,
  callbacks
}: {
  menu: ContextMenuState
  callbacks: ContextMenuCallbacks
}) {
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const onPointerDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        callbacks.onClose()
      }
    }
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') callbacks.onClose()
    }
    window.addEventListener('mousedown', onPointerDown)
    window.addEventListener('keydown', onKeyDown)
    return () => {
      window.removeEventListener('mousedown', onPointerDown)
      window.removeEventListener('keydown', onKeyDown)
    }
  }, [callbacks])

  // Keep menu inside viewport bounds
  const left = Math.min(menu.x, Math.max(8, window.innerWidth - 220))
  const top = Math.min(menu.y, Math.max(8, window.innerHeight - 360))

  const single = menu.entries.length === 1 ? menu.entries[0] : null
  const hasSelection = menu.entries.length > 0
  const transferLabel = menu.side === 'local' ? 'Enviar para Remoto' : 'Baixar para Local'
  const transferIcon = menu.side === 'local' ? 'upload' : 'download'

  const run = (fn: () => void) => {
    callbacks.onClose()
    fn()
  }

  return (
    <div ref={ref} class="context-menu" style={{ left: `${left}px`, top: `${top}px` }}>
      {single?.isDirectory && (
        <button class="ctx-item" onClick={() => run(() => callbacks.onOpenFolder(single))}>
          <span class="ctx-item-left">
            <Icon name="folder" size={13} /> Abrir pasta
          </span>
        </button>
      )}

      {hasSelection && (
        <>
          <button
            class="ctx-item"
            disabled={!callbacks.canTransfer}
            onClick={() => run(() => callbacks.onTransfer(menu.side, menu.entries, 'normal'))}
          >
            <span class="ctx-item-left">
              <Icon name={transferIcon} size={13} /> {transferLabel}
              {menu.entries.length > 1 ? ` (${menu.entries.length})` : ''}
            </span>
          </button>
          <button
            class="ctx-item"
            disabled={!callbacks.canTransfer}
            onClick={() => run(() => callbacks.onTransfer(menu.side, menu.entries, 'high'))}
          >
            <span class="ctx-item-left">
              <Icon name="chevrons-up" size={13} /> {transferLabel} (Prioritário)
            </span>
          </button>
        </>
      )}

      {single && !single.isDirectory && (
        <>
          <div class="ctx-sep" />
          {single.isImage && (
            <button class="ctx-item" onClick={() => run(() => callbacks.onPreviewImage(menu.side, single))}>
              <span class="ctx-item-left">
                <Icon name="image" size={13} /> Visualizar imagem
              </span>
            </button>
          )}
          <button class="ctx-item" onClick={() => run(() => callbacks.onEdit(menu.side, single, false))}>
            <span class="ctx-item-left">
              <Icon name="edit" size={13} /> {single.isEditableText ? 'Editar arquivo' : 'Abrir no editor'}
            </span>
          </button>
          {!single.isEditableText && !single.isImage && (
            <button class="ctx-item" onClick={() => run(() => callbacks.onEdit(menu.side, single, true))}>
              <span class="ctx-item-left">
                <Icon name="file-text" size={13} /> Forçar abrir como texto
              </span>
            </button>
          )}
          {!single.isImage && (
            <button class="ctx-item" onClick={() => run(() => callbacks.onTailLog(menu.side, single))}>
              <span class="ctx-item-left">
                <Icon name="terminal" size={13} /> Acompanhar ao vivo (tail -f)
              </span>
            </button>
          )}
        </>
      )}

      {hasSelection && (
        <>
          <div class="ctx-sep" />
          <button class="ctx-item" onClick={() => run(() => callbacks.onCompress(menu.side, menu.entries, 'zip'))}>
            <span class="ctx-item-left">
              <Icon name="archive" size={13} /> Compactar (.zip)...
            </span>
          </button>
          <button class="ctx-item" onClick={() => run(() => callbacks.onCompress(menu.side, menu.entries, 'tar.gz'))}>
            <span class="ctx-item-left">
              <Icon name="archive" size={13} /> Compactar (.tar.gz)...
            </span>
          </button>
        </>
      )}

      {single?.isArchive && (
        <>
          <button class="ctx-item" onClick={() => run(() => callbacks.onExtract(menu.side, single, false))}>
            <span class="ctx-item-left">
              <Icon name="archive" size={13} /> Descompactar aqui
            </span>
          </button>
          <button class="ctx-item" onClick={() => run(() => callbacks.onExtract(menu.side, single, true))}>
            <span class="ctx-item-left">
              <Icon name="folder" size={13} /> Descompactar em pasta
            </span>
          </button>
        </>
      )}

      <div class="ctx-sep" />
      <button class="ctx-item" onClick={() => run(() => callbacks.onNewFolder(menu.side))}>
        <span class="ctx-item-left">
          <Icon name="plus" size={13} /> Nova pasta
        </span>
      </button>
      <button class="ctx-item" onClick={() => run(() => callbacks.onNewFile(menu.side))}>
        <span class="ctx-item-left">
          <Icon name="file-text" size={13} /> Novo arquivo
        </span>
      </button>

      {single && (
        <>
          <div class="ctx-sep" />
          <button class="ctx-item" onClick={() => run(() => callbacks.onRename(menu.side, single))}>
            <span class="ctx-item-left">
              <Icon name="edit" size={13} /> Renomear
            </span>
          </button>
          <button class="ctx-item" onClick={() => run(() => callbacks.onCopyPath(single))}>
            <span class="ctx-item-left">
              <Icon name="copy" size={13} /> Copiar caminho
            </span>
          </button>
          <button class="ctx-item" onClick={() => run(() => callbacks.onChmod(menu.side, single))}>
            <span class="ctx-item-left">
              <Icon name="lock" size={13} /> Permissões (chmod)
            </span>
          </button>
        </>
      )}

      <div class="ctx-sep" />
      <button class="ctx-item" onClick={() => run(() => callbacks.onRefresh(menu.side))}>
        <span class="ctx-item-left">
          <Icon name="refresh" size={13} /> Atualizar
        </span>
      </button>

      {hasSelection && (
        <>
          <div class="ctx-sep" />
          <button class="ctx-item danger" onClick={() => run(() => callbacks.onDelete(menu.side, menu.entries))}>
            <span class="ctx-item-left">
              <Icon name="trash" size={13} /> Excluir{menu.entries.length > 1 ? ` (${menu.entries.length})` : ''}
            </span>
          </button>
        </>
      )}
    </div>
  )
}
