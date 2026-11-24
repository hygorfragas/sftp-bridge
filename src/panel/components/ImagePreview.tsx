import { useEffect, useState } from 'preact/hooks'
import { formatBytes } from '../../shared/file-utils.ts'
import type { ImagePreviewPayload } from '../../shared/types.ts'
import { Icon } from './Icons.tsx'

export function ImagePreview({
  image,
  onTransfer,
  canTransfer,
  onClose
}: {
  image: ImagePreviewPayload
  onTransfer?: () => void
  canTransfer: boolean
  onClose: () => void
}) {
  const [zoom, setZoom] = useState<'fit' | number>('fit')
  const [dims, setDims] = useState<{ w: number; h: number } | null>(null)

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  const stepZoom = (delta: number) => {
    setZoom((z) => {
      const cur = z === 'fit' ? 100 : z
      return Math.max(25, Math.min(400, cur + delta))
    })
  }

  return (
    <div class="editor-overlay">
      <div class="editor-header">
        <div class="editor-title-wrap">
          <div class="editor-title">
            <span class="pill">{image.side === 'remote' ? 'Remoto' : 'Local'}</span>
            <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {image.name}
            </span>
          </div>
          <div class="editor-path" title={image.path}>
            {image.path}
          </div>
        </div>

        <div class="header-actions">
          <button class="btn xs" onClick={() => stepZoom(-25)} title="Diminuir zoom">
            −
          </button>
          <button
            class={`btn xs ${zoom === 'fit' ? 'primary' : ''}`}
            onClick={() => setZoom('fit')}
            title="Ajustar à tela"
          >
            {zoom === 'fit' ? 'Ajustar' : `${zoom}%`}
          </button>
          <button class="btn xs" onClick={() => stepZoom(25)} title="Aumentar zoom">
            +
          </button>
          {onTransfer && canTransfer && (
            <button class="btn xs" onClick={onTransfer} title={image.side === 'remote' ? 'Baixar para Local' : 'Enviar para Remoto'}>
              <Icon name={image.side === 'remote' ? 'download' : 'upload'} size={12} />
            </button>
          )}
          <button class="icon-btn" onClick={onClose} title="Fechar preview (Esc)">
            <Icon name="close" size={14} />
          </button>
        </div>
      </div>

      <div class="image-preview-canvas">
        <img
          src={image.dataUrl}
          alt={image.name}
          class={zoom === 'fit' ? 'image-preview-fit' : 'image-preview-zoomed'}
          style={zoom === 'fit' ? undefined : { width: `${zoom}%` }}
          onLoad={(e) => {
            const img = e.currentTarget as HTMLImageElement
            setDims({ w: img.naturalWidth, h: img.naturalHeight })
          }}
        />
      </div>

      <div class="editor-footer">
        <span>
          {dims ? `${dims.w} × ${dims.h} px · ` : ''}
          {formatBytes(image.size)} · {image.mimeType}
        </span>
        <span>Preview rápido</span>
      </div>
    </div>
  )
}
