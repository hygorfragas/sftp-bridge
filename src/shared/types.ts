export type Side = 'local' | 'remote'

export type LayoutMode = 'tabs' | 'split'

export type HostKind = 'orca-ssh' | 'orca-env' | 'ssh-config' | 'manual'

export type AuthMethod = 'openssh' | 'agent' | 'key' | 'password'

export interface HostProfile {
  id: string
  name: string
  kind: HostKind
  /** Display badge / source info */
  sourceLabel: string
  /** Whether Orca currently reports this host as connected */
  connected?: boolean
  /** OpenSSH alias (from Orca SSH host or ~/.ssh/config) */
  sshAlias?: string
  /** Resolved hostname or VPN IP */
  hostname?: string
  port?: number
  username?: string
  identityFile?: string
  authMethod: AuthMethod
  /** Orca environment metadata when kind === 'orca-env' */
  orcaEnvironmentId?: string
  orcaSshTargetId?: string
  orcaEndpoint?: string
  /** Live VPN/direct IP extracted from Orca's connected environment endpoint */
  orcaVpnHost?: string
  /** True when an Orca Remote Server (VPN) still needs user/SSH binding */
  needsSshBinding?: boolean
  /** Suggested default remote directory (e.g. from active workspace) */
  defaultRemotePath?: string
  /** Whether a password or passphrase is stored in secrets:own */
  hasSecret?: boolean
}

export interface PersistedSessionState {
  lastHostId: string | null
  wasConnected: boolean
  lastLocalPath: string | null
  remotePathsByHost: Record<string, string>
  activeTab: 'local' | 'remote' | 'transfers'
  layout?: LayoutMode
  splitRatio?: number
  syncBrowsing?: boolean
}

export interface SaveHostInput {
  id?: string
  name: string
  hostname: string
  port?: number
  username: string
  authMethod: AuthMethod
  sshAlias?: string
  identityFile?: string
  password?: string
  passphrase?: string
  orcaEnvironmentId?: string
  defaultRemotePath?: string
}

export interface FileEntry {
  name: string
  path: string
  isDirectory: boolean
  isSymlink: boolean
  size: number
  mtimeMs: number
  mode: number
  permissions: string
  owner?: string
  isHidden: boolean
  isArchive: boolean
  archiveType: ArchiveType | null
  isEditableText: boolean
  isImage?: boolean
  isLogFile?: boolean
  isMarkdown?: boolean
}

export interface DiffLine {
  kind: 'same' | 'add' | 'remove'
  oldLine?: number
  newLine?: number
  text: string
}

export interface ConflictDiffResult {
  binary: boolean
  tooLarge?: boolean
  sourceSize: number
  targetSize: number
  added: number
  removed: number
  truncated?: boolean
  lines: DiffLine[]
}

export interface SearchResultEntry {
  name: string
  path: string
  relativePath: string
  parentDir: string
  isDirectory: boolean
  isEditableText: boolean
  isImage: boolean
}

export interface ImagePreviewPayload {
  side: Side
  hostId?: string
  path: string
  name: string
  mimeType: string
  dataUrl: string
  size: number
}

export type ArchiveFormat = 'zip' | 'tar.gz'

export type ArchiveType =
  | 'zip'
  | 'tar.gz'
  | 'tgz'
  | 'tar'
  | 'tar.bz2'
  | 'tar.xz'
  | 'gz'
  | '7z'
  | 'rar'

export type TransferDirection = 'upload' | 'download'

export type TransferStatus =
  | 'queued'
  | 'running'
  | 'paused'
  | 'completed'
  | 'error'
  | 'cancelled'

export type TransferPriority = 'high' | 'normal' | 'low'

export interface TransferItem {
  id: string
  hostId: string
  hostName: string
  direction: TransferDirection
  sourcePath: string
  targetPath: string
  name: string
  isDirectory: boolean
  status: TransferStatus
  priority: TransferPriority
  order: number
  bytesTransferred: number
  totalBytes: number
  speedBps: number
  etaSeconds: number | null
  filesCompleted: number
  filesTotal: number
  error?: string
  createdAt: number
  updatedAt: number
}

export interface TransferConflict {
  sourcePath: string
  targetPath: string
  name: string
  isDirectory: boolean
  sourceSize: number
  sourceMtimeMs?: number
  targetSize: number
  targetMtimeMs: number
  targetIsDirectory: boolean
  suggestedName: string
}

export interface TransferSnapshot {
  items: TransferItem[]
  activeCount: number
  queuedCount: number
  pausedCount: number
  errorCount: number
  completedCount: number
  maxConcurrent: number
}

export interface BookmarkEntry {
  id: string
  side: Side
  hostId?: string
  label: string
  path: string
}

export interface ConnectionStatus {
  hostId: string | null
  hostName: string | null
  connected: boolean
  connecting: boolean
  transportMode?: 'openssh-sftp' | 'ssh2-sftp'
  remoteHome?: string
  error?: string
}

export interface PluginUserSettings {
  defaultLayout: LayoutMode
  maxConcurrentTransfers: number
  showHiddenFiles: boolean
  defaultArchiveFormat: ArchiveFormat
  notifyOnQueueComplete: boolean
  maxEditableFileKB: number
}

export interface EditorFilePayload {
  side: Side
  hostId?: string
  path: string
  name: string
  content: string
  size: number
  mtimeMs: number
  encoding: 'utf-8'
  readonly?: boolean
}

export interface WorkspaceHint {
  localPath: string | null
  remotePath: string | null
  hostId: string | null
  workspaceName: string | null
}
