import { spawnSync } from 'node:child_process'
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { nativeEnvironment, nativeTestEnvironment, run as command } from './ios-simulator.mjs'
const environment = nativeTestEnvironment()
const run = (tool, args, capture = false) => command(tool, args, capture, {
  env: environment,
  // Maestro's Java shutdown hooks can also stall after a runtime crash. End
  // only this child at the deadline, then let finally remove our test device.
  ...(tool === 'maestro' && args.includes('test') ? { timeout: 6 * 60_000, killSignal: 'SIGKILL' } : {}),
})
const { target: { runtime, device } } = nativeEnvironment()
const version = run('maestro', ['--version'], true).match(/^\s*(\d+\.\d+\.\d+)\s*$/m)?.[1]
console.log(`Maestro ${version ?? 'version unavailable'}`)
let id, driverScope
mkdirSync('native-artifacts', { recursive: true })
try {
  if (version === '2.11.0') {
    const xcodebuild = run('xcrun', ['--find', 'xcodebuild'], true)
    driverScope = mkdtempSync(join(tmpdir(), 'daymark-maestro-'))
    const wrapper = join(driverScope, 'xcodebuild')
    writeFileSync(wrapper, `#!${process.execPath}\nimport { spawnSync } from 'node:child_process'\nimport { maestroXCTestArguments } from ${JSON.stringify(new URL('./ios-simulator.mjs', import.meta.url).href)}\nconst result = spawnSync(${JSON.stringify(xcodebuild)}, maestroXCTestArguments(process.argv.slice(2), ${JSON.stringify(version)}), { stdio: 'inherit', env: process.env })\nprocess.exit(result.status ?? 1)\n`)
    chmodSync(wrapper, 0o700)
    environment.PATH = `${driverScope}:${environment.PATH ?? ''}`
    console.log('Selecting only Maestro’s HTTP driver test for this process (2.11.0/Xcode compatibility).')
  }
  id = run('xcrun', ['simctl', 'create', `DaymarkVerification-${Date.now()}`, device.identifier, runtime.identifier], true)
  run('xcrun', ['simctl', 'boot', id]); run('xcrun', ['simctl', 'bootstatus', id, '-b'])
  for (const appearance of ['light', 'dark']) {
    // A fresh app container keeps both appearances independent, even if the
    // automation driver's clearState behavior changes. Only our disposable device.
    if (appearance === 'dark') run('xcrun', ['simctl', 'uninstall', id, 'com.dylanxzthomas.wren'])
    run('xcrun', ['simctl', 'install', id, 'native-artifacts/Build/Products/Debug-iphonesimulator/App.app'])
    run('xcrun', ['simctl', 'ui', id, 'appearance', appearance])
    run('maestro', ['--device', id, 'test', '--format', 'junit', '--output', `native-artifacts/maestro-${appearance}.xml`, 'tests/native/compatibility.yaml'])
    run('xcrun', ['simctl', 'io', id, 'screenshot', `native-artifacts/saved-plan-${appearance}.png`])
  }
} finally {
  // Never erase a user simulator or its data; this ID was created by this invocation.
  if (id) { spawnSync('xcrun', ['simctl', 'shutdown', id]); spawnSync('xcrun', ['simctl', 'delete', id]) }
  if (driverScope) rmSync(driverScope, { recursive: true, force: true })
}
