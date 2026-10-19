import { spawnSync } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { chmodSync, cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { nativeEnvironment, nativeTestEnvironment, run as command } from './ios-simulator.mjs'

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const require = createRequire(import.meta.url), xcode = require('xcode')
const bundle = 'com.dylanxzthomas.wren.nativeacceptance'
const sources = ['ios/App/App/DaymarkKeychain.swift', 'ios/App/App/DaymarkCalendar.swift', 'ios/App/DaymarkShare/ShareViewController.swift']

export function prepareNativeBoundaries(destination) {
  const stage = resolve(destination)
  if (!stage.startsWith(join(repo, 'native-artifacts') + '/') || existsSync(stage)) throw new Error('Prepare into a new directory under native-artifacts; existing work is never overwritten.')
  mkdirSync(stage, { recursive: true, mode: 0o700 })
  cpSync(join(repo, 'ios'), join(stage, 'ios'), { recursive: true, filter: path => !path.includes('/xcuserdata/') && !path.includes('/.build/') })
  symlinkSync(join(repo, 'node_modules'), join(stage, 'node_modules'), 'dir')
  const app = join(stage, 'ios/App/App')
  for (const name of ['SceneDelegate.swift', 'NativeBoundaryController.swift']) cpSync(join(repo, 'tests/native/boundaries', name), join(app, name))
  const projectPath = join(stage, 'ios/App/App.xcodeproj/project.pbxproj'), project = xcode.project(projectPath)
  project.parseSync()
  project.addSourceFile('NativeBoundaryController.swift', { target: '504EC3031FED79650016851F' }, '504EC3061FED79650016851F')
  for (const value of Object.values(project.pbxXCBuildConfigurationSection())) {
    if (typeof value !== 'object') continue
    const settings = value.buildSettings
    if (settings?.PRODUCT_BUNDLE_IDENTIFIER === 'com.dylanxzthomas.wren') settings.PRODUCT_BUNDLE_IDENTIFIER = bundle
    if (settings?.PRODUCT_BUNDLE_IDENTIFIER === 'com.dylanxzthomas.wren.share') settings.PRODUCT_BUNDLE_IDENTIFIER = bundle + '.share'
    if (settings) settings.IPHONEOS_DEPLOYMENT_TARGET = '17.0'
  }
  writeFileSync(projectPath, project.writeSync())
  // Only the copied test host changes. It contains no WebView/backend configuration.
  command('python3', ['-c', `import plistlib,sys
p=sys.argv[1]
with open(p,'rb') as f: v=plistlib.load(f)
v['CFBundleDisplayName']='Daymark Native Acceptance'
v.pop('UIMainStoryboardFile',None)
v.pop('CFBundleURLTypes',None)
v.pop('NSMicrophoneUsageDescription',None)
v.pop('NSSpeechRecognitionUsageDescription',None)
for c in v['UIApplicationSceneManifest']['UISceneConfigurations']['UIWindowSceneSessionRoleApplication']: c.pop('UISceneStoryboardFile',None)
with open(p,'wb') as f: plistlib.dump(v,f)
`, join(app, 'Info.plist')], true)
  // Remove the copied browser payload so the test binary cannot load a household or connect.
  rmSync(join(app, 'public'), { recursive: true, force: true }); mkdirSync(join(app, 'public'))
  writeFileSync(join(app, 'public/index.html'), '<!doctype html><title>Native acceptance only</title>')
  writeFileSync(join(app, 'capacitor.config.json'), JSON.stringify({ appId: bundle, appName: 'Daymark Native Acceptance', webDir: 'public' }))
  const manifest = { evidence: 'Synthetic native boundary host; not parent UI or connected acceptance', bundle, copiedProductionSources: Object.fromEntries(sources.map(path => [path, createHash('sha256').update(readFileSync(join(repo, path))).digest('hex')])) }
  writeFileSync(join(stage, 'source-manifest.json'), JSON.stringify(manifest, null, 2), { mode: 0o600 })
  return { stage, project: join(stage, 'ios/App/App.xcodeproj'), manifest }
}

async function main() {
  process.chdir(repo)
  const args = process.argv.slice(2)
  const calendarOnly = (args[0] === '--calendar-run' && args.length === 1) || (['--calendar-api', '--calendar-rebuild'].includes(args[0]) && args.length === 2)
  const retry = ['--retry', '--calendar-api'].includes(args[0]) && args.length === 2, reuse = ['--retry', '--rebuild', '--calendar-api', '--calendar-rebuild'].includes(args[0]) && args.length === 2
  if (!reuse && (args.some(arg => !['--prepare', '--run', '--calendar-run'].includes(arg)) || args.length !== 1)) throw new Error('Use --prepare, --run, --calendar-run, --retry <test build>, --rebuild <test build>, --calendar-api <test build>, or --calendar-rebuild <test build>. Every execution creates its own new simulator.')
  let prepared
  if (reuse) {
    const stage = resolve(args[1])
    if (!stage.startsWith(join(repo, 'native-artifacts/boundaries-'))) throw new Error('Only an existing boundary-test build can be retried.')
    const manifest = JSON.parse(readFileSync(join(stage, 'source-manifest.json'), 'utf8'))
    if (manifest.bundle !== bundle || sources.some(path => createHash('sha256').update(readFileSync(join(repo, path))).digest('hex') !== manifest.copiedProductionSources[path])) throw new Error('Production native source changed. Use --run to build the latest host.')
    if (retry && ['SceneDelegate.swift', 'NativeBoundaryController.swift'].some(name => !readFileSync(join(repo, 'tests/native/boundaries', name)).equals(readFileSync(join(stage, 'ios/App/App', name))))) throw new Error('Native test source changed. Use --rebuild for this isolated host.')
    if (!existsSync(join(stage, 'derived/Build/Products/Debug-iphonesimulator/App.app')) || !readFileSync(join(stage, 'build.log'), 'utf8').includes('** BUILD SUCCEEDED **')) throw new Error('The previous native build did not succeed. Use --run.')
    if (!retry) for (const name of ['SceneDelegate.swift', 'NativeBoundaryController.swift']) cpSync(join(repo, 'tests/native/boundaries', name), join(stage, 'ios/App/App', name))
    prepared = { stage, project: join(stage, 'ios/App/App.xcodeproj'), manifest }
  } else prepared = prepareNativeBoundaries(join(repo, 'native-artifacts', `boundaries-${Date.now()}-${randomUUID().slice(0, 8)}`))
  console.log(`Prepared native test host: ${prepared.stage}`)
  if (args[0] === '--prepare') return
  const environment = nativeTestEnvironment(), run = (tool, values, capture = true, options = {}) => command(tool, values, capture, { env: environment, ...options })
  const { target: { runtime, device } } = nativeEnvironment()
  if (device.name !== 'iPhone 17 Pro') throw new Error('The native Share-sheet coordinate workaround is verified only on iPhone 17 Pro. Install that simulator device type before running this suite.')
  const derived = join(prepared.stage, 'derived'), results = join(prepared.stage, reuse ? `results-${Date.now()}` : 'results')
  mkdirSync(results)
  const buildLog = join(prepared.stage, 'build.log')
  if (!retry) {
    const build = spawnSync('xcodebuild', ['-project', prepared.project, '-scheme', 'App', '-sdk', 'iphonesimulator', '-destination', 'generic/platform=iOS Simulator', '-configuration', 'Debug', '-derivedDataPath', derived, '-clonedSourcePackagesDirPath', join(repo, 'native-artifacts/SourcePackages'), '-disableAutomaticPackageResolution', '-onlyUsePackageVersionsFromResolvedFile', '-jobs', '2', 'build'], { env: environment, encoding: 'utf8', timeout: 12 * 60000, maxBuffer: 64 * 1024 * 1024 })
    writeFileSync(buildLog, (build.stdout ?? '') + (build.stderr ?? ''))
    if (build.status !== 0) throw new Error(`Native boundary build failed; inspect ${buildLog}. No simulator has been changed.`)
  }
  const version = calendarOnly ? undefined : run('maestro', ['--version']).match(/^\s*(\d+\.\d+\.\d+)\s*$/m)?.[1]
  if (version === '2.11.0') {
    const wrapper = join(prepared.stage, 'driver-bin'); mkdirSync(wrapper, { recursive: true })
    const xcodebuild = run('xcrun', ['--find', 'xcodebuild'])
    const path = join(wrapper, 'xcodebuild')
    writeFileSync(path, `#!${process.execPath}\nimport { spawnSync } from 'node:child_process'\nimport { maestroXCTestArguments } from ${JSON.stringify(new URL('./ios-simulator.mjs', import.meta.url).href)}\nconst result = spawnSync(${JSON.stringify(xcodebuild)}, maestroXCTestArguments(process.argv.slice(2), ${JSON.stringify(version)}), { stdio: 'inherit', env: process.env })\nprocess.exit(result.status ?? 1)\n`)
    chmodSync(path, 0o700); environment.PATH = `${wrapper}:${environment.PATH ?? ''}`
  }
  let id, output
  const summary = []
  try {
    id = run('xcrun', ['simctl', 'create', `Daymark Native Boundaries ${randomUUID()}`, device.identifier, runtime.identifier])
    writeFileSync(join(results, 'owned-device.json'), JSON.stringify({ udid: id, createdByThisInvocation: true }), { mode: 0o600 })
    run('xcrun', ['simctl', 'boot', id]); writeFileSync(join(results, 'boot.log'), run('xcrun', ['simctl', 'bootstatus', id, '-b'], true, { timeout: 180000 }))
    run('xcrun', ['simctl', 'install', id, join(derived, 'Build/Products/Debug-iphonesimulator/App.app')])
    const container = run('xcrun', ['simctl', 'get_app_container', id, bundle, 'data']); output = join(container, 'Documents/NativeBoundaries')
    const launch = name => {
      spawnSync('xcrun', ['simctl', 'terminate', id, bundle], { stdio: 'ignore', env: environment })
      run('xcrun', ['simctl', 'launch', id, bundle, '--case', name], true, { env: { ...environment, SIMCTL_CHILD_TZ: 'UTC' } })
    }
    const collect = async name => {
      const path = join(output, `result-${name}.json`), started = Date.now()
      while (!existsSync(path) && Date.now() - started < 60000) await new Promise(resolve => setTimeout(resolve, 300))
      if (!existsSync(path)) throw new Error(`Native ${name} did not report a result within 60 seconds.`)
      const result = JSON.parse(readFileSync(path, 'utf8')); cpSync(path, join(results, `result-${name}.json`)); summary.push(result)
      console.log(`${result.passed ? 'PASS' : 'FAIL'} ${name}: ${result.checks.length} native checks`)
      if (!result.passed) throw new Error(`Native ${name} failed: ${result.error}`)
    }
    const perform = async name => { launch(name); await collect(name) }
    const maestro = file => run('maestro', ['--device', id, 'test', '--format', 'junit', '--output', join(results, file + '.xml'), join(repo, 'tests/native/boundaries', file + '.yaml')], false, { timeout: 6 * 60000, killSignal: 'SIGKILL' })
    if (calendarOnly) {
      // Explicit plugin-only evidence. This grants only the disposable test app's
      // Calendar service; it does not establish the native permission prompt UI.
      run('xcrun', ['simctl', 'privacy', id, 'grant', 'calendar', bundle])
    } else {
      await perform('keychain-write'); await perform('keychain-relaunch'); await perform('intake-atomic')
      launch('share'); maestro('share'); await collect('share-pdf'); await collect('calendar-permission')
    }
    await perform('calendar-create'); await perform('calendar-recover')
    run('xcrun', ['simctl', 'privacy', id, 'revoke', 'calendar', bundle])
    await perform('calendar-denied')
    run('xcrun', ['simctl', 'privacy', id, 'grant', 'calendar', bundle])
    await perform('calendar-cleanup')
    run('xcrun', ['simctl', 'io', id, 'screenshot', join(results, 'native-cleanup.png')])
  } finally {
    try {
      // Preserve completed evidence even when a later system-UI selector fails.
      // Only this invocation's synthetic app container is read before disposal.
      if (output && existsSync(output)) for (const name of readdirSync(output).filter(name => /^result-[a-z-]+\.json$/.test(name))) {
        const path = join(output, name), result = JSON.parse(readFileSync(path, 'utf8'))
        cpSync(path, join(results, name))
        if (!summary.some(saved => saved.case === result.case)) summary.push(result)
      }
      writeFileSync(join(results, 'summary.json'), JSON.stringify({ source: prepared.manifest, permissionSetup: calendarOnly ? 'Simulator Calendar service grant; permission prompt UI unverified' : 'Native prompt flow requested; inspect calendar-permission result for completion', results: summary }, null, 2), { mode: 0o600 })
    } finally {
      // This id comes solely from this invocation's create call. Never select/adopt another device.
      if (id) { spawnSync('xcrun', ['simctl', 'shutdown', id], { stdio: 'ignore' }); const deleted = spawnSync('xcrun', ['simctl', 'delete', id], { stdio: 'ignore' }); if (deleted.status !== 0) { console.error(`Task-created simulator cleanup needs retry: ${id}`); process.exitCode = 1 } }
    }
  }
  console.log(`${calendarOnly ? 'Native EventKit API' : 'Native API and Share extension'} evidence: ${results}. This is not connected/physical-iPhone acceptance.`)
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main().catch(error => { console.error(error.message); process.exitCode = 1 })
