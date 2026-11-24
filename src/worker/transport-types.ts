import type { ArchiveFormat, EditorFilePayload, FileEntry, SearchResultEntry } from '../shared/types.ts'

export interface TailHandle {
  stop: () => void
}

export interface RemoteStat {
  size: number
  mtimeMs: number
  mode: number
  isDirectory: boolean
  isSymlink: boolean
}

export interface RemoteTransport {
  readonly hostId: string
  readonly hostName: string
  readonly mode: 'openssh-sftp' | 'ssh2-sftp'
  readonly isAlive: boolean
  realpath(remotePath: string): Promise<string>
  listDir(remotePath: string): Promise<{ path: string; entries: FileEntry[] }>
  stat(remotePath: string): Promise<RemoteStat>
  mkdir(parentPath: string, name: string): Promise<string>
  mkdirRecursive(remotePath: string): Promise<void>
  createFile(parentPath: string, name: string, content?: string): Promise<string>
  rename(oldPath: string, newName: string): Promise<string>
  renameExact(oldPath: string, newPath: string): Promise<void>
  deletePaths(paths: string[]): Promise<number>
  chmod(remotePath: string, modeStr: string): Promise<void>
  readText(remotePath: string, maxBytes: number, forceText?: boolean): Promise<EditorFilePayload>
  readBytes(remotePath: string, maxBytes: number): Promise<Buffer>
  writeText(remotePath: string, content: string): Promise<{ mtimeMs: number; size: number }>
  openHandle(remotePath: string, flags: number): Promise<Buffer>
  readChunk(handle: Buffer, buffer: Buffer, offset: number, length: number, position: number): Promise<number>
  writeChunk(handle: Buffer, buffer: Buffer, offset: number, length: number, position: number): Promise<void>
  closeHandle(handle: Buffer): Promise<void>
  unlink(remotePath: string): Promise<void>
  compress(cwd: string, names: string[], archiveName: string, format: ArchiveFormat): Promise<string>
  extract(archivePath: string, destinationDir: string, createSubfolder?: boolean): Promise<string>
  searchRecursive(rootPath: string, query: string, maxResults?: number): Promise<{ results: SearchResultEntry[]; truncated: boolean }>
  startTail(
    remotePath: string,
    lines: number,
    onChunk: (chunk: string) => void,
    onClose: (reason?: string) => void
  ): TailHandle
  destroy(): void
}

/** Standard SFTP v3 FXF_OPEN bitmask flags (draft-ietf-secsh-filexfer-02) */
export const SFTP_OPEN_FLAGS = {
  READ: 0x00000001,
  WRITE_CREATE_TRUNC: 0x00000002 | 0x00000008 | 0x00000010,
  WRITE_CREATE_RESUME: 0x00000002 | 0x00000008
} as const
