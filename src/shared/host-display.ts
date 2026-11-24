import type { HostProfile, HostSftpState } from './types.ts'

/**
 * Deduplicates Orca Remote Environments that wrap an Orca SSH target or share the exact same
 * SSH alias / VPN IP, preventing the same server from appearing twice (once green, once red).
 */
export function deduplicateHostsForDisplay(
  hosts: HostProfile[],
  hostStates: Record<string, HostSftpState>,
  inUseIds?: Set<string>
): HostProfile[] {
  const envWrappedSshIds = new Set<string>()
  const envCoveredAliases = new Set<string>()
  const envCoveredIps = new Set<string>()

  for (const h of hosts) {
    if (h.kind !== 'orca-env') continue
    if (h.orcaSshTargetId) envWrappedSshIds.add(`orca-ssh:${h.orcaSshTargetId}`)
    if (h.sshAlias) envCoveredAliases.add(h.sshAlias.toLowerCase())
    if (h.orcaVpnHost) envCoveredIps.add(h.orcaVpnHost.toLowerCase())
    if (h.hostname) envCoveredIps.add(h.hostname.toLowerCase())
  }

  return hosts.filter((h) => {
    if (inUseIds?.has(h.id)) return true
    if (h.kind === 'orca-env') return true

    const liveState = hostStates[h.id]?.state
    // Never hide a host that the user explicitly connected via SFTP
    if (liveState === 'connected' && hostStates[h.id]?.source === 'sftp') return true

    if (h.kind === 'orca-ssh' && envWrappedSshIds.has(h.id)) return false
    if (h.sshAlias && envCoveredAliases.has(h.sshAlias.toLowerCase())) return false
    if (h.hostname && envCoveredIps.has(h.hostname.toLowerCase())) return false
    return true
  })
}
