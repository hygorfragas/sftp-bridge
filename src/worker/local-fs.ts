import { execFile, spawn } from 'node:child_process'
import { chmod, lstat, mkdir, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, dirname, join, relative, resolve } from 'node:path'
import { promisify } from 'node:util'
import {
  detectArchiveType,
  formatModeRwx,
  getImageMimeType,
  isEditableTextFile,
  isLogFilename,
  isMarkdownFile,
  isPreviewableImage,
  looksBinary
} from '../shared/file-utils.ts'
import type {
  ArchiveFormat,
  EditorFilePayload,
  FileEntry,
  ImagePreviewPayload,
  SearchResultEntry
} from '../shared/types.ts'
import { buildCompressCommand, buildExtractCommand } from './archive-commands.ts'
import type { TailHandle } from './transport-types.ts'

const execFileAsync = promisify(execFile)

export function getLocalHome(): string {
  return homedir()
}

export async function listLocalDir(targetPath?: string): Promise<{ path: string; entries: FileEntry[] }> {
  const resolved = resolve(targetPath && targetPath.trim() ? targetPath : homedir())
  const dirents = await readdir(resolved, { withFileTypes: true })

  const entries = await Promise.all(
    dirents.map(async (d): Promise<FileEntry | null> => {
      const fullPath = join(resolved, d.name)
      try {
        const lst = await lstat(fullPath)
        const isSymlink = lst.isSymbolicLink()
        let isDirectory = lst.isDirectory()
        let size = lst.size
        let mtimeMs = lst.mtimeMs
        let mode = lst.mode

        if (isSymlink) {
          try {
            const st = await stat(fullPath)
            isDirectory = st.isDirectory()
            size = st.size
            mtimeMs = st.mtimeMs
            mode = st.mode
          } catch {
            // Broken symlink: keep lstat values
          }
        }

        const archiveType = isDirectory ? null : detectArchiveType(d.name)
        return {
          name: d.name,
          path: fullPath,
          isDirectory,
          isSymlink,
          size: isDirectory ? 0 : size,
          mtimeMs,
          mode,
          permissions: formatModeRwx(mode),
          isHidden: d.name.startsWith('.'),
          isArchive: archiveType !== null,
          archiveType,
          isEditableText: !isDirectory && isEditableTextFile(d.name),
          isImage: !isDirectory && isPreviewableImage(d.name),
          isLogFile: !isDirectory && isLogFilename(d.name),
          isMarkdown: !isDirectory && isMarkdownFile(d.name)
        }
      } catch {
        return null
      }
    })
  )

  return {
    path: resolved,
    entries: entries.filter((e): e is FileEntry => e !== null)
  }
}

export async function mkdirLocal(parentPath: string, name: string): Promise<string> {
  const clean = name.trim()
  if (!clean || clean.includes('/') || clean.includes('\\') || clean === '.' || clean === '..') {
    throw new Error('Nome de pasta inválido.')
  }
  const target = join(resolve(parentPath), clean)
  await mkdir(target, { recursive: true })
  return target
}

export async function createFileLocal(parentPath: string, name: string, content = ''): Promise<string> {
  const clean = name.trim()
  if (!clean || clean.includes('/') || clean.includes('\\') || clean === '.' || clean === '..') {
    throw new Error('Nome de arquivo inválido.')
  }
  const target = join(resolve(parentPath), clean)
  await writeFile(target, content, 'utf8')
  return target
}

export async function renameLocal(oldPath: string, newName: string): Promise<string> {
  const clean = newName.trim()
  if (!clean || clean.includes('/') || clean.includes('\\') || clean === '.' || clean === '..') {
    throw new Error('Novo nome inválido.')
  }
  const resolvedOld = resolve(oldPath)
  const target = join(dirname(resolvedOld), clean)
  await rename(resolvedOld, target)
  return target
}

export async function deleteLocal(paths: string[]): Promise<number> {
  let deleted = 0
  for (const p of paths) {
    const resolved = resolve(p)
    if (resolved === '/' || resolved === homedir()) {
      throw new Error(`Operação bloqueada por segurança para o caminho: ${resolved}`)
    }
    await rm(resolved, { recursive: true, force: true })
    deleted++
  }
  return deleted
}

export async function chmodLocal(filePath: string, modeStr: string): Promise<void> {
  if (!/^[0-7]{3,4}$/.test(modeStr.trim())) {
    throw new Error('Permissão inválida. Use formato octal como 644 ou 755.')
  }
  await chmod(resolve(filePath), Number.parseInt(modeStr.trim(), 8))
}

export async function readLocalText(
  filePath: string,
  maxBytes: number,
  forceText = false
): Promise<EditorFilePayload> {
  const resolved = resolve(filePath)
  const st = await stat(resolved)
  if (st.isDirectory()) throw new Error('Não é possível abrir uma pasta no editor.')
  if (st.size > maxBytes) {
    throw new Error(
      `Arquivo muito grande para o editor rápido (${Math.ceil(st.size / 1024)} KB > limite de ${Math.ceil(maxBytes / 1024)} KB).`
    )
  }
  const buf = await readFile(resolved)
  if (!forceText && looksBinary(buf)) {
    throw new Error('Este arquivo parece ser binário. Use "Abrir como texto" se quiser forçar a visualização.')
  }
  return {
    side: 'local',
    path: resolved,
    name: basename(resolved),
    content: buf.toString('utf8'),
    size: buf.length,
    mtimeMs: st.mtimeMs,
    encoding: 'utf-8'
  }
}

export async function writeLocalText(filePath: string, content: string): Promise<{ mtimeMs: number; size: number }> {
  const resolved = resolve(filePath)
  const buf = Buffer.from(content, 'utf8')
  await writeFile(resolved, buf)
  const st = await stat(resolved)
  return { mtimeMs: st.mtimeMs, size: st.size }
}

export async function compressLocal(
  cwd: string,
  names: string[],
  archiveName: string,
  format: ArchiveFormat
): Promise<string> {
  const plan = buildCompressCommand(resolve(cwd), names, archiveName, format)
  await execFileAsync('/bin/sh', ['-c', plan.command], { timeout: 120_000 })
  return plan.outputPath
}

export async function extractLocal(
  archivePath: string,
  destinationDir: string,
  createSubfolder = false
): Promise<string> {
  const plan = buildExtractCommand(resolve(archivePath), resolve(destinationDir), createSubfolder)
  await execFileAsync('/bin/sh', ['-c', plan.command], { timeout: 120_000 })
  return plan.destinationDir
}

export async function readLocalBytes(filePath: string, maxBytes: number): Promise<Buffer> {
  const resolved = resolve(filePath)
  const st = await stat(resolved)
  if (st.isDirectory()) throw new Error('O caminho selecionado é uma pasta.')
  if (st.size > maxBytes) {
    throw new Error(`Arquivo muito grande (${Math.ceil(st.size / 1024)} KB > limite de ${Math.ceil(maxBytes / 1024)} KB).`)
  }
  return readFile(resolved)
}

export async function readLocalImage(filePath: string, maxBytes = 650 * 1024): Promise<ImagePreviewPayload> {
  const resolved = resolve(filePath)
  const name = basename(resolved)
  const mimeType = getImageMimeType(name)
  if (!mimeType) throw new Error(`Formato de imagem não suportado: ${name}`)
  const buf = await readLocalBytes(resolved, maxBytes)
  return {
    side: 'local',
    path: resolved,
    name,
    mimeType,
    dataUrl: `data:${mimeType};base64,${buf.toString('base64')}`,
    size: buf.length
  }
}

export async function searchLocalRecursive(
  rootPath: string,
  query: string,
  maxResults = 100
): Promise<{ results: SearchResultEntry[]; truncated: boolean }> {
  const q = query.trim().toLowerCase()
  if (!q) return { results: [], truncated: false }
  const root = resolve(rootPath)
  const results: SearchResultEntry[] = []
  let truncated = false
  const skipDirs = new Set(['node_modules', '.git', '.orca'])
  const deadline = Date.now() + 4500

  const walk = async (dir: string, depth: number): Promise<void> => {
    if (depth > 6 || truncated || Date.now() > deadline) return
    let dirents
    try {
      dirents = await readdir(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const d of dirents) {
      if (results.length >= maxResults) {
        truncated = true
        return
      }
      const full = join(dir, d.name)
      const isDir = d.isDirectory()
      if (d.name.toLowerCase().includes(q)) {
        results.push({
          name: d.name,
          path: full,
          relativePath: relative(root, full) || d.name,
          parentDir: dirname(full),
          isDirectory: isDir,
          isEditableText: !isDir && isEditableTextFile(d.name),
          isImage: !isDir && isPreviewableImage(d.name)
        })
      }
      if (isDir && !d.isSymbolicLink() && !skipDirs.has(d.name)) {
        await walk(full, depth + 1)
      }
    }
  }

  await walk(root, 0)
  return { results, truncated }
}

export function startLocalTail(
  filePath: string,
  lines: number,
  onChunk: (chunk: string) => void,
  onClose: (reason?: string) => void
): TailHandle {
  const resolved = resolve(filePath)
  const proc = spawn('tail', ['-n', String(Math.max(10, Math.min(2000, lines))), '-F', resolved], {
    stdio: ['ignore', 'pipe', 'pipe']
  })
  proc.stdout.on('data', (d: Buffer) => onChunk(d.toString('utf8')))
  proc.stderr.on('data', (d: Buffer) => onChunk(d.toString('utf8')))
  proc.on('error', (err) => onClose(err.message))
  proc.on('close', (code) => onClose(code ? `tail encerrado (${code})` : undefined))
  return {
    stop: () => {
      if (!proc.killed) proc.kill('SIGTERM')
    }
  }
}
