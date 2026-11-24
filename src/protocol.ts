import type {
  ArchiveFormat,
  BookmarkEntry,
  ConflictDiffResult,
  ConnectionStatus,
  EditorFilePayload,
  FileEntry,
  HostProfile,
  HostSftpState,
  ImagePreviewPayload,
  PersistedSessionState,
  PluginUserSettings,
  SaveHostInput,
  SearchResultEntry,
  Side,
  TransferConflict,
  TransferDirection,
  TransferPriority,
  TransferSnapshot,
  WorkspaceHint
} from './shared/types.ts'

export {}

declare module 'orca' {
  interface PluginRequests {
    // Bootstrap & settings
    'app.bootstrap': {
      output: {
        localHome: string
        settings: PluginUserSettings
        hosts: HostProfile[]
        connection: ConnectionStatus
        hostStates: Record<string, HostSftpState>
        transfers: TransferSnapshot
        bookmarks: BookmarkEntry[]
        workspaceHint: WorkspaceHint
        session: PersistedSessionState
      }
    }
    'session.save': {
      input: Partial<PersistedSessionState>
      output: { session: PersistedSessionState }
    }

    // Host discovery & connection management
    'hosts.list': {
      output: { hosts: HostProfile[]; hostStates: Record<string, HostSftpState> }
    }
    'hosts.save': {
      input: SaveHostInput
      output: { host: HostProfile; hosts: HostProfile[] }
    }
    'hosts.delete': {
      input: { hostId: string }
      output: { hosts: HostProfile[] }
    }
    'connection.connect': {
      input: { hostId: string; forceReconnect?: boolean }
      output: {
        connection: ConnectionStatus
        hostState: HostSftpState
        hostStates: Record<string, HostSftpState>
        remotePath: string
        entries: FileEntry[]
      }
    }
    'connection.disconnect': {
      input: { hostId?: string }
      output: { connection: ConnectionStatus; hostStates: Record<string, HostSftpState> }
    }

    // File system navigation & CRUD (local or remote)
    'fs.list': {
      input: { side: Side; path?: string; hostId?: string }
      output: { side: Side; path: string; entries: FileEntry[] }
    }
    'fs.mkdir': {
      input: { side: Side; parentPath: string; name: string; hostId?: string }
      output: { createdPath: string }
    }
    'fs.createFile': {
      input: { side: Side; parentPath: string; name: string; content?: string; hostId?: string }
      output: { createdPath: string }
    }
    'fs.rename': {
      input: { side: Side; oldPath: string; newName: string; hostId?: string }
      output: { newPath: string }
    }
    'fs.delete': {
      input: { side: Side; paths: string[]; hostId?: string }
      output: { deletedCount: number }
    }
    'fs.chmod': {
      input: { side: Side; path: string; mode: string; hostId?: string }
      output: { ok: true }
    }
    'fs.search': {
      input: { side: Side; rootPath: string; query: string; hostId?: string; maxResults?: number }
      output: { results: SearchResultEntry[]; truncated: boolean }
    }

    // Finder / browser-file chunked upload (works even when isolated iframe strips File.path)
    'fs.uploadChunkInit': {
      input: {
        hostId?: string
        targetDir: string
        name: string
        backupBeforeOverwrite?: boolean
      }
      output: { uploadId: string; targetPath: string }
    }
    'fs.uploadChunkWrite': {
      input: { uploadId: string; offset: number; dataBase64: string }
      output: { bytesWritten: number }
    }
    'fs.uploadChunkFinish': {
      input: { uploadId: string; cancel?: boolean }
      output: { targetPath: string; ok: true }
    }

    // Preview & Live Tail
    'preview.readImage': {
      input: { side: Side; path: string; hostId?: string }
      output: ImagePreviewPayload
    }
    'tail.start': {
      input: { side: Side; path: string; hostId?: string; lines?: number }
      output: { tailId: string; path: string; side: Side }
    }
    'tail.stop': {
      input: { tailId: string }
      output: { ok: true }
    }

    // Archive / Extract (server-side or local)
    'fs.compress': {
      input: {
        side: Side
        cwd: string
        names: string[]
        archiveName: string
        format: ArchiveFormat
        hostId?: string
      }
      output: { archivePath: string }
    }
    'fs.extract': {
      input: {
        side: Side
        archivePath: string
        destinationDir: string
        createSubfolder?: boolean
        hostId?: string
      }
      output: { extractedTo: string }
    }

    // Quick text editor
    'editor.read': {
      input: { side: Side; path: string; hostId?: string; forceText?: boolean }
      output: EditorFilePayload
    }
    'editor.write': {
      input: { side: Side; path: string; content: string; hostId?: string }
      output: { mtimeMs: number; size: number }
    }

    // Transfer queue
    'transfers.checkConflicts': {
      input: {
        hostId?: string
        sourceSide?: Side
        sourceHostId?: string
        targetSide?: Side
        targetHostId?: string
        direction: TransferDirection
        items: {
          sourcePath: string
          targetDir: string
          isDirectory: boolean
          name: string
          size?: number
          mtimeMs?: number
        }[]
      }
      output: { conflicts: TransferConflict[] }
    }
    'transfers.diffConflict': {
      input: {
        hostId?: string
        sourceSide?: Side
        sourceHostId?: string
        targetSide?: Side
        targetHostId?: string
        direction: TransferDirection
        sourcePath: string
        targetPath: string
      }
      output: ConflictDiffResult
    }
    'transfers.enqueue': {
      input: {
        hostId?: string
        sourceSide?: Side
        sourceHostId?: string
        targetSide?: Side
        targetHostId?: string
        direction: TransferDirection
        items: {
          sourcePath: string
          targetDir: string
          isDirectory: boolean
          name: string
          targetName?: string
          backupBeforeOverwrite?: boolean
          size?: number
        }[]
        priority?: TransferPriority
      }
      output: { snapshot: TransferSnapshot }
    }
    'transfers.list': {
      output: { snapshot: TransferSnapshot }
    }
    'transfers.action': {
      input: {
        action: 'pause' | 'resume' | 'cancel' | 'retry' | 'remove' | 'pauseAll' | 'resumeAll' | 'clearCompleted'
        transferId?: string
      }
      output: { snapshot: TransferSnapshot }
    }
    'transfers.setPriority': {
      input: {
        transferId: string
        priority: TransferPriority
      }
      output: { snapshot: TransferSnapshot }
    }
    'transfers.reorder': {
      input: {
        transferId: string
        move: 'top' | 'up' | 'down' | 'bottom'
      }
      output: { snapshot: TransferSnapshot }
    }

    // Bookmarks
    'bookmarks.toggle': {
      input: { side: Side; path: string; label: string; hostId?: string }
      output: { bookmarks: BookmarkEntry[] }
    }
  }

  interface PluginPanelEvents {
    'transfers.updated': TransferSnapshot
    'connection.updated': ConnectionStatus
    'hostStates.updated': Record<string, HostSftpState>
    'workspace.hint': WorkspaceHint
    'hosts.updated': { hosts: HostProfile[] }
    'tail.data': { tailId: string; chunk: string }
    'tail.closed': { tailId: string; reason?: string }
    'quickHub.toggle': { open?: boolean }
  }
}
