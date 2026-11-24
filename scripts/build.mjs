import * as esbuild from 'esbuild'
import { mkdir, copyFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const watchMode = process.argv.includes('--watch')

await mkdir(resolve(root, 'dist'), { recursive: true })
await mkdir(resolve(root, 'panel'), { recursive: true })

// Worker bundle (Node.js ESM, pure-JS ssh2 without optional native cpu-features addon)
const workerOptions = {
  entryPoints: [resolve(root, 'src/worker/index.ts')],
  outfile: resolve(root, 'dist/worker.mjs'),
  bundle: true,
  platform: 'node',
  target: 'node22',
  format: 'esm',
  minify: true,
  sourcemap: false,
  external: ['cpu-features', './crypto/build/Release/sshcrypto.node'],
  banner: {
    js: [
      `import { createRequire as __sftpCreateRequire } from 'node:module';`,
      `import { fileURLToPath as __sftpFileURLToPath } from 'node:url';`,
      `import { dirname as __sftpDirname } from 'node:path';`,
      `const require = __sftpCreateRequire(import.meta.url);`,
      `const __filename = __sftpFileURLToPath(import.meta.url);`,
      `const __dirname = __sftpDirname(__filename);`
    ].join('\n')
  },
  plugins: [
    {
      name: 'skip-optional-native-ssh2',
      setup(build) {
        build.onResolve({ filter: /^(cpu-features|\.\.?\/.*sshcrypto\.node)$/ }, (args) => ({
          path: args.path,
          namespace: 'optional-native-stub'
        }))
        build.onLoad({ filter: /.*/, namespace: 'optional-native-stub' }, () => ({
          contents: 'module.exports = undefined;',
          loader: 'js'
        }))
      }
    }
  ]
}

// Panel bundle (Browser ESM, Preact + zero external network dependencies)
const panelOptions = {
  entryPoints: [resolve(root, 'src/panel/main.tsx')],
  outfile: resolve(root, 'panel/app.js'),
  bundle: true,
  platform: 'browser',
  target: 'es2022',
  format: 'esm',
  jsx: 'automatic',
  jsxImportSource: 'preact',
  minify: true,
  sourcemap: false
}

async function copyStaticAssets() {
  await copyFile(resolve(root, 'src/panel/index.html'), resolve(root, 'panel/index.html'))
  await copyFile(resolve(root, 'src/panel/styles.css'), resolve(root, 'panel/styles.css'))
}

/**
 * Stages a clean, zero-node_modules plugin folder at ./plugin for local `orca plugin dev load/watch/inspect`
 * (Orca rejects symlinks in node_modules/.bin during content hashing).
 */
async function stageCleanPluginDir() {
  const stage = resolve(root, 'plugin')
  await mkdir(resolve(stage, 'dist'), { recursive: true })
  await mkdir(resolve(stage, 'panel'), { recursive: true })
  await mkdir(resolve(stage, 'assets'), { recursive: true })
  await Promise.all([
    copyFile(resolve(root, 'orca-plugin.json'), resolve(stage, 'orca-plugin.json')),
    copyFile(resolve(root, 'LICENSE'), resolve(stage, 'LICENSE')),
    copyFile(resolve(root, 'README.md'), resolve(stage, 'README.md')),
    copyFile(resolve(root, 'assets/icon.png'), resolve(stage, 'assets/icon.png')),
    copyFile(resolve(root, 'assets/cover.png'), resolve(stage, 'assets/cover.png')),
    copyFile(resolve(root, 'dist/worker.mjs'), resolve(stage, 'dist/worker.mjs')),
    copyFile(resolve(root, 'panel/index.html'), resolve(stage, 'panel/index.html')),
    copyFile(resolve(root, 'panel/app.js'), resolve(stage, 'panel/app.js')),
    copyFile(resolve(root, 'panel/styles.css'), resolve(stage, 'panel/styles.css'))
  ])
}

if (watchMode) {
  const stagePlugin = {
    name: 'stage-clean-plugin',
    setup(build) {
      build.onEnd(async (result) => {
        if (result.errors.length === 0) {
          await copyStaticAssets()
          await stageCleanPluginDir()
        }
      })
    }
  }
  const [workerCtx, panelCtx] = await Promise.all([
    esbuild.context({ ...workerOptions, plugins: [...workerOptions.plugins, stagePlugin] }),
    esbuild.context({ ...panelOptions, plugins: [stagePlugin] })
  ])
  await copyStaticAssets()
  await Promise.all([workerCtx.watch(), panelCtx.watch()])
  console.log('[sftp-bridge] watching worker and panel bundles (staged at ./plugin)...')
} else {
  await Promise.all([esbuild.build(workerOptions), esbuild.build(panelOptions), copyStaticAssets()])
  await stageCleanPluginDir()
  console.log('[sftp-bridge] built dist/worker.mjs, panel/app.js and staged clean ./plugin')
}
