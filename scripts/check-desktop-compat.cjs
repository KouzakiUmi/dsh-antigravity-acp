// Run with the installed Desktop Electron in Node mode after npm run build.
// No Profile is loaded, no subprocess is spawned, and neither adapter is asked for models or generation.
const assert = require('node:assert/strict')
const fs = require('node:fs')
const { registerHooks } = require('node:module')
const { tmpdir } = require('node:os')
const path = require('node:path')
const { pathToFileURL } = require('node:url')

async function main() {
  const installDir = process.env.DSH_INSTALL_DIR
  if (!process.versions.electron || !installDir || path.basename(installDir) !== 'app.asar') {
    throw new Error('Run with the installed Desktop Electron, ELECTRON_RUN_AS_NODE=1, and DSH_INSTALL_DIR pointing to app.asar')
  }
  const modules = path.join(installDir, 'node_modules')
  const rootDir = path.join(__dirname, '..')
  const dist = pathToFileURL(path.join(rootDir, 'dist') + path.sep).href
  const readManifest = (dir) => JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'))
  const manifest = readManifest(rootDir)
  const host = (pkg) => {
    const dir = path.join(modules, pkg)
    return pathToFileURL(path.join(dir, readManifest(dir).main)).href
  }
  const peers = new Set(Object.keys(manifest.peerDependencies))
  const semver = require(path.join(modules, 'semver'))
  for (const name of peers) {
    const version = readManifest(path.join(modules, name)).version
    const range = manifest.peerDependencies[name]
    assert(semver.satisfies(version, range), `${name}@${version} fails the npm peer range ${range}`)
    if (name.startsWith('@deepseek-ai/dsh-')) {
      const runtime = readManifest(path.join(modules, '@deepseek-ai/dsh-app-boot')).version
      assert(semver.satisfies(runtime, range, { includePrerelease: true }), `${name} peer range rejects DSH ${runtime}`)
    }
  }
  // Bind only the plugin's peer imports to the installed packages; other imports use the project lockfile.
  registerHooks({
    resolve(specifier, context, next) {
      return next(context.parentURL?.startsWith(dist) && peers.has(specifier) ? host(specifier) : specifier, context)
    },
  })
  const [{ Context }, { default: Llm, LlmError }, { default: Typert }, bundle, router, { llmError }] = await Promise.all([
    import(host('@deepseek-ai/cordis')),
    import(host('@deepseek-ai/dsh-llm')),
    import(host('@deepseek-ai/dsh-typert-registry')),
    import(dist + 'index.js'),
    import(dist + 'proxy/index.js'),
    import(dist + 'runtime/llm-error.js'),
  ])
  const scratch = fs.mkdtempDisposableSync(path.join(fs.realpathSync(tmpdir()), 'dsh-agy-compat-'))
  // Applying the Host prunes its stale cache and runtime directories; use fresh roots.
  process.env.DSH_HOME = path.join(scratch.path, 'profile')
  process.env.AGY_ACP_HOME = path.join(scratch.path, 'install')
  const ctx = new Context()
  const typertFiber = ctx.plugin(Typert)
  const llmFiber = ctx.plugin(Llm)
  ctx.provide('subprocess', { spawn() { assert.fail('Unexpected subprocess') } })
  // Start in proxy mode without warmup or binary prefetch; update through the same event as the Loader.
  const config = { proxyMode: true }
  let hostFiber, routerFiber
  try {
    await Promise.all([typertFiber.inertia, llmFiber.inertia])
    hostFiber = ctx.plugin({ inject: ['llm', 'subprocess'], apply(scope) { bundle.apply(scope, config) } })
    await hostFiber.inertia
    routerFiber = ctx.plugin(router)
    await routerFiber.inertia
    const providers = () => ctx.llm.listProviders().map(({ id }) => id)
    assert.deepEqual(providers(), ['antigravity-proxy'])
    assert.equal(ctx.typert.listPackages().filter(({ package: name }) => name === manifest.name).length, 1)

    const cause = new Error('fixture cause')
    const failure = llmError('fixture diagnostic', 'AGY_LINK_CLOSED', { status: 503, providerRetryAfterMs: 50, cause })
    assert(failure instanceof LlmError)
    assert.deepEqual(failure.failure, { message: 'fixture diagnostic', code: 'AGY_LINK_CLOSED', status: 503, providerRetryAfterMs: 50 })
    assert.equal(failure.cause, cause)

    config.proxyMode = false
    ctx.emit('loader/volatile-update', [['proxyMode']])
    assert.deepEqual(providers(), ['antigravity-acp'])
    config.proxyMode = true
    ctx.emit('loader/volatile-update', [['proxyMode']])
    assert.deepEqual(providers(), ['antigravity-proxy'])

    await routerFiber.dispose()
    routerFiber = undefined
    assert.deepEqual(providers(), [])
    await hostFiber.dispose()
    hostFiber = undefined
    assert.equal(ctx.typert.getPackage(manifest.name, 'host'), undefined)
    console.log(`PASS: ${readManifest(installDir).version} / DSH ${readManifest(path.join(modules, '@deepseek-ai/dsh')).version}, peer ranges, LLM routes, Typert registration and cleanup, custom failures`)
  } finally {
    try {
      await routerFiber?.dispose()
      await hostFiber?.dispose()
      await llmFiber.dispose()
      await typertFiber.dispose()
    } finally {
      scratch.remove()
    }
  }
}

main().catch((error) => { console.error(error); process.exitCode = 1 })
