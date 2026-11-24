import { type ChildProcessWithoutNullStreams, execFile, spawn } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { Client as Ssh2Client, type ConnectConfig, type SFTPWrapper } from 'ssh2'
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore internal ssh2 SFTP protocol module (pure JS)
import { SFTP as SftpProtocol } from 'ssh2/lib/protocol/SFTP.js'
import {
  detectArchiveType,
  formatModeRwx,
  isEditableTextFile,
  isLogFilename,
  isMarkdownFile,
  isPreviewableImage,
  looksBinary,
  posixBasename,
  posixDirname,
  posixJoin,
  shellQuotePosix
} from '../shared/file-utils.ts'
import type {
  ArchiveFormat,
  EditorFilePayload,
  FileEntry,
  HostProfile,
  SearchResultEntry
} from '../shared/types.ts'
import { buildCompressCommand, buildExtractCommand } from './archive-commands.ts'
import { type RemoteStat, type RemoteTransport, SFTP_OPEN_FLAGS, type TailHandle } from './transport-types.ts'

export { type RemoteStat, type RemoteTransport, SFTP_OPEN_FLAGS }

const S_IFMT = 0o170000
const S_IFDIR = 0o040000
const S_IFLNK = 0o120000

function isDirMode(mode: number): boolean {
  return (mode & S_IFMT) === S_IFDIR
}

function isLinkMode(mode: number): boolean {
  return (mode & S_IFMT) === S_IFLNK
}

function expandHome(p: string): string {
  return p.startsWith('~/') ? join(homedir(), p.slice(2)) : p
}

interface SftpLike {
  on(event: string, listener: (...args: unknown[]) => void): unknown
  once(event: string, listener: (...args: unknown[]) => void): unknown
  realpath(path: string, cb: (err: Error | undefined, absPath: string) => void): void
  readdir(path: string, cb: (err: Error | undefined, list: Array<{ filename: string; longname?: string; attrs: { size: number; mtime: number; mode: number; uid?: number } }>) => void): void
  stat(path: string, cb: (err: Error | undefined, stats: { size: number; mtime: number; mode: number }) => void): void
  lstat(path: string, cb: (err: Error | undefined, stats: { size: number; mtime: number; mode: number }) => void): void
  mkdir(path: string, cb: (err?: Error) => void): void
  rmdir(path: string, cb: (err?: Error) => void): void
  unlink(path: string, cb: (err?: Error) => void): void
  rename(srcPath: string, destPath: string, cb: (err?: Error) => void): void
  chmod(path: string, mode: number | string, cb: (err?: Error) => void): void
  open(path: string, flags: number | string, cb: (err: Error | undefined, handle: Buffer) => void): void
  read(handle: Buffer, buf: Buffer, offset: number, length: number, position: number, cb: (err: Error | undefined, bytesRead: number) => void): void
  write(handle: Buffer, buf: Buffer, offset: number, length: number, position: number, cb: (err?: Error) => void): void
  close(handle: Buffer, cb: (err?: Error) => void): void
  end(): void
}

interface OpenSshTarget {
  target: string
  extraArgs: string[]
}

function makeBaseOpenSshArgs(timeoutSec = 10): string[] {
  return [
    '-T',
    '-o',
    'BatchMode=yes',
    '-o',
    'StrictHostKeyChecking=accept-new',
    '-o',
    `ConnectTimeout=${timeoutSec}`,
    '-o',
    'ServerAliveInterval=20',
    '-o',
    'ServerAliveCountMax=3'
  ]
}

function buildDirectOpenSshTarget(
  host: string,
  username: string | undefined,
  port: number | undefined,
  identityFile: string | undefined,
  timeoutSec = 10
): OpenSshTarget {
  const extraArgs = makeBaseOpenSshArgs(timeoutSec)
  if (port && port !== 22) {
    extraArgs.push('-p', String(port))
  }
  if (identityFile) {
    extraArgs.push('-i', expandHome(identityFile))
  }
  const target = username ? `${username}@${host}` : host
  return { target, extraArgs }
}

/**
 * Builds ordered OpenSSH targets for a HostProfile:
 * - For Orca Remote Servers with a live VPN IP (`orcaVpnHost`), tries the live VPN IP FIRST
 *   (avoiding stale MagicDNS `.ts.net` entries in ~/.ssh/config), while keeping user/port/identityFile.
 * - Falls back to the ~/.ssh/config alias (which handles ProxyJump / custom Match rules).
 * - When no username is known for a VPN server, tries `root` and the local OS username automatically.
 */
function buildOpenSshCandidates(profile: HostProfile): OpenSshTarget[] {
  const candidates: OpenSshTarget[] = []
  const seen = new Set<string>()
  const pushUnique = (t: OpenSshTarget) => {
    const key = `${t.target}|${t.extraArgs.join(' ')}`
    if (!seen.has(key)) {
      seen.add(key)
      candidates.push(t)
    }
  }

  const localUser = process.env.USER || process.env.USERNAME

  // 1. Live VPN IP directly from Orca's connected environment endpoint (highest reliability behind VPN)
  if (profile.orcaVpnHost) {
    if (profile.username) {
      pushUnique(
        buildDirectOpenSshTarget(
          profile.orcaVpnHost,
          profile.username,
          profile.port,
          profile.identityFile,
          8
        )
      )
    } else {
      pushUnique(buildDirectOpenSshTarget(profile.orcaVpnHost, 'root', profile.port, profile.identityFile, 8))
      if (localUser && localUser !== 'root') {
        pushUnique(
          buildDirectOpenSshTarget(profile.orcaVpnHost, localUser, profile.port, profile.identityFile, 8)
        )
      }
    }
  }

  // 2. ~/.ssh/config alias (supports ProxyJump, ProxyCommand, custom IdentityFile)
  if (profile.sshAlias) {
    pushUnique({ target: profile.sshAlias, extraArgs: makeBaseOpenSshArgs(10) })
  }

  // 3. Explicit hostname fallback (if different from alias/vpnHost)
  if (profile.hostname && profile.hostname !== profile.orcaVpnHost) {
    pushUnique(
      buildDirectOpenSshTarget(
        profile.hostname,
        profile.username || 'root',
        profile.port,
        profile.identityFile,
        10
      )
    )
  }

  return candidates
}

/**
 * Opens an SFTP v3 binary channel directly over the local system OpenSSH client.
 * Inherits ~/.ssh/config, ProxyJump, ssh-agent, macOS Keychain, and active VPN routes.
 */
async function createOpenSshSftpSession(sshTarget: OpenSshTarget): Promise<{
  sftp: SftpLike
  execCommand: (cmd: string) => Promise<string>
  streamCommand: (cmd: string, onChunk: (chunk: string) => void, onClose: (reason?: string) => void) => TailHandle
  destroy: () => void
  onClose: (cb: () => void) => void
}> {
  const { target, extraArgs } = sshTarget

  return new Promise((resolvePromise, rejectPromise) => {
    const proc: ChildProcessWithoutNullStreams = spawn('ssh', [...extraArgs, target, '-s', 'sftp'], {
      stdio: ['pipe', 'pipe', 'pipe']
    })

    let stderrText = ''
    let settled = false
    const closeListeners: Array<() => void> = []

    const chanInfo = {
      type: 'session',
      incoming: { id: 0, window: 2 * 1024 * 1024, packetSize: 256 * 1024, state: 'open' },
      outgoing: { id: 0, window: 2 * 1024 * 1024, packetSize: 256 * 1024, state: 'open' }
    }

    let sftpInstance: SftpLike & {
      push: (chunk: Buffer | null) => void
      _init: () => void
      _waitWindow?: boolean
      _chunkcb?: () => void
    }

    const fakeClient = {
      _protocol: {
        _remoteIdentRaw: 'SSH-2.0-OpenSSH_9.0',
        channelData(_id: number, data: Buffer) {
          if (proc.stdin.destroyed || proc.killed) return
          const ok = proc.stdin.write(data)
          if (ok) {
            chanInfo.outgoing.window += data.length
          } else {
            proc.stdin.once('drain', () => {
              chanInfo.outgoing.window += data.length
              if (sftpInstance._waitWindow) {
                sftpInstance._waitWindow = false
                sftpInstance._chunkcb?.()
              }
            })
          }
        },
        channelClose() {
          if (!proc.stdin.destroyed) proc.stdin.end()
          if (!proc.killed) proc.kill()
        }
      }
    }

    sftpInstance = new SftpProtocol(fakeClient, chanInfo, {})

    const fail = (err: Error) => {
      if (settled) return
      settled = true
      try {
        if (!proc.killed) proc.kill()
      } catch {
        // ignore
      }
      rejectPromise(err)
    }

    const timeout = setTimeout(() => {
      fail(new Error(`Tempo esgotado conectando via SSH em "${target}". Verifique se a VPN/host está acessível.`))
    }, 18_000)

    proc.stderr.on('data', (chunk: Buffer) => {
      stderrText += chunk.toString('utf8')
    })

    proc.stdout.on('data', (chunk: Buffer) => {
      try {
        sftpInstance.push(chunk)
      } catch (err) {
        fail(err instanceof Error ? err : new Error(String(err)))
      }
    })

    proc.on('error', (err) => {
      clearTimeout(timeout)
      fail(new Error(`Falha ao iniciar OpenSSH: ${err.message}`))
    })

    proc.on('close', (code) => {
      clearTimeout(timeout)
      try {
        sftpInstance.push(null)
      } catch {
        // ignore
      }
      if (!settled) {
        const msg = stderrText.trim() || `Conexão SSH encerrada (código ${code ?? 'desconhecido'}).`
        fail(new Error(msg))
      }
      for (const cb of closeListeners) cb()
    })

    sftpInstance.once('ready', () => {
      clearTimeout(timeout)
      if (settled) return
      settled = true

      const execCommand = (cmd: string): Promise<string> =>
        new Promise((res, rej) => {
          execFile(
            'ssh',
            [...extraArgs, target, '--', cmd],
            { timeout: 180_000, maxBuffer: 4 * 1024 * 1024 },
            (err, stdout, stderr) => {
              if (err) {
                rej(new Error(stderr?.trim() || err.message || 'Erro ao executar comando remoto.'))
                return
              }
              res(stdout)
            }
          )
        })

      const streamCommand = (
        cmd: string,
        onChunk: (chunk: string) => void,
        onClose: (reason?: string) => void
      ): TailHandle => {
        const tailProc = spawn('ssh', [...extraArgs, target, '--', cmd], {
          stdio: ['ignore', 'pipe', 'pipe']
        })
        tailProc.stdout.on('data', (d: Buffer) => onChunk(d.toString('utf8')))
        tailProc.stderr.on('data', (d: Buffer) => onChunk(d.toString('utf8')))
        tailProc.on('error', (err) => onClose(err.message))
        tailProc.on('close', (code) => onClose(code ? `Stream encerrado (${code})` : undefined))
        return {
          stop: () => {
            if (!tailProc.killed) tailProc.kill('SIGTERM')
          }
        }
      }

      resolvePromise({
        sftp: sftpInstance,
        execCommand,
        streamCommand,
        destroy: () => {
          try {
            sftpInstance.end()
          } catch {
            // ignore
          }
          if (!proc.killed) proc.kill()
        },
        onClose: (cb) => {
          closeListeners.push(cb)
        }
      })
    })

    sftpInstance.on('error', (err: unknown) => {
      clearTimeout(timeout)
      fail(err instanceof Error ? err : new Error(String(err)))
    })

    // Trigger SFTP v3 handshake
    sftpInstance._init()
  })
}

/** Direct pure-JS ssh2 connection (for manual password / privateKey + passphrase hosts). */
async function createSsh2Session(
  profile: HostProfile,
  secret?: string | null,
  hostOverride?: string
): Promise<{
  sftp: SftpLike
  execCommand: (cmd: string) => Promise<string>
  streamCommand: (cmd: string, onChunk: (chunk: string) => void, onClose: (reason?: string) => void) => TailHandle
  destroy: () => void
  onClose: (cb: () => void) => void
}> {
  const client = new Ssh2Client()
  const host = hostOverride || profile.orcaVpnHost || profile.hostname || profile.sshAlias || profile.name
  const config: ConnectConfig = {
    host,
    port: profile.port || 22,
    username: profile.username || 'root',
    readyTimeout: 15_000,
    keepaliveInterval: 20_000
  }

  if (profile.authMethod === 'password') {
    if (!secret) {
      throw new Error(`Senha não configurada para "${profile.name}". Edite o host e salve a senha.`)
    }
    config.password = secret
    config.tryKeyboard = true
  } else if (profile.authMethod === 'key' && profile.identityFile) {
    config.privateKey = await readFile(expandHome(profile.identityFile))
    if (secret) config.passphrase = secret
  } else {
    if (process.env.SSH_AUTH_SOCK) {
      config.agent = process.env.SSH_AUTH_SOCK
    }
    if (profile.identityFile) {
      try {
        config.privateKey = await readFile(expandHome(profile.identityFile))
        if (secret) config.passphrase = secret
      } catch {
        // Fallback to agent
      }
    }
  }

  return new Promise((resolvePromise, rejectPromise) => {
    let settled = false
    const closeListeners: Array<() => void> = []

    const fail = (err: Error) => {
      if (settled) return
      settled = true
      try {
        client.end()
      } catch {
        // ignore
      }
      rejectPromise(err)
    }

    client.on('keyboard-interactive', (_name, _instructions, _lang, prompts, finish) => {
      finish(prompts.map(() => secret || ''))
    })

    client.on('error', (err) => fail(err))
    client.on('close', () => {
      if (!settled) fail(new Error('Conexão SSH encerrada antes de ficar pronta.'))
      for (const cb of closeListeners) cb()
    })

    client.on('ready', () => {
      client.sftp((err, sftp: SFTPWrapper) => {
        if (err) {
          fail(err)
          return
        }
        if (settled) return
        settled = true

        const execCommand = (cmd: string): Promise<string> =>
          new Promise((res, rej) => {
            client.exec(cmd, (execErr, stream) => {
              if (execErr) {
                rej(execErr)
                return
              }
              let stdout = ''
              let stderr = ''
              stream.on('data', (d: Buffer) => {
                stdout += d.toString('utf8')
              })
              stream.stderr.on('data', (d: Buffer) => {
                stderr += d.toString('utf8')
              })
              stream.on('close', (code: number | null) => {
                if (code && code !== 0) {
                  rej(new Error(stderr.trim() || `Comando remoto falhou com código ${code}.`))
                } else {
                  res(stdout)
                }
              })
            })
          })

        const streamCommand = (
          cmd: string,
          onChunk: (chunk: string) => void,
          onClose: (reason?: string) => void
        ): TailHandle => {
          let activeStream: { close?: () => void; end?: () => void; signal?: (s: string) => void } | null = null
          let stopped = false
          client.exec(cmd, (execErr, stream) => {
            if (execErr) {
              onClose(execErr.message)
              return
            }
            if (stopped) {
              stream.close()
              return
            }
            activeStream = stream
            stream.on('data', (d: Buffer) => onChunk(d.toString('utf8')))
            stream.stderr.on('data', (d: Buffer) => onChunk(d.toString('utf8')))
            stream.on('close', (code: number | null) =>
              onClose(code ? `Stream encerrado (${code})` : undefined)
            )
          })
          return {
            stop: () => {
              stopped = true
              try {
                activeStream?.signal?.('TERM')
                activeStream?.close?.()
              } catch {
                // ignore
              }
            }
          }
        }

        resolvePromise({
          sftp: sftp as unknown as SftpLike,
          execCommand,
          streamCommand,
          destroy: () => {
            try {
              sftp.end()
            } catch {
              // ignore
            }
            try {
              client.end()
            } catch {
              // ignore
            }
          },
          onClose: (cb) => {
            closeListeners.push(cb)
          }
        })
      })
    })

    client.connect(config)
  })
}

export class SshSftpTransport implements RemoteTransport {
  readonly hostId: string
  readonly hostName: string
  readonly mode: 'openssh-sftp' | 'ssh2-sftp'
  private _alive = true
  private readonly sftp: SftpLike
  private readonly execCommand: (cmd: string) => Promise<string>
  private readonly streamCommand: (
    cmd: string,
    onChunk: (chunk: string) => void,
    onClose: (reason?: string) => void
  ) => TailHandle
  private readonly destroyFn: () => void

  private constructor(params: {
    hostId: string
    hostName: string
    mode: 'openssh-sftp' | 'ssh2-sftp'
    sftp: SftpLike
    execCommand: (cmd: string) => Promise<string>
    streamCommand: (
      cmd: string,
      onChunk: (chunk: string) => void,
      onClose: (reason?: string) => void
    ) => TailHandle
    destroy: () => void
    onClose: (cb: () => void) => void
  }) {
    this.hostId = params.hostId
    this.hostName = params.hostName
    this.mode = params.mode
    this.sftp = params.sftp
    this.execCommand = params.execCommand
    this.streamCommand = params.streamCommand
    this.destroyFn = params.destroy
    params.onClose(() => {
      this._alive = false
    })
  }

  get isAlive(): boolean {
    return this._alive
  }

  static async connect(profile: HostProfile, secret?: string | null): Promise<SshSftpTransport> {
    const useOpenSsh =
      profile.authMethod === 'openssh' ||
      profile.authMethod === 'agent' ||
      (profile.authMethod === 'key' && !secret)

    let lastError: Error | null = null

    if (useOpenSsh) {
      const candidates = buildOpenSshCandidates(profile)
      for (const candidate of candidates) {
        try {
          const session = await createOpenSshSftpSession(candidate)
          return new SshSftpTransport({
            hostId: profile.id,
            hostName: profile.name,
            mode: 'openssh-sftp',
            ...session
          })
        } catch (err) {
          lastError = err instanceof Error ? err : new Error(String(err))
        }
      }
    }

    // Fallback (or primary for password / passphrase-protected key): direct pure-JS ssh2
    const ssh2Hosts = [profile.orcaVpnHost, profile.hostname].filter(
      (h, idx, arr): h is string => Boolean(h) && arr.indexOf(h) === idx
    )

    for (const targetHost of ssh2Hosts.length ? ssh2Hosts : [profile.sshAlias || profile.name]) {
      try {
        const session = await createSsh2Session(profile, secret, targetHost)
        return new SshSftpTransport({
          hostId: profile.id,
          hostName: profile.name,
          mode: 'ssh2-sftp',
          ...session
        })
      } catch (err) {
        lastError = err instanceof Error ? err : new Error(String(err))
      }
    }

    throw lastError || new Error(`Não foi possível abrir SFTP em "${profile.name}".`)
  }

  realpath(remotePath: string): Promise<string> {
    return new Promise((res, rej) => {
      this.sftp.realpath(remotePath || '.', (err, absPath) => {
        if (err) rej(err)
        else res(absPath)
      })
    })
  }

  stat(remotePath: string): Promise<RemoteStat> {
    return new Promise((res, rej) => {
      this.sftp.stat(remotePath, (err, st) => {
        if (err) {
          rej(err)
          return
        }
        res({
          size: st.size,
          mtimeMs: st.mtime * 1000,
          mode: st.mode,
          isDirectory: isDirMode(st.mode),
          isSymlink: isLinkMode(st.mode)
        })
      })
    })
  }

  async listDir(remotePath: string): Promise<{ path: string; entries: FileEntry[] }> {
    const resolved = await this.realpath(remotePath || '.')
    const rawList = await new Promise<
      Array<{ filename: string; longname?: string; attrs: { size: number; mtime: number; mode: number } }>
    >((res, rej) => {
      this.sftp.readdir(resolved, (err, list) => {
        if (err) rej(err)
        else res(list || [])
      })
    })

    const entries: FileEntry[] = []
    for (const item of rawList) {
      if (item.filename === '.' || item.filename === '..') continue
      const fullPath = posixJoin(resolved, item.filename)
      const isSymlink = isLinkMode(item.attrs.mode)
      let isDirectory = isDirMode(item.attrs.mode)
      let size = item.attrs.size
      let mtimeMs = item.attrs.mtime * 1000
      let mode = item.attrs.mode

      if (isSymlink) {
        try {
          const targetStat = await this.stat(fullPath)
          isDirectory = targetStat.isDirectory
          size = targetStat.size
          mtimeMs = targetStat.mtimeMs
          mode = targetStat.mode
        } catch {
          // Broken symlink
        }
      }

      const archiveType = isDirectory ? null : detectArchiveType(item.filename)
      entries.push({
        name: item.filename,
        path: fullPath,
        isDirectory,
        isSymlink,
        size: isDirectory ? 0 : size,
        mtimeMs,
        mode,
        permissions: formatModeRwx(mode),
        isHidden: item.filename.startsWith('.'),
        isArchive: archiveType !== null,
        archiveType,
        isEditableText: !isDirectory && isEditableTextFile(item.filename),
        isImage: !isDirectory && isPreviewableImage(item.filename),
        isLogFile: !isDirectory && isLogFilename(item.filename),
        isMarkdown: !isDirectory && isMarkdownFile(item.filename)
      })
    }

    return { path: resolved, entries }
  }

  async mkdir(parentPath: string, name: string): Promise<string> {
    const clean = name.trim()
    if (!clean || clean.includes('/') || clean === '.' || clean === '..') {
      throw new Error('Nome de pasta inválido.')
    }
    const target = posixJoin(parentPath, clean)
    await new Promise<void>((res, rej) => {
      this.sftp.mkdir(target, (err) => (err ? rej(err) : res()))
    })
    return target
  }

  async mkdirRecursive(remotePath: string): Promise<void> {
    const clean = remotePath.replace(/\/+$/, '')
    if (!clean || clean === '/') return
    try {
      const st = await this.stat(clean)
      if (st.isDirectory) return
    } catch {
      // Create parent first
    }
    const parent = posixDirname(clean)
    if (parent && parent !== clean) {
      await this.mkdirRecursive(parent)
    }
    await new Promise<void>((res, rej) => {
      this.sftp.mkdir(clean, (err) => {
        if (!err) {
          res()
          return
        }
        // Check if created concurrently
        this.stat(clean)
          .then((st) => (st.isDirectory ? res() : rej(err)))
          .catch(() => rej(err))
      })
    })
  }

  async createFile(parentPath: string, name: string, content = ''): Promise<string> {
    const clean = name.trim()
    if (!clean || clean.includes('/') || clean === '.' || clean === '..') {
      throw new Error('Nome de arquivo inválido.')
    }
    const target = posixJoin(parentPath, clean)
    await this.writeText(target, content)
    return target
  }

  async rename(oldPath: string, newName: string): Promise<string> {
    const clean = newName.trim()
    if (!clean || clean.includes('/') || clean === '.' || clean === '..') {
      throw new Error('Novo nome inválido.')
    }
    const newPath = posixJoin(posixDirname(oldPath), clean)
    await this.renameExact(oldPath, newPath)
    return newPath
  }

  async renameExact(oldPath: string, newPath: string): Promise<void> {
    await new Promise<void>((res, rej) => {
      this.sftp.rename(oldPath, newPath, (err) => {
        if (!err) {
          res()
          return
        }
        // SFTP v3 rename fails if destination already exists: unlink destination & retry
        this.sftp.unlink(newPath, () => {
          this.sftp.rename(oldPath, newPath, (err2) => (err2 ? rej(err2) : res()))
        })
      })
    })
  }

  async unlink(remotePath: string): Promise<void> {
    await new Promise<void>((res, rej) => {
      this.sftp.unlink(remotePath, (err) => (err ? rej(err) : res()))
    })
  }

  private async rmdir(remotePath: string): Promise<void> {
    await new Promise<void>((res, rej) => {
      this.sftp.rmdir(remotePath, (err) => (err ? rej(err) : res()))
    })
  }

  private async deleteSingleRecursive(targetPath: string): Promise<void> {
    const clean = targetPath.replace(/\/+$/, '') || '/'
    if (clean === '/') {
      throw new Error('Operação bloqueada por segurança: não é permitido excluir "/".')
    }

    const st = await new Promise<{ mode: number }>((res, rej) => {
      this.sftp.lstat(clean, (err, s) => (err ? rej(err) : res(s)))
    })

    if (!isDirMode(st.mode)) {
      await this.unlink(clean)
      return
    }

    const { entries } = await this.listDir(clean)
    for (const child of entries) {
      if (child.isDirectory && !child.isSymlink) {
        await this.deleteSingleRecursive(child.path)
      } else {
        await this.unlink(child.path)
      }
    }
    await this.rmdir(clean)
  }

  async deletePaths(paths: string[]): Promise<number> {
    let deleted = 0
    for (const p of paths) {
      await this.deleteSingleRecursive(p)
      deleted++
    }
    return deleted
  }

  async chmod(remotePath: string, modeStr: string): Promise<void> {
    if (!/^[0-7]{3,4}$/.test(modeStr.trim())) {
      throw new Error('Permissão inválida. Use formato octal como 644 ou 755.')
    }
    const mode = Number.parseInt(modeStr.trim(), 8)
    await new Promise<void>((res, rej) => {
      this.sftp.chmod(remotePath, mode, (err) => (err ? rej(err) : res()))
    })
  }

  openHandle(remotePath: string, flags: number): Promise<Buffer> {
    return new Promise((res, rej) => {
      this.sftp.open(remotePath, flags, (err, handle) => {
        if (err) rej(err)
        else res(handle)
      })
    })
  }

  readChunk(handle: Buffer, buffer: Buffer, offset: number, length: number, position: number): Promise<number> {
    return new Promise((res, rej) => {
      this.sftp.read(handle, buffer, offset, length, position, (err, bytesRead) => {
        if (err) rej(err)
        else res(bytesRead)
      })
    })
  }

  writeChunk(handle: Buffer, buffer: Buffer, offset: number, length: number, position: number): Promise<void> {
    return new Promise((res, rej) => {
      this.sftp.write(handle, buffer, offset, length, position, (err) => {
        if (err) rej(err)
        else res()
      })
    })
  }

  closeHandle(handle: Buffer): Promise<void> {
    return new Promise((res, rej) => {
      this.sftp.close(handle, (err) => (err ? rej(err) : res()))
    })
  }

  async readBytes(remotePath: string, maxBytes: number): Promise<Buffer> {
    const st = await this.stat(remotePath)
    if (st.isDirectory) throw new Error('O caminho selecionado é uma pasta.')
    if (st.size > maxBytes) {
      throw new Error(
        `Arquivo muito grande (${Math.ceil(st.size / 1024)} KB > limite de ${Math.ceil(maxBytes / 1024)} KB).`
      )
    }

    const handle = await this.openHandle(remotePath, SFTP_OPEN_FLAGS.READ)
    try {
      const chunks: Buffer[] = []
      const buf = Buffer.allocUnsafe(64 * 1024)
      let pos = 0
      while (true) {
        const read = await this.readChunk(handle, buf, 0, buf.length, pos)
        if (read <= 0) break
        chunks.push(Buffer.from(buf.subarray(0, read)))
        pos += read
      }
      return Buffer.concat(chunks)
    } finally {
      await this.closeHandle(handle).catch(() => undefined)
    }
  }

  async readText(remotePath: string, maxBytes: number, forceText = false): Promise<EditorFilePayload> {
    const st = await this.stat(remotePath)
    if (st.isDirectory) throw new Error('Não é possível abrir uma pasta no editor.')
    if (st.size > maxBytes) {
      throw new Error(
        `Arquivo muito grande para o editor rápido (${Math.ceil(st.size / 1024)} KB > limite de ${Math.ceil(maxBytes / 1024)} KB).`
      )
    }

    const full = await this.readBytes(remotePath, maxBytes)
    if (!forceText && looksBinary(full)) {
      throw new Error('Este arquivo parece ser binário. Use "Abrir como texto" se quiser forçar a visualização.')
    }
    return {
      side: 'remote',
      hostId: this.hostId,
      path: remotePath,
      name: posixBasename(remotePath),
      content: full.toString('utf8'),
      size: full.length,
      mtimeMs: st.mtimeMs,
      encoding: 'utf-8'
    }
  }

  async writeText(remotePath: string, content: string): Promise<{ mtimeMs: number; size: number }> {
    const buf = Buffer.from(content, 'utf8')
    const handle = await this.openHandle(remotePath, SFTP_OPEN_FLAGS.WRITE_CREATE_TRUNC)
    try {
      const chunkSize = 64 * 1024
      let offset = 0
      while (offset < buf.length) {
        const len = Math.min(chunkSize, buf.length - offset)
        await this.writeChunk(handle, buf, offset, len, offset)
        offset += len
      }
    } finally {
      await this.closeHandle(handle).catch(() => undefined)
    }
    const st = await this.stat(remotePath).catch(() => ({ mtimeMs: Date.now(), size: buf.length }))
    return { mtimeMs: st.mtimeMs, size: buf.length }
  }

  async compress(cwd: string, names: string[], archiveName: string, format: ArchiveFormat): Promise<string> {
    const plan = buildCompressCommand(cwd, names, archiveName, format)
    await this.execCommand(plan.command)
    return plan.outputPath
  }

  async extract(archivePath: string, destinationDir: string, createSubfolder = false): Promise<string> {
    const plan = buildExtractCommand(archivePath, destinationDir, createSubfolder)
    await this.execCommand(plan.command)
    return plan.destinationDir
  }

  async searchRecursive(
    rootPath: string,
    query: string,
    maxResults = 100
  ): Promise<{ results: SearchResultEntry[]; truncated: boolean }> {
    const cleanQuery = query.trim().replace(/[*?[\]]/g, '')
    if (!cleanQuery) return { results: [], truncated: false }
    const root = (await this.realpath(rootPath || '.')).replace(/\/+$/, '') || '/'
    const limit = Math.max(1, Math.min(200, maxResults))
    const pattern = `*${cleanQuery}*`
    // Use find with printf/type detection; ignore permission errors and prune .git/node_modules
    const cmd = [
      `find ${shellQuotePosix(root)} -maxdepth 6`,
      `\\( -name .git -o -name node_modules \\) -prune -o`,
      `-iname ${shellQuotePosix(pattern)} -print 2>/dev/null`,
      `| head -n ${limit + 1}`
    ].join(' ')

    const stdout = await this.execCommand(cmd).catch(() => '')
    const lines = stdout
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter((l) => l && l !== root)

    const truncated = lines.length > limit
    const slice = truncated ? lines.slice(0, limit) : lines

    const results: SearchResultEntry[] = []
    for (const fullPath of slice) {
      const name = posixBasename(fullPath)
      const rel = fullPath.startsWith(`${root}/`) ? fullPath.slice(root.length + 1) : fullPath
      let isDirectory = false
      try {
        const st = await this.stat(fullPath)
        isDirectory = st.isDirectory
      } catch {
        // ignore
      }
      results.push({
        name,
        path: fullPath,
        relativePath: rel,
        parentDir: posixDirname(fullPath),
        isDirectory,
        isEditableText: !isDirectory && isEditableTextFile(name),
        isImage: !isDirectory && isPreviewableImage(name)
      })
    }
    return { results, truncated }
  }

  startTail(
    remotePath: string,
    lines: number,
    onChunk: (chunk: string) => void,
    onClose: (reason?: string) => void
  ): TailHandle {
    const n = Math.max(10, Math.min(2000, lines))
    const cmd = `tail -n ${n} -F ${shellQuotePosix(remotePath)}`
    return this.streamCommand(cmd, onChunk, onClose)
  }

  destroy(): void {
    this._alive = false
    this.destroyFn()
  }
}
