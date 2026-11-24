import { useEffect, useRef } from 'preact/hooks'
import type { FileEntry, PaneId } from '../../shared/types.ts'
import { Icon } from './Icons.tsx'

export interface ContextMenuState {
  x: number
  y: number
  paneId: PaneId
  transferLabel: string
  transferIcon: 'upload' | 'download' | 'arrows-up-down'
  entries: FileEntry[]
}

export interface ContextMenuCallbacks {
  onClose: () => void
  onOpenFolder: (paneId: PaneId, entry: FileEntry) => void
  onTransfer: (paneId: PaneId, entries: FileEntry[], priority?: 'high' | 'normal') => void
  onEdit: (paneId: PaneId, entry: FileEntry, forceText?: boolean) => void
  onPreviewImage: (paneId: PaneId, entry: FileEntry) => void
  onTailLog: (paneId: PaneId, entry: FileEntry) => void
  onCompress: (paneId: PaneId, entries: FileEntry[], format: 'zip' | 'tar.gz') => void
  onExtract: (paneId: PaneId, entry: FileEntry, createSubfolder: boolean) => void
  onNewFolder: (paneId: PaneId) => void
  onNewFile: (paneId: PaneId) => void
  onRename: (paneId: PaneId, entry: FileEntry) => void
  onChmod: (paneId: PaneId, entry: FileEntry) => void
  onCopyPath: (entry: FileEntry) => void
  onDelete: (paneId: PaneId, entries: FileEntry[]) => void
  onRefresh: (paneId: PaneId) => void
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
  const left = Math.min(menu.x, Math.max(8, window.innerWidth - 230))
  const top = Math.min(menu.y, Math.max(8, window.innerHeight - 360))

  const single = menu.entries.length === 1 ? menu.entries[0] : null
  const hasSelection = menu.entries.length > 0

  const run = (fn: () => void) => {
    callbacks.onClose()
    fn()
  }

  return (
    <div ref={ref} class="context-menu" style={{ left: `${left}px`, top: `${top}px` }}>
      {single?.isDirectory && (
        <button class="ctx-item" onClick={() => run(() => callbacks.onOpenFolder(menu.paneId, single))}>
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
            onClick={() => run(() => callbacks.onTransfer(menu.paneId, menu.entries, 'normal'))}
          >
            <span class="ctx-item-left">
              <Icon name={menu.transferIcon} size={13} /> {menu.transferLabel}
              {menu.entries.length > 1 ? ` (${menu.entries.length})` : ''}
            </span>
          </button>
          <button
            class="ctx-item"
            disabled={!callbacks.canTransfer}
            onClick={() => run(() => callbacks.onTransfer(menu.paneId, menu.entries, 'high'))}
          >
            <span class="ctx-item-left">
              <Icon name="chevrons-up" size={13} /> {menu.transferLabel} (Prioritário)
            </span>
          </button>
        </>
      )}

      {single && !single.isDirectory && (
        <>
          <div class="ctx-sep" />
          {single.isImage && (
            <button class="ctx-item" onClick={() => run(() => callbacks.onPreviewImage(menu.paneId, single))}>
              <span class="ctx-item-left">
                <Icon name="image" size={13} /> Visualizar imagem
              </span>
            </button>
          )}
          <button class="ctx-item" onClick={() => run(() => callbacks.onEdit(menu.paneId, single, false))}>
            <span class="ctx-item-left">
              <Icon name="edit" size={13} /> {single.isEditableText ? 'Editar arquivo' : 'Abrir no editor'}
            </span>
          </button>
          {!single.isEditableText && !single.isImage && (
            <button class="ctx-item" onClick={() => run(() => callbacks.onEdit(menu.paneId, single, true))}>
              <span class="ctx-item-left">
                <Icon name="file-text" size={13} /> Forçar abrir como texto
              </span>
            </button>
          )}
          {!single.isImage && (
            <button class="ctx-item" onClick={() => run(() => callbacks.onTailLog(menu.paneId, single))}>
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
          <button class="ctx-item" onClick={() => run(() => callbacks.onCompress(menu.paneId, menu.entries, 'zip'))}>
            <span class="ctx-item-left">
              <Icon name="archive" size={13} /> Compactar (.zip)...
            </span>
          </button>
          <button class="ctx-item" onClick={() => run(() => callbacks.onCompress(menu.paneId, menu.entries, 'tar.gz'))}>
            <span class="ctx-item-left">
              <Icon name="archive" size={13} /> Compactar (.tar.gz)...
            </span>
          </button>
        </>
      )}

      {single?.isArchive && (
        <>
          <button class="ctx-item" onClick={() => run(() => callbacks.onExtract(menu.paneId, single, false))}>
            <span class="ctx-item-left">
              <Icon name="archive" size={13} /> Descompactar aqui
            </span>
          </button>
          <button class="ctx-item" onClick={() => run(() => callbacks.onExtract(menu.paneId, single, true))}>
            <span class="ctx-item-left">
              <Icon name="folder" size={13} /> Descompactar em pasta
            </span>
          </button>
        </>
      )}

      <div class="ctx-sep" />
      <button class="ctx-item" onClick={() => run(() => callbacks.onNewFolder(menu.paneId))}>
        <span class="ctx-item-left">
          <Icon name="plus" size={13} /> Nova pasta
        </span>
      </button>
      <button class="ctx-item" onClick={() => run(() => callbacks.onNewFile(menu.paneId))}>
        <span class="ctx-item-left">
          <Icon name="file-text" size={13} /> Novo arquivo
        </span>
      </button>

      {single && (
        <>
          <div class="ctx-sep" />
          <button class="ctx-item" onClick={() => run(() => callbacks.onRename(menu.paneId, single))}>
            <span class="ctx-item-left">
              <Icon name="edit" size={13} /> Renomear
            </span>
          </button>
          <button class="ctx-item" onClick={() => run(() => callbacks.onCopyPath(single))}>
            <span class="ctx-item-left">
              <Icon name="copy" size={13} /> Copiar caminho
            </span>
          </button>
          <button class="ctx-item" onClick={() => run(() => callbacks.onChmod(menu.paneId, single))}>
            <span class="ctx-item-left">
              <Icon name="lock" size={13} /> Permissões (chmod)
            </span>
          </button>
        </>
      )}

      <div class="ctx-sep" />
      <button class="ctx-item" onClick={() => run(() => callbacks.onRefresh(menu.paneId))}>
        <span class="ctx-item-left">
          <Icon name="refresh" size={13} /> Atualizar
        </span>
      </button>

      {hasSelection && (
        <>
          <div class="ctx-sep" />
          <button class="ctx-item danger" onClick={() => run(() => callbacks.onDelete(menu.paneId, menu.entries))}>
            <span class="ctx-item-left">
              <Icon name="trash" size={13} /> Excluir{menu.entries.length > 1 ? ` (${menu.entries.length})` : ''}
            </span>
          </button>
        </>
      )}
    </div>
  )
}
