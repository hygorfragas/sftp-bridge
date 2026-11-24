import type { ArchiveType } from './types.ts'

const EDITABLE_EXTENSIONS = new Set([
  '.txt',
  '.md',
  '.markdown',
  '.mdx',
  '.srt',
  '.vtt',
  '.sub',
  '.ass',
  '.json',
  '.jsonc',
  '.json5',
  '.yml',
  '.yaml',
  '.toml',
  '.ini',
  '.cfg',
  '.conf',
  '.env',
  '.properties',
  '.log',
  '.csv',
  '.tsv',
  '.xml',
  '.svg',
  '.html',
  '.htm',
  '.css',
  '.scss',
  '.less',
  '.js',
  '.mjs',
  '.cjs',
  '.jsx',
  '.ts',
  '.mts',
  '.cts',
  '.tsx',
  '.py',
  '.rb',
  '.go',
  '.rs',
  '.java',
  '.kt',
  '.c',
  '.h',
  '.cpp',
  '.hpp',
  '.cs',
  '.php',
  '.swift',
  '.sh',
  '.bash',
  '.zsh',
  '.fish',
  '.ps1',
  '.sql',
  '.graphql',
  '.gql',
  '.dockerfile',
  '.tf',
  '.hcl',
  '.nginx',
  '.service',
  '.timer',
  '.socket',
  '.gitignore',
  '.gitattributes',
  '.editorconfig',
  '.npmrc',
  '.nvmrc',
  '.htaccess',
  '.lock'
])

const EDITABLE_FILENAMES = new Set([
  'dockerfile',
  'makefile',
  'readme',
  'license',
  'changelog',
  'procfile',
  'gemfile',
  'vagrantfile',
  'caddyfile',
  '.bashrc',
  '.bash_profile',
  '.bash_history',
  '.profile',
  '.zshrc',
  '.zprofile',
  '.zshenv',
  '.env',
  '.env.local',
  '.env.production',
  '.env.development',
  '.gitignore',
  '.dockerignore',
  '.npmrc',
  '.editorconfig',
  'authorized_keys',
  'known_hosts',
  'config',
  'hosts',
  'fstab',
  'crontab'
])

export function detectArchiveType(filename: string): ArchiveType | null {
  const lower = filename.toLowerCase()
  if (lower.endsWith('.tar.gz')) return 'tar.gz'
  if (lower.endsWith('.tgz')) return 'tgz'
  if (lower.endsWith('.tar.bz2') || lower.endsWith('.tbz2')) return 'tar.bz2'
  if (lower.endsWith('.tar.xz') || lower.endsWith('.txz')) return 'tar.xz'
  if (lower.endsWith('.tar')) return 'tar'
  if (lower.endsWith('.zip')) return 'zip'
  if (lower.endsWith('.gz')) return 'gz'
  if (lower.endsWith('.7z')) return '7z'
  if (lower.endsWith('.rar')) return 'rar'
  return null
}

const IMAGE_MIME_BY_EXT: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.bmp': 'image/bmp',
  '.avif': 'image/avif'
}

export function getImageMimeType(filename: string): string | null {
  const lower = filename.toLowerCase()
  const dotIdx = lower.lastIndexOf('.')
  if (dotIdx <= 0) return null
  return IMAGE_MIME_BY_EXT[lower.slice(dotIdx)] || null
}

export function isPreviewableImage(filename: string): boolean {
  return getImageMimeType(filename) !== null
}

export function isMarkdownFile(filename: string): boolean {
  const lower = filename.toLowerCase()
  return lower.endsWith('.md') || lower.endsWith('.markdown') || lower.endsWith('.mdx')
}

export function isLogFilename(filename: string): boolean {
  const lower = filename.toLowerCase()
  return (
    lower.endsWith('.log') ||
    lower.endsWith('.out') ||
    lower.endsWith('.err') ||
    /\.log\.\d+$/.test(lower)
  )
}

export function isEditableTextFile(filename: string): boolean {
  const lower = filename.toLowerCase()
  if (EDITABLE_FILENAMES.has(lower)) return true
  if (lower.startsWith('.env.')) return true
  const dotIdx = lower.lastIndexOf('.')
  if (dotIdx <= 0) return false
  const ext = lower.slice(dotIdx)
  return EDITABLE_EXTENSIONS.has(ext)
}

export function stripArchiveExtension(filename: string): string {
  const lower = filename.toLowerCase()
  for (const suffix of ['.tar.gz', '.tar.bz2', '.tar.xz', '.tgz', '.tbz2', '.txz', '.tar', '.zip', '.gz', '.7z', '.rar']) {
    if (lower.endsWith(suffix)) {
      return filename.slice(0, filename.length - suffix.length) || `${filename}_extracted`
    }
  }
  return `${filename}_extracted`
}

export function formatModeOctal(mode: number): string {
  const perm = mode & 0o777
  return perm.toString(8).padStart(3, '0')
}

export function formatModeRwx(mode: number): string {
  const perm = mode & 0o777
  const chars = ['r', 'w', 'x']
  let out = ''
  for (let shift = 6; shift >= 0; shift -= 3) {
    const bits = (perm >> shift) & 7
    out += bits & 4 ? chars[0] : '-'
    out += bits & 2 ? chars[1] : '-'
    out += bits & 1 ? chars[2] : '-'
  }
  return out
}

export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return '0 B'
  if (bytes < 1024) return `${Math.round(bytes)} B`
  const units = ['KB', 'MB', 'GB', 'TB']
  let value = bytes / 1024
  let idx = 0
  while (value >= 1024 && idx < units.length - 1) {
    value /= 1024
    idx++
  }
  return `${value >= 100 ? value.toFixed(0) : value >= 10 ? value.toFixed(1) : value.toFixed(2)} ${units[idx]}`
}

export function formatSpeed(bps: number): string {
  if (!Number.isFinite(bps) || bps <= 0) return '—'
  return `${formatBytes(bps)}/s`
}

export function formatEta(seconds: number | null): string {
  if (seconds === null || !Number.isFinite(seconds) || seconds < 0) return '—'
  if (seconds < 1) return '<1s'
  const s = Math.round(seconds)
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  const remS = s % 60
  if (m < 60) return `${m}m ${remS}s`
  const h = Math.floor(m / 60)
  const remM = m % 60
  return `${h}h ${remM}m`
}

export function formatTimestamp(ms: number): string {
  if (!ms) return ''
  const d = new Date(ms)
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}

/** Strict POSIX single-quote shell escaping to prevent command injection */
export function shellQuotePosix(arg: string): string {
  if (arg === '') return "''"
  return `'${arg.replace(/'/g, "'\\''")}'`
}

export function posixJoin(dir: string, name: string): string {
  if (!dir || dir === '/') return `/${name.replace(/^\/+/, '')}`
  return `${dir.replace(/\/+$/, '')}/${name.replace(/^\/+/, '')}`
}

export function posixDirname(p: string): string {
  const cleaned = p.replace(/\/+$/, '')
  if (!cleaned || cleaned === '/') return '/'
  const idx = cleaned.lastIndexOf('/')
  if (idx <= 0) return '/'
  return cleaned.slice(0, idx)
}

export function posixBasename(p: string): string {
  const cleaned = p.replace(/\/+$/, '')
  if (!cleaned || cleaned === '/') return '/'
  const idx = cleaned.lastIndexOf('/')
  return idx < 0 ? cleaned : cleaned.slice(idx + 1)
}

/** Check if a buffer looks like binary content (contains null bytes in first 8 KiB) */
export function looksBinary(buf: Uint8Array): boolean {
  const limit = Math.min(buf.length, 8192)
  for (let i = 0; i < limit; i++) {
    if (buf[i] === 0) return true
  }
  return false
}

/** Suggests a non-conflicting name preserving extension (e.g. AGENTS.md -> AGENTS (1).md). */
export function suggestNonConflictingName(
  name: string,
  isDirectory: boolean,
  existingNames: Set<string>
): string {
  const dotIdx = !isDirectory ? name.lastIndexOf('.') : -1
  const hasExt = dotIdx > 0
  const stem = hasExt ? name.slice(0, dotIdx) : name
  const ext = hasExt ? name.slice(dotIdx) : ''

  for (let i = 1; i <= 999; i++) {
    const candidate = `${stem} (${i})${ext}`
    if (!existingNames.has(candidate)) return candidate
  }
  return `${stem}-${Date.now()}${ext}`
}
