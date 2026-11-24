import { assert, test } from 'orca/testing'
import { buildCompressCommand, buildExtractCommand } from '../src/worker/archive-commands.ts'

test('buildCompressCommand builds safe zip command with POSIX escaping', () => {
  const plan = buildCompressCommand('/var/www/app', ['my folder', "a'b;$(whoami)"], 'backup', 'zip')
  assert.equal(plan.outputPath, '/var/www/app/backup.zip')
  assert.ok(plan.command.includes("cd '/var/www/app'"))
  assert.ok(plan.command.includes("zip -r -q 'backup.zip' -- 'my folder' 'a'\\''b;$(whoami)'"))
})

test('buildCompressCommand supports tar.gz and preserves extension', () => {
  const plan = buildCompressCommand('/root', ['logs'], 'logs.tar.gz', 'tar.gz')
  assert.equal(plan.outputPath, '/root/logs.tar.gz')
  assert.ok(plan.command.includes("tar -czf 'logs.tar.gz' -- 'logs'"))
})

test('buildCompressCommand rejects traversal names', () => {
  assert.throws(() => buildCompressCommand('/root', ['../etc'], 'bad', 'zip'))
  assert.throws(() => buildCompressCommand('/root', ['a/b'], 'bad', 'zip'))
})

test('buildExtractCommand supports zip, tar.gz, tar.bz2, 7z and subfolder option', () => {
  const zipPlan = buildExtractCommand('/tmp/release.zip', '/tmp', true)
  assert.equal(zipPlan.archiveType, 'zip')
  assert.equal(zipPlan.destinationDir, '/tmp/release')
  assert.ok(zipPlan.command.includes("mkdir -p '/tmp/release'"))
  assert.ok(zipPlan.command.includes("unzip -o -q '/tmp/release.zip' -d '/tmp/release'"))

  const tgzPlan = buildExtractCommand('/data/site.tar.gz', '/data', false)
  assert.equal(tgzPlan.archiveType, 'tar.gz')
  assert.equal(tgzPlan.destinationDir, '/data')
  assert.ok(tgzPlan.command.includes("tar -xzf '/data/site.tar.gz' -C '/data'"))

  const gzPlan = buildExtractCommand('/data/dump.sql.gz', '/data', false)
  assert.equal(gzPlan.archiveType, 'gz')
  assert.ok(gzPlan.command.includes("gzip -dc '/data/dump.sql.gz' > '/data/dump.sql'"))
})
