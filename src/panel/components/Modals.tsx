import { useState } from 'preact/hooks'
import { formatBytes, formatTimestamp } from '../../shared/file-utils.ts'
import type {
  ArchiveFormat,
  AuthMethod,
  ConflictDiffResult,
  FileEntry,
  HostProfile,
  SaveHostInput,
  Side,
  TransferConflict,
  TransferDirection,
  TransferPriority
} from '../../shared/types.ts'

export type ModalState =
  | null
  | { kind: 'host'; initial?: Partial<HostProfile> }
  | { kind: 'mkdir'; side: Side }
  | { kind: 'newFile'; side: Side }
  | { kind: 'rename'; side: Side; entry: FileEntry }
  | { kind: 'chmod'; side: Side; entry: FileEntry }
  | { kind: 'compress'; side: Side; entries: FileEntry[]; defaultFormat: ArchiveFormat }
  | { kind: 'delete'; side: Side; entries: FileEntry[] }
  | {
      kind: 'conflict'
      fromSide: Side
      direction: TransferDirection
      entries: FileEntry[]
      conflicts: TransferConflict[]
      priority: TransferPriority
    }

export function HostModal({
  initial,
  onSave,
  onDelete,
  onClose
}: {
  initial?: Partial<HostProfile>
  onSave: (input: SaveHostInput) => Promise<void>
  onDelete?: (hostId: string) => Promise<void>
  onClose: () => void
}) {
  const isOrcaEnvBinding = Boolean(initial?.orcaEnvironmentId)
  const [name, setName] = useState(initial?.name || '')
  const [hostname, setHostname] = useState(initial?.hostname || '')
  const [port, setPort] = useState(String(initial?.port || 22))
  const [username, setUsername] = useState(initial?.username || 'root')
  const [authMethod, setAuthMethod] = useState<AuthMethod>(
    initial?.authMethod || (initial?.sshAlias ? 'openssh' : 'agent')
  )
  const [sshAlias, setSshAlias] = useState(initial?.sshAlias || '')
  const [identityFile, setIdentityFile] = useState(initial?.identityFile || '~/.ssh/id_ed25519')
  const [secret, setSecret] = useState('')
  const [defaultRemotePath, setDefaultRemotePath] = useState(initial?.defaultRemotePath || '')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const submit = async (e: Event) => {
    e.preventDefault()
    if (authMethod !== 'openssh' && !hostname.trim()) {
      setError('Informe o endereço IP ou hostname do servidor.')
      return
    }
    if (authMethod === 'openssh' && !sshAlias.trim() && !hostname.trim()) {
      setError('Informe o alias SSH (do ~/.ssh/config) ou o hostname.')
      return
    }
    setBusy(true)
    setError(null)
    try {
      await onSave({
        id: initial?.id,
        name: name.trim() || hostname.trim() || sshAlias.trim(),
        hostname: hostname.trim() || sshAlias.trim(),
        port: Number.parseInt(port, 10) || 22,
        username: username.trim() || 'root',
        authMethod,
        sshAlias: authMethod === 'openssh' ? sshAlias.trim() || hostname.trim() : undefined,
        identityFile: authMethod === 'key' ? identityFile.trim() : undefined,
        password: authMethod === 'password' ? secret || undefined : undefined,
        passphrase: authMethod === 'key' ? secret || undefined : undefined,
        orcaEnvironmentId: initial?.orcaEnvironmentId,
        defaultRemotePath: defaultRemotePath.trim() || undefined
      })
      onClose()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div class="modal-backdrop" onClick={onClose}>
      <form class="modal-card" onClick={(e) => e.stopPropagation()} onSubmit={(e) => void submit(e)}>
        <h3>{isOrcaEnvBinding ? `Vincular SSH — ${initial?.name}` : initial?.id ? 'Editar conexão SSH' : 'Nova conexão SSH / SFTP'}</h3>
        {isOrcaEnvBinding && (
          <p class="modal-desc">
            Este Servidor Orca Remoto já foi detectado pela VPN ({initial?.hostname || 'endpoint'}).
            Informe como abrir o SFTP uma única vez; o vínculo ficará salvo com segurança.
          </p>
        )}

        <div class="field">
          <label>Nome exibido</label>
          <input value={name} placeholder="Ex.: Servidor Produção" onInput={(e) => setName((e.target as HTMLInputElement).value)} />
        </div>

        <div class="field">
          <label>Autenticação</label>
          <select value={authMethod} onChange={(e) => setAuthMethod((e.target as HTMLSelectElement).value as AuthMethod)}>
            <option value="openssh">OpenSSH / ~/.ssh/config (herda ProxyJump e chaves)</option>
            <option value="agent">SSH Agent (chaves carregadas no macOS/Linux)</option>
            <option value="key">Arquivo de chave privada (.pem / id_ed25519)</option>
            <option value="password">Usuário e senha (salva no Keychain da Orca)</option>
          </select>
        </div>

        {authMethod === 'openssh' ? (
          <div class="field">
            <label>Alias do ~/.ssh/config ou user@host</label>
            <input
              value={sshAlias}
              placeholder="Ex.: prod-server ou user@192.0.2.10"
              onInput={(e) => setSshAlias((e.target as HTMLInputElement).value)}
            />
          </div>
        ) : (
          <>
            <div class="field-row">
              <div class="field">
                <label>Host / IP (inclusive IP VPN)</label>
                <input
                  value={hostname}
                  placeholder="100.x.y.z ou dominio.com"
                  onInput={(e) => setHostname((e.target as HTMLInputElement).value)}
                />
              </div>
              <div class="field">
                <label>Porta</label>
                <input value={port} type="number" onInput={(e) => setPort((e.target as HTMLInputElement).value)} />
              </div>
            </div>

            <div class="field">
              <label>Usuário</label>
              <input value={username} placeholder="root" onInput={(e) => setUsername((e.target as HTMLInputElement).value)} />
            </div>
          </>
        )}

        {authMethod === 'key' && (
          <>
            <div class="field">
              <label>Caminho da chave privada</label>
              <input
                value={identityFile}
                placeholder="~/.ssh/id_ed25519"
                onInput={(e) => setIdentityFile((e.target as HTMLInputElement).value)}
              />
            </div>
            <div class="field">
              <label>Passphrase da chave (opcional)</label>
              <input
                type="password"
                value={secret}
                placeholder={initial?.hasSecret ? '•••••••• (mantém atual se vazio)' : 'Opcional'}
                onInput={(e) => setSecret((e.target as HTMLInputElement).value)}
              />
            </div>
          </>
        )}

        {authMethod === 'password' && (
          <div class="field">
            <label>Senha SSH (salva criptografada no keyring)</label>
            <input
              type="password"
              value={secret}
              placeholder={initial?.hasSecret ? '•••••••• (mantém atual se vazio)' : 'Digite a senha'}
              onInput={(e) => setSecret((e.target as HTMLInputElement).value)}
            />
          </div>
        )}

        <div class="field">
          <label>Diretório remoto inicial (opcional)</label>
          <input
            value={defaultRemotePath}
            placeholder="/root ou /var/www"
            onInput={(e) => setDefaultRemotePath((e.target as HTMLInputElement).value)}
          />
        </div>

        {error && <div style={{ color: 'var(--danger)', fontSize: '11.5px' }}>{error}</div>}

        <div class="modal-actions">
          {initial?.id && initial.kind === 'manual' && onDelete && (
            <button
              type="button"
              class="btn danger"
              style={{ marginRight: 'auto' }}
              disabled={busy}
              onClick={() => void onDelete(initial.id!).then(onClose)}
            >
              Excluir
            </button>
          )}
          <button type="button" class="btn ghost" onClick={onClose}>
            Cancelar
          </button>
          <button type="submit" class="btn primary" disabled={busy}>
            {busy ? 'Salvando...' : 'Salvar e conectar'}
          </button>
        </div>
      </form>
    </div>
  )
}

export function PromptModal({
  title,
  description,
  label,
  initialValue,
  placeholder,
  confirmLabel,
  onConfirm,
  onClose
}: {
  title: string
  description?: string
  label: string
  initialValue?: string
  placeholder?: string
  confirmLabel: string
  onConfirm: (value: string) => Promise<void>
  onClose: () => void
}) {
  const [value, setValue] = useState(initialValue || '')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const submit = async (e: Event) => {
    e.preventDefault()
    if (!value.trim()) {
      setError('Preencha o campo antes de continuar.')
      return
    }
    setBusy(true)
    setError(null)
    try {
      await onConfirm(value.trim())
      onClose()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div class="modal-backdrop" onClick={onClose}>
      <form class="modal-card" onClick={(e) => e.stopPropagation()} onSubmit={(e) => void submit(e)}>
        <h3>{title}</h3>
        {description && <p class="modal-desc">{description}</p>}
        <div class="field">
          <label>{label}</label>
          <input
            value={value}
            placeholder={placeholder}
            autoFocus
            onInput={(e) => setValue((e.target as HTMLInputElement).value)}
          />
        </div>
        {error && <div style={{ color: 'var(--danger)', fontSize: '11.5px' }}>{error}</div>}
        <div class="modal-actions">
          <button type="button" class="btn ghost" onClick={onClose}>
            Cancelar
          </button>
          <button type="submit" class="btn primary" disabled={busy}>
            {busy ? 'Processando...' : confirmLabel}
          </button>
        </div>
      </form>
    </div>
  )
}

export function CompressModal({
  side,
  entries,
  defaultFormat,
  onConfirm,
  onClose
}: {
  side: Side
  entries: FileEntry[]
  defaultFormat: ArchiveFormat
  onConfirm: (archiveName: string, format: ArchiveFormat) => Promise<void>
  onClose: () => void
}) {
  const baseName = entries.length === 1 ? entries[0].name : `archive-${new Date().toISOString().slice(0, 10)}`
  const [format, setFormat] = useState<ArchiveFormat>(defaultFormat)
  const [archiveName, setArchiveName] = useState(baseName)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const submit = async (e: Event) => {
    e.preventDefault()
    if (!archiveName.trim()) {
      setError('Informe o nome do arquivo compactado.')
      return
    }
    setBusy(true)
    setError(null)
    try {
      await onConfirm(archiveName.trim(), format)
      onClose()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div class="modal-backdrop" onClick={onClose}>
      <form class="modal-card" onClick={(e) => e.stopPropagation()} onSubmit={(e) => void submit(e)}>
        <h3>Compactar {side === 'remote' ? 'no servidor remoto' : 'localmente'}</h3>
        <p class="modal-desc">
          {entries.length === 1
            ? `Item selecionado: ${entries[0].name}`
            : `${entries.length} itens selecionados serão compactados diretamente ${side === 'remote' ? 'no servidor' : 'na pasta atual'}.`}
        </p>

        <div class="field">
          <label>Formato</label>
          <select value={format} onChange={(e) => setFormat((e.target as HTMLSelectElement).value as ArchiveFormat)}>
            <option value="zip">ZIP (.zip)</option>
            <option value="tar.gz">TAR GZIP (.tar.gz)</option>
          </select>
        </div>

        <div class="field">
          <label>Nome do arquivo de saída</label>
          <input
            value={archiveName}
            autoFocus
            onInput={(e) => setArchiveName((e.target as HTMLInputElement).value)}
          />
        </div>

        {error && <div style={{ color: 'var(--danger)', fontSize: '11.5px' }}>{error}</div>}

        <div class="modal-actions">
          <button type="button" class="btn ghost" onClick={onClose}>
            Cancelar
          </button>
          <button type="submit" class="btn primary" disabled={busy}>
            {busy ? 'Compactando...' : `Compactar (.${format})`}
          </button>
        </div>
      </form>
    </div>
  )
}

export function ConfirmDeleteModal({
  side,
  entries,
  onConfirm,
  onClose
}: {
  side: Side
  entries: FileEntry[]
  onConfirm: () => Promise<void>
  onClose: () => void
}) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const handleConfirm = async () => {
    setBusy(true)
    setError(null)
    try {
      await onConfirm()
      onClose()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div class="modal-backdrop" onClick={onClose}>
      <div class="modal-card" onClick={(e) => e.stopPropagation()}>
        <h3>Confirmar exclusão ({side === 'remote' ? 'Remoto' : 'Local'})</h3>
        <p class="modal-desc">
          {entries.length === 1
            ? `Tem certeza que deseja excluir permanentemente "${entries[0].name}"${entries[0].isDirectory ? ' e todo o seu conteúdo' : ''}?`
            : `Tem certeza que deseja excluir permanentemente ${entries.length} itens selecionados (incluindo conteúdo de pastas)?`}
        </p>
        {error && <div style={{ color: 'var(--danger)', fontSize: '11.5px' }}>{error}</div>}
        <div class="modal-actions">
          <button class="btn ghost" onClick={onClose}>
            Cancelar
          </button>
          <button class="btn danger" disabled={busy} onClick={() => void handleConfirm()}>
            {busy ? 'Excluindo...' : 'Excluir permanentemente'}
          </button>
        </div>
      </div>
    </div>
  )
}

export function ConflictModal({
  direction,
  totalCount,
  conflicts,
  onRequestDiff,
  onOverwrite,
  onRename,
  onSkip,
  onClose
}: {
  direction: TransferDirection
  totalCount: number
  conflicts: TransferConflict[]
  onRequestDiff: (conflict: TransferConflict) => Promise<ConflictDiffResult>
  onOverwrite: (backupBeforeOverwrite: boolean) => Promise<void>
  onRename: (customNames: Record<string, string>) => Promise<void>
  onSkip: () => Promise<void>
  onClose: () => void
}) {
  const single = conflicts.length === 1 ? conflicts[0] : null
  const [customName, setCustomName] = useState(single ? single.suggestedName : '')
  const [backupBak, setBackupBak] = useState(true)
  const [diffByPath, setDiffByPath] = useState<Record<string, ConflictDiffResult>>({})
  const [diffLoading, setDiffLoading] = useState<string | null>(null)
  const [openDiffPath, setOpenDiffPath] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const destLabel = direction === 'upload' ? 'no servidor remoto' : 'no diretório local'
  const nonConflictingCount = Math.max(0, totalCount - conflicts.length)

  const runAction = async (fn: () => Promise<void>) => {
    setBusy(true)
    setError(null)
    try {
      await fn()
      onClose()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  const toggleDiff = async (conflict: TransferConflict) => {
    if (openDiffPath === conflict.sourcePath) {
      setOpenDiffPath(null)
      return
    }
    if (diffByPath[conflict.sourcePath]) {
      setOpenDiffPath(conflict.sourcePath)
      return
    }
    setDiffLoading(conflict.sourcePath)
    setError(null)
    try {
      const res = await onRequestDiff(conflict)
      setDiffByPath((prev) => ({ ...prev, [conflict.sourcePath]: res }))
      setOpenDiffPath(conflict.sourcePath)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setDiffLoading(null)
    }
  }

  const activeDiff = openDiffPath ? diffByPath[openDiffPath] : null

  return (
    <div class="modal-backdrop" onClick={onClose}>
      <div
        class="modal-card"
        style={{ maxWidth: activeDiff ? '560px' : '420px' }}
        onClick={(e) => e.stopPropagation()}
      >
        <h3>Arquivo já existe {destLabel}</h3>
        <p class="modal-desc">
          {single
            ? `"${single.name}" já existe no destino. Compare as diferenças, renomeie para manter ambos ou substitua com backup .bak.`
            : `${conflicts.length} item(ns) já existem no destino. Escolha como prosseguir para evitar sobrescrita acidental.`}
        </p>

        <div class="conflict-box">
          {conflicts.map((c) => (
            <div key={c.sourcePath} class="conflict-item">
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '6px' }}>
                <strong>{c.name}</strong>
                {!c.isDirectory && !c.targetIsDirectory && (
                  <button
                    type="button"
                    class={`btn xs ${openDiffPath === c.sourcePath ? 'primary' : ''}`}
                    disabled={diffLoading === c.sourcePath}
                    onClick={() => void toggleDiff(c)}
                  >
                    {diffLoading === c.sourcePath
                      ? 'Comparando...'
                      : openDiffPath === c.sourcePath
                        ? 'Ocultar Diff'
                        : 'Ver Diff'}
                  </button>
                )}
              </div>
              <div class="conflict-meta">
                <div>
                  <div>Origem ({direction === 'upload' ? 'Local' : 'Remoto'})</div>
                  <div>
                    {c.isDirectory ? 'Pasta' : formatBytes(c.sourceSize)}
                    {c.sourceMtimeMs ? ` · ${formatTimestamp(c.sourceMtimeMs)}` : ''}
                  </div>
                </div>
                <div>
                  <div>Existente ({direction === 'upload' ? 'Remoto' : 'Local'})</div>
                  <div>
                    {c.targetIsDirectory ? 'Pasta' : formatBytes(c.targetSize)}
                    {c.targetMtimeMs ? ` · ${formatTimestamp(c.targetMtimeMs)}` : ''}
                  </div>
                </div>
              </div>
            </div>
          ))}
        </div>

        {activeDiff && (
          <div class="diff-box">
            {activeDiff.binary ? (
              <div class="diff-empty">
                Arquivo binário — Origem: {formatBytes(activeDiff.sourceSize)} · Existente:{' '}
                {formatBytes(activeDiff.targetSize)}
              </div>
            ) : activeDiff.tooLarge ? (
              <div class="diff-empty">
                Arquivo maior que 256 KB para diff rápido — Origem: {formatBytes(activeDiff.sourceSize)} ·
                Existente: {formatBytes(activeDiff.targetSize)}
              </div>
            ) : activeDiff.lines.length === 0 ? (
              <div class="diff-empty">Os arquivos têm conteúdo idêntico!</div>
            ) : (
              <>
                <div class="diff-header">
                  <span>Existente → Novo</span>
                  <span>
                    <span class="diff-stat-add">+{activeDiff.added}</span>{' '}
                    <span class="diff-stat-rem">-{activeDiff.removed}</span>
                    {activeDiff.truncated ? ' (truncado)' : ''}
                  </span>
                </div>
                <div class="diff-lines">
                  {activeDiff.lines.map((line, i) => (
                    <div key={i} class={`diff-line ${line.kind}`}>
                      <span class="diff-sign">
                        {line.kind === 'add' ? '+' : line.kind === 'remove' ? '-' : ' '}
                      </span>
                      <span class="diff-text">{line.text || ' '}</span>
                    </div>
                  ))}
                </div>
              </>
            )}
          </div>
        )}

        {single && (
          <div class="field">
            <label>Novo nome para salvar sem substituir</label>
            <input
              value={customName}
              onInput={(e) => setCustomName((e.target as HTMLInputElement).value)}
            />
          </div>
        )}

        <label class="checkbox-row">
          <input
            type="checkbox"
            checked={backupBak}
            onChange={(e) => setBackupBak((e.target as HTMLInputElement).checked)}
          />
          <span>Criar backup `.bak` do arquivo existente antes de substituir</span>
        </label>

        {error && <div style={{ color: 'var(--danger)', fontSize: '11.5px' }}>{error}</div>}

        <div class="modal-actions" style={{ flexWrap: 'wrap' }}>
          <button class="btn ghost" disabled={busy} onClick={onClose}>
            Cancelar
          </button>
          {nonConflictingCount > 0 && (
            <button class="btn" disabled={busy} onClick={() => void runAction(onSkip)}>
              Pular ({nonConflictingCount} novo{nonConflictingCount > 1 ? 's' : ''})
            </button>
          )}
          <button
            class="btn danger"
            disabled={busy}
            onClick={() => void runAction(() => onOverwrite(backupBak))}
          >
            {backupBak ? 'Backup .bak e Substituir' : 'Substituir'}
          </button>
          <button
            class="btn primary"
            disabled={busy || (Boolean(single) && !customName.trim())}
            onClick={() =>
              void runAction(async () => {
                const map: Record<string, string> = {}
                if (single) {
                  map[single.sourcePath] = customName.trim()
                } else {
                  for (const c of conflicts) map[c.sourcePath] = c.suggestedName
                }
                await onRename(map)
              })
            }
          >
            {single ? 'Renomear e manter ambos' : 'Renomear conflitantes'}
          </button>
        </div>
      </div>
    </div>
  )
}
