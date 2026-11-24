import {
  detectArchiveType,
  posixBasename,
  posixDirname,
  posixJoin,
  shellQuotePosix,
  stripArchiveExtension
} from '../shared/file-utils.ts'
import type { ArchiveFormat, ArchiveType } from '../shared/types.ts'

export interface ArchiveCommandPlan {
  command: string
  outputPath: string
  format: ArchiveFormat
}

export interface ExtractCommandPlan {
  command: string
  destinationDir: string
  archiveType: ArchiveType
}

/**
 * Builds a POSIX shell command to compress one or more relative names inside `cwd`.
 * Every path argument is strictly single-quote escaped to prevent command injection.
 */
export function buildCompressCommand(
  cwd: string,
  names: string[],
  archiveName: string,
  format: ArchiveFormat
): ArchiveCommandPlan {
  if (!names.length) {
    throw new Error('Selecione ao menos um arquivo ou pasta para compactar.')
  }
  for (const name of names) {
    if (!name || name === '.' || name === '..' || name.includes('/') || name.includes('\0')) {
      throw new Error(`Nome inválido para compactação: "${name}"`)
    }
  }
  const cleanName = archiveName.trim().replace(/^\/+/, '')
  if (!cleanName || cleanName.includes('/') || cleanName.includes('\0')) {
    throw new Error('Nome do arquivo compactado inválido.')
  }

  const finalName =
    format === 'zip'
      ? cleanName.toLowerCase().endsWith('.zip')
        ? cleanName
        : `${cleanName}.zip`
      : cleanName.toLowerCase().endsWith('.tar.gz') || cleanName.toLowerCase().endsWith('.tgz')
        ? cleanName
        : `${cleanName}.tar.gz`

  const outputPath = posixJoin(cwd, finalName)
  const quotedCwd = shellQuotePosix(cwd)
  const quotedArchive = shellQuotePosix(finalName)
  const quotedItems = names.map((n) => shellQuotePosix(n)).join(' ')

  if (format === 'zip') {
    const command = [
      `cd ${quotedCwd}`,
      `&& (command -v zip >/dev/null 2>&1 || { echo "Ferramenta 'zip' não instalada no servidor." >&2; exit 127; })`,
      `&& zip -r -q ${quotedArchive} -- ${quotedItems}`
    ].join(' ')
    return { command, outputPath, format }
  }

  const command = [
    `cd ${quotedCwd}`,
    `&& (command -v tar >/dev/null 2>&1 || { echo "Ferramenta 'tar' não instalada no servidor." >&2; exit 127; })`,
    `&& tar -czf ${quotedArchive} -- ${quotedItems}`
  ].join(' ')
  return { command, outputPath, format }
}

/**
 * Builds a POSIX shell command to extract an archive into `destinationDir` (or a new subfolder).
 */
export function buildExtractCommand(
  archivePath: string,
  destinationDir?: string,
  createSubfolder = false
): ExtractCommandPlan {
  const filename = posixBasename(archivePath)
  const archiveType = detectArchiveType(filename)
  if (!archiveType) {
    throw new Error(`Extensão não suportada para descompactação: "${filename}"`)
  }

  const baseDest = destinationDir || posixDirname(archivePath)
  const targetDir = createSubfolder
    ? posixJoin(baseDest, stripArchiveExtension(filename))
    : baseDest

  const quotedArchive = shellQuotePosix(archivePath)
  const quotedTarget = shellQuotePosix(targetDir)

  let extractCmd: string
  switch (archiveType) {
    case 'zip':
      extractCmd = `(command -v unzip >/dev/null 2>&1 && unzip -o -q ${quotedArchive} -d ${quotedTarget}) || (command -v python3 >/dev/null 2>&1 && python3 -m zipfile -e ${quotedArchive} ${quotedTarget}) || { echo "Ferramenta 'unzip' não encontrada." >&2; exit 127; }`
      break
    case 'tar.gz':
    case 'tgz':
      extractCmd = `tar -xzf ${quotedArchive} -C ${quotedTarget}`
      break
    case 'tar':
      extractCmd = `tar -xf ${quotedArchive} -C ${quotedTarget}`
      break
    case 'tar.bz2':
      extractCmd = `tar -xjf ${quotedArchive} -C ${quotedTarget}`
      break
    case 'tar.xz':
      extractCmd = `tar -xJf ${quotedArchive} -C ${quotedTarget}`
      break
    case 'gz': {
      const outName = stripArchiveExtension(filename)
      const outFile = posixJoin(targetDir, outName)
      extractCmd = `gzip -dc ${quotedArchive} > ${shellQuotePosix(outFile)}`
      break
    }
    case '7z':
      extractCmd = `(command -v 7z >/dev/null 2>&1 || { echo "Ferramenta '7z' não instalada." >&2; exit 127; }) && 7z x -y ${quotedArchive} -o${quotedTarget}`
      break
    case 'rar':
      extractCmd = `(command -v unrar >/dev/null 2>&1 && unrar x -o+ ${quotedArchive} ${quotedTarget}/) || (command -v 7z >/dev/null 2>&1 && 7z x -y ${quotedArchive} -o${quotedTarget}) || { echo "Ferramenta 'unrar' ou '7z' não instalada." >&2; exit 127; }`
      break
  }

  const command = `mkdir -p ${quotedTarget} && ${extractCmd}`
  return { command, destinationDir: targetDir, archiveType }
}
