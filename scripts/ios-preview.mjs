import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { nativeEnvironment, run, savedPreviewDevice } from './ios-simulator.mjs'

process.chdir(join(dirname(fileURLToPath(import.meta.url)), '..'))
try {
  const args = process.argv.slice(2)
  if (args.some(arg => !['--check', '--light', '--dark'].includes(arg)) || args.includes('--light') && args.includes('--dark')) throw new Error('Use ios:preview with --light or --dark, or ios:doctor for a read-only setup check.')
  const { listing, target, version, viewer } = nativeEnvironment()
  console.log(`${version}\nRun destination: ${target.device.name} · iOS ${target.runtime.version}\nViewer: ${viewer ?? 'Open the run destination from Xcode.'}`)
  if (args.includes('--check')) {
    console.log('Native build prerequisites found. No simulator was created or changed; this is not a native test pass.')
  } else {
    run('npm', ['run', 'ios:sync'])
    // Keep Xcode's local simulator signature: Keychain/App Group entitlements
    // are absent when signing is disabled. No Apple development team is needed.
    run('xcodebuild', ['-project', 'ios/App/App.xcodeproj', '-scheme', 'App', '-sdk', 'iphonesimulator', '-destination', 'generic/platform=iOS Simulator', '-configuration', 'Debug', '-derivedDataPath', 'native-artifacts', 'build'])
    mkdirSync('native-artifacts', { recursive: true })
    const statePath = 'native-artifacts/preview-device.json'
    let saved
    if (existsSync(statePath)) {
      try { saved = JSON.parse(readFileSync(statePath, 'utf8')) } catch { /* Leave an unreadable record and all existing devices untouched. */ }
    }
    const existing = savedPreviewDevice(saved, listing, target)
    const name = `Daymark Preview · ${target.device.name} · iOS ${target.runtime.version}`
    const id = existing?.udid ?? run('xcrun', ['simctl', 'create', name, target.device.identifier, target.runtime.identifier], true)
    if (!existing) writeFileSync(statePath, JSON.stringify({ udid: id, name }, null, 2), { mode: 0o600 })
    if (existing?.state !== 'Booted') run('xcrun', ['simctl', 'boot', id])
    run('xcrun', ['simctl', 'bootstatus', id, '-b'])
    run('xcrun', ['simctl', 'ui', id, 'appearance', args.includes('--light') ? 'light' : 'dark'])
    run('xcrun', ['simctl', 'install', id, 'native-artifacts/Build/Products/Debug-iphonesimulator/App.app'])
    if (viewer) run('open', [viewer])
    run('xcrun', ['simctl', 'launch', id, 'com.dylanxzthomas.wren'])
    console.log(`Daymark launched on “${name}”. Select that device in Device Hub/Simulator. The simulator is retained for the next run. No existing simulator was erased.\nUse npm run test:native for the separate disposable-device check. Provider connections still require the dedicated development configuration in README.`)
  }
} catch (error) {
  console.error(error.message)
  process.exitCode = 1
}
