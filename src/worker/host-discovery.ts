import { execFile } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import type { HostProfile, SaveHostInput } from '../shared/types.ts'

const execFileAsync = promisify(execFile)

export interface ParsedSshConfigHost {
  alias: string
  hostname?: string
  port?: number
  user?: string
  identityFile?: string
}

export interface OrcaHostListItem {
  kind: 'local' | 'ssh' | 'environment'
  name: string
  id: string
  selector?: string
  connected?: boolean
  connectionStatus?: string
}

export interface OrcaEnvironmentItem {
  id: string
  name: string
  connectionDependency?: string
  endpoints?: { id: string; kind: string; endpoint: string }[]
  orcadDeployment?: {
    sshTargetId?: string
    localPort?: number
    remotePort?: number
  }
}

export interface StoredHostBinding {
  id: string
  name: string
  hostname: string
  port?: number
  username: string
  authMethod: 'openssh' | 'agent' | 'key' | 'password'
  sshAlias?: string
  identityFile?: string
  orcaEnvironmentId?: string
  defaultRemotePath?: string
  hasSecret?: boolean
}

/** Parses standard ~/.ssh/config Host blocks, ignoring wildcards and comments. */
export function parseSshConfig(content: string): ParsedSshConfigHost[] {
  const results: ParsedSshConfigHost[] = []
  let currentHosts: ParsedSshConfigHost[] = []

  const lines = content.split(/\r?\n/)
  for (const rawLine of lines) {
    const line = rawLine.replace(/#.*$/, '').trim()
    if (!line) continue

    const match = line.match(/^([A-Za-z0-9_-]+)(?:\s*=\s*|\s+)(.+)$/)
    if (!match) continue

    const key = match[1].toLowerCase()
    const rawValue = match[2].trim()

    if (key === 'host') {
      const patterns = rawValue
        .split(/\s+/)
        .map((p) => p.replace(/^["']|["']$/g, ''))
        .filter((p) => p && !p.includes('*') && !p.includes('?') && !p.startsWith('!'))

      currentHosts = patterns.map((alias) => {
        const existing = results.find((r) => r.alias === alias)
        if (existing) return existing
        const entry: ParsedSshConfigHost = { alias }
        results.push(entry)
        return entry
      })
      continue
    }

    if (key === 'match') {
      currentHosts = []
      continue
    }

    if (!currentHosts.length) continue
    const value = rawValue.replace(/^["']|["']$/g, '')

    for (const h of currentHosts) {
      if (key === 'hostname' && !h.hostname) h.hostname = value
      else if (key === 'user' && !h.user) h.user = value
      else if (key === 'port' && !h.port) {
        const parsed = Number.parseInt(value, 10)
        if (Number.isFinite(parsed) && parsed > 0 && parsed <= 65535) h.port = parsed
      } else if (key === 'identityfile' && !h.identityFile) {
        h.identityFile = value.startsWith('~/') ? join(homedir(), value.slice(2)) : value
      }
    }
  }

  return results
}

export function extractHostFromEndpoint(endpoint?: string): string | undefined {
  if (!endpoint) return undefined
  try {
    const parsed = new URL(endpoint)
    if (parsed.hostname && parsed.hostname !== '127.0.0.1' && parsed.hostname !== 'localhost') {
      return parsed.hostname
    }
  } catch {
    // Ignore malformed endpoint URLs
  }
  return undefined
}

function normalizeName(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]/g, '')
}

async function runOrcaCliJson<T>(args: string[]): Promise<T | null> {
  const candidates = [
    process.env.ORCA_CLI_COMMAND,
    '/Applications/Orca.app/Contents/Resources/bin/orca',
    'orca'
  ].filter(Boolean) as string[]

  for (const bin of candidates) {
    try {
      const { stdout } = await execFileAsync(bin, [...args, '--json'], {
        timeout: 4000,
        maxBuffer: 2 * 1024 * 1024
      })
      const parsed = JSON.parse(stdout) as { ok?: boolean; result?: T }
      if (parsed && parsed.ok && parsed.result) return parsed.result
    } catch {
      // Try next candidate
    }
  }
  return null
}

export async function readLocalSshConfig(): Promise<ParsedSshConfigHost[]> {
  try {
    const raw = await readFile(join(homedir(), '.ssh', 'config'), 'utf8')
    return parseSshConfig(raw)
  } catch {
    return []
  }
}

export function mergeDiscoveredHosts(params: {
  orcaHosts: OrcaHostListItem[]
  orcaEnvs: OrcaEnvironmentItem[]
  sshConfigHosts: ParsedSshConfigHost[]
  savedBindings: StoredHostBinding[]
}): HostProfile[] {
  const { orcaHosts, orcaEnvs, sshConfigHosts, savedBindings } = params
  const profiles: HostProfile[] = []
  const usedSshAliases = new Set<string>()
  const sshById = new Map<string, OrcaHostListItem>()

  for (const h of orcaHosts) {
    if (h.kind === 'ssh') sshById.set(h.id, h)
  }

  const findSshConfigMatch = (aliasOrName?: string, ip?: string): ParsedSshConfigHost | undefined => {
    if (aliasOrName) {
      const exact = sshConfigHosts.find((c) => c.alias === aliasOrName)
      if (exact) return exact
      const norm = normalizeName(aliasOrName)
      const fuzzy = sshConfigHosts.find((c) => normalizeName(c.alias) === norm)
      if (fuzzy) return fuzzy
    }
    if (ip) {
      const byIp = sshConfigHosts.find((c) => c.hostname === ip)
      if (byIp) return byIp
    }
    return undefined
  }

  // 1. Orca SSH Hosts (kind === 'ssh')
  for (const h of orcaHosts) {
    if (h.kind !== 'ssh') continue
    if (h.name.toLowerCase() === 'github.com') continue // Skip git-only host alias by default
    const cfg = findSshConfigMatch(h.name)
    const binding = savedBindings.find((b) => b.id === `orca-ssh:${h.id}`)
    usedSshAliases.add(h.name)
    if (cfg) usedSshAliases.add(cfg.alias)

    profiles.push({
      id: `orca-ssh:${h.id}`,
      name: h.name,
      kind: 'orca-ssh',
      sourceLabel: h.connected ? 'Orca SSH · Conectado' : 'Orca SSH',
      connected: Boolean(h.connected),
      sshAlias: binding?.sshAlias || cfg?.alias || h.name,
      hostname: binding?.hostname || cfg?.hostname || h.name,
      port: binding?.port || cfg?.port || 22,
      username: binding?.username || cfg?.user,
      identityFile: binding?.identityFile || cfg?.identityFile,
      authMethod: binding?.authMethod || 'openssh',
      orcaSshTargetId: h.id,
      defaultRemotePath: binding?.defaultRemotePath,
      hasSecret: binding?.hasSecret
    })
  }

  // 2. Orca Remote Servers (kind === 'environment')
  const envMap = new Map<string, OrcaEnvironmentItem>()
  for (const env of orcaEnvs) envMap.set(env.id, env)

  for (const h of orcaHosts) {
    if (h.kind !== 'environment') continue
    const env = envMap.get(h.id)
    const binding = savedBindings.find((b) => b.orcaEnvironmentId === h.id || b.id === `orca-env:${h.id}`)

    // Case 2A: Managed via ssh-tunnel -> auto-link to Orca SSH host!
    const linkedSshTargetId = env?.orcadDeployment?.sshTargetId
    const linkedSsh = linkedSshTargetId ? sshById.get(linkedSshTargetId) : undefined

    // Case 2B: Paired over VPN / WebSocket (e.g. ws://100.x.y.z:6768)
    const endpointUrl = env?.endpoints?.[0]?.endpoint
    const vpnHost = extractHostFromEndpoint(endpointUrl)

    const cfgMatch = linkedSsh
      ? findSshConfigMatch(linkedSsh.name)
      : findSshConfigMatch(h.name, vpnHost)

    if (cfgMatch) usedSshAliases.add(cfgMatch.alias)

    const resolvedAlias = binding?.sshAlias || linkedSsh?.name || cfgMatch?.alias
    // Prefer live VPN IP from Orca's connected endpoint over potentially stale MagicDNS hostnames in ~/.ssh/config
    const resolvedHostname = binding?.hostname || vpnHost || cfgMatch?.hostname
    const resolvedUsername = binding?.username || cfgMatch?.user
    const hasUsableTransport = Boolean(binding || resolvedAlias || vpnHost)

    profiles.push({
      id: `orca-env:${h.id}`,
      name: h.name,
      kind: 'orca-env',
      sourceLabel: linkedSsh
        ? 'Orca Remoto · Túnel SSH'
        : vpnHost
          ? `Orca Remoto · VPN (${vpnHost})`
          : 'Orca Remoto',
      connected: Boolean(linkedSsh?.connected ?? true),
      sshAlias: resolvedAlias,
      hostname: resolvedHostname,
      port: binding?.port || cfgMatch?.port || 22,
      username: resolvedUsername,
      identityFile: binding?.identityFile || cfgMatch?.identityFile,
      authMethod: binding?.authMethod || (resolvedAlias ? 'openssh' : 'agent'),
      orcaEnvironmentId: h.id,
      orcaSshTargetId: linkedSshTargetId,
      orcaEndpoint: endpointUrl,
      orcaVpnHost: vpnHost,
      needsSshBinding: !hasUsableTransport,
      defaultRemotePath: binding?.defaultRemotePath,
      hasSecret: binding?.hasSecret
    })
  }

  // 3. Remaining ~/.ssh/config hosts not already covered by Orca
  for (const cfg of sshConfigHosts) {
    if (usedSshAliases.has(cfg.alias)) continue
    if (cfg.alias.toLowerCase() === 'github.com') continue
    profiles.push({
      id: `ssh-config:${cfg.alias}`,
      name: cfg.alias,
      kind: 'ssh-config',
      sourceLabel: cfg.hostname ? `SSH Config (${cfg.hostname})` : 'SSH Config',
      sshAlias: cfg.alias,
      hostname: cfg.hostname || cfg.alias,
      port: cfg.port || 22,
      username: cfg.user,
      identityFile: cfg.identityFile,
      authMethod: 'openssh'
    })
  }

  // 4. Manual saved profiles (not bound to an existing Orca host/env)
  for (const b of savedBindings) {
    if (b.id.startsWith('orca-ssh:') || b.id.startsWith('orca-env:')) continue
    profiles.push({
      id: b.id,
      name: b.name,
      kind: 'manual',
      sourceLabel: `Manual (${b.username}@${b.hostname})`,
      sshAlias: b.sshAlias,
      hostname: b.hostname,
      port: b.port || 22,
      username: b.username,
      identityFile: b.identityFile,
      authMethod: b.authMethod,
      defaultRemotePath: b.defaultRemotePath,
      hasSecret: b.hasSecret
    })
  }

  // Sort: Connected Orca SSH & Orca Remote first, then other Orca, then SSH Config, then Manual
  const rank = (p: HostProfile): number => {
    if (p.kind === 'orca-ssh' && p.connected) return 0
    if (p.kind === 'orca-env' && !p.needsSshBinding) return 1
    if (p.kind === 'orca-env') return 2
    if (p.kind === 'orca-ssh') return 3
    if (p.kind === 'manual') return 4
    return 5
  }

  return profiles.sort((a, b) => rank(a) - rank(b) || a.name.localeCompare(b.name))
}

export async function discoverAllHosts(savedBindings: StoredHostBinding[]): Promise<HostProfile[]> {
  const [hostRes, envRes, sshConfigHosts] = await Promise.all([
    runOrcaCliJson<{ hosts?: OrcaHostListItem[] }>(['host', 'list']),
    runOrcaCliJson<{ environments?: OrcaEnvironmentItem[] }>(['environment', 'list']),
    readLocalSshConfig()
  ])

  return mergeDiscoveredHosts({
    orcaHosts: hostRes?.hosts ?? [],
    orcaEnvs: envRes?.environments ?? [],
    sshConfigHosts,
    savedBindings
  })
}

export function buildStoredBindingFromInput(input: SaveHostInput, hasSecret: boolean): StoredHostBinding {
  const id =
    input.id ||
    (input.orcaEnvironmentId
      ? `orca-env:${input.orcaEnvironmentId}`
      : `manual:${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`)

  return {
    id,
    name: input.name.trim() || input.hostname.trim(),
    hostname: input.hostname.trim(),
    port: input.port && input.port > 0 ? input.port : 22,
    username: input.username.trim(),
    authMethod: input.authMethod,
    sshAlias: input.sshAlias?.trim() || undefined,
    identityFile: input.identityFile?.trim() || undefined,
    orcaEnvironmentId: input.orcaEnvironmentId,
    defaultRemotePath: input.defaultRemotePath?.trim() || undefined,
    hasSecret
  }
}
