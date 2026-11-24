import { assert, test } from 'orca/testing'
import { mergeDiscoveredHosts, parseSshConfig } from '../src/worker/host-discovery.ts'

test('parseSshConfig parses aliases, hostnames, ports, users and ignores wildcards', () => {
  const cfg = `
    # Global defaults
    Host *
      ServerAliveInterval 60

    Host alpha-box
      HostName 198.51.100.10
      User root
      Port 2222
      IdentityFile ~/.ssh/id_alpha

    Host beta-prod
      HostName 100.64.0.10
      User deploy
  `
  const parsed = parseSshConfig(cfg)
  assert.equal(parsed.length, 2)
  assert.equal(parsed[0].alias, 'alpha-box')
  assert.equal(parsed[0].hostname, '198.51.100.10')
  assert.equal(parsed[0].port, 2222)
  assert.equal(parsed[0].user, 'root')
  assert.equal(parsed[1].alias, 'beta-prod')
  assert.equal(parsed[1].hostname, '100.64.0.10')
})

test('mergeDiscoveredHosts unifies Orca SSH hosts, ssh-tunnel environments and VPN environments', () => {
  const hosts = mergeDiscoveredHosts({
    orcaHosts: [
      { kind: 'local', name: 'this machine', id: 'local' },
      { kind: 'ssh', name: 'alpha-box', id: 'ssh-1', connected: true },
      { kind: 'environment', name: 'alpha-box', id: 'env-tunnel' },
      { kind: 'environment', name: 'beta PROD', id: 'env-vpn-matched' },
      { kind: 'environment', name: 'Dev Node', id: 'env-vpn-unbound' }
    ],
    orcaEnvs: [
      {
        id: 'env-tunnel',
        name: 'alpha-box',
        connectionDependency: 'ssh-tunnel',
        orcadDeployment: { sshTargetId: 'ssh-1' },
        endpoints: [{ id: 'w1', kind: 'websocket', endpoint: 'ws://127.0.0.1:51476/' }]
      },
      {
        id: 'env-vpn-matched',
        name: 'beta PROD',
        endpoints: [{ id: 'w2', kind: 'websocket', endpoint: 'ws://100.64.0.10:6768' }]
      },
      {
        id: 'env-vpn-unbound',
        name: 'Dev Node',
        endpoints: [{ id: 'w3', kind: 'websocket', endpoint: 'ws://100.64.0.20:6768' }]
      }
    ],
    sshConfigHosts: [
      { alias: 'alpha-box', hostname: '198.51.100.10', user: 'root' },
      { alias: 'beta-prod', hostname: 'beta-prod.example.ts.net', user: 'deploy' },
      { alias: 'extra-box', hostname: '192.0.2.5', user: 'admin' }
    ],
    savedBindings: []
  })

  const sshHost = hosts.find((h) => h.id === 'orca-ssh:ssh-1')
  assert.ok(sshHost)
  assert.equal(sshHost.connected, true)

  const tunnelEnv = hosts.find((h) => h.id === 'orca-env:env-tunnel')
  assert.ok(tunnelEnv)
  assert.equal(tunnelEnv.sshAlias, 'alpha-box')
  assert.equal(tunnelEnv.needsSshBinding, false)

  const matchedVpnEnv = hosts.find((h) => h.id === 'orca-env:env-vpn-matched')
  assert.ok(matchedVpnEnv)
  assert.equal(matchedVpnEnv.sshAlias, 'beta-prod')
  // Prefers live VPN IP over stale MagicDNS hostname in ~/.ssh/config
  assert.equal(matchedVpnEnv.hostname, '100.64.0.10')
  assert.equal(matchedVpnEnv.orcaVpnHost, '100.64.0.10')
  assert.equal(matchedVpnEnv.username, 'deploy')
  assert.equal(matchedVpnEnv.needsSshBinding, false)

  const unboundVpnEnv = hosts.find((h) => h.id === 'orca-env:env-vpn-unbound')
  assert.ok(unboundVpnEnv)
  assert.equal(unboundVpnEnv.hostname, '100.64.0.20')
  assert.equal(unboundVpnEnv.orcaVpnHost, '100.64.0.20')
  assert.equal(unboundVpnEnv.needsSshBinding, false)

  const extra = hosts.find((h) => h.id === 'ssh-config:extra-box')
  assert.ok(extra)
})
