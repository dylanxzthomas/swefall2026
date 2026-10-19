import { test } from 'node:test'
import assert from 'node:assert/strict'
import { selectIPhone, savedPreviewDevice, nativeViewer, nativeTestEnvironment, maestroXCTestArguments, run } from './ios-simulator.mjs'
const phone = (name, min = '26.0', max = '65535.0') => ({ name, identifier: name.replaceAll(' ', '-'), minRuntimeVersionString: min, maxRuntimeVersionString: max })
const runtime = (version, extra = {}) => ({ identifier: `com.apple.CoreSimulator.SimRuntime.iOS-${version}`, version, isAvailable: true, ...extra })
test('ends a stuck child at its deadline and reports unfinished acceptance', () => {
  assert.throws(() => run(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], true, { timeout: 30, killSignal: 'SIGKILL' }), /timed out after 30 ms\. Native acceptance is unfinished/)
})
test('selects only the HTTP entry for the affected Maestro driver, without changing app tests or future versions', () => {
  const args = ['test-without-building', '-xctestrun', '/temporary/maestro-driver-ios-config.xctestrun', '-destination', 'id=disposable']
  assert.deepEqual(maestroXCTestArguments(args, '2.11.0'), [...args, '-only-testing:maestro-driver-iosUITests/maestro_driver_iosUITests/testHttpServer'])
  assert.equal(args.length, 5)
  for (const [other, version] of [[args, '2.12.0'], [['-version'], '2.11.0'], [['test-without-building'], '2.11.0'], [[...args.slice(0, 2), '/temporary/App.xctestrun'], '2.11.0'], [[...args, '-only-testing:existing'], '2.11.0']]) {
    assert.equal(maestroXCTestArguments(other, version), other)
  }
})
test('finds Homebrew Java for native tests without modifying system configuration', () => {
  const environment = { PATH: '/synthetic', JAVA_HOME: '/configured-java' }
  const existing = ['/configured-java/bin/java', '/opt/homebrew/opt/openjdk/libexec/openjdk.jdk/Contents/Home/bin/java']
  assert.equal(nativeTestEnvironment(environment, path => existing.includes(path)).JAVA_HOME, environment.JAVA_HOME)
  const discovered = nativeTestEnvironment({ PATH: '/synthetic' }, path => existing.includes(path))
  assert.equal(discovered.JAVA_HOME, '/opt/homebrew/opt/openjdk/libexec/openjdk.jdk/Contents/Home')
  assert.equal(discovered.PATH, '/synthetic')
  const missing = { PATH: '/synthetic' }
  assert.equal(nativeTestEnvironment(missing, () => false).PATH, missing.PATH)
  assert.equal(nativeTestEnvironment(missing, () => false).MAESTRO_CLI_NO_ANALYTICS, '1')
  assert.deepEqual(missing, { PATH: '/synthetic' })
})
test('finds Xcode 27 Device Hub and older Simulator locations without guessing an installed app', () => {
  const developer = '/Applications/Xcode.app/Contents/Developer'
  const hub = '/Applications/Xcode.app/Contents/Applications/DeviceHub.app'
  const simulator = developer + '/Applications/Simulator.app'
  assert.equal(nativeViewer(developer, path => path === hub || path === simulator), hub)
  assert.equal(nativeViewer(developer, path => path === simulator), simulator)
  assert.equal(nativeViewer(developer, () => false), undefined)
})
test('prefers the demo phone on an available compatible iOS runtime', () => {
  const listing = { runtimes: [runtime('26.0'), runtime('27.0'), runtime('28.0', { isAvailable: false })], devicetypes: [phone('iPhone 17 Pro'), phone('iPhone 18 Pro', '27.0')] }
  const selected = selectIPhone(listing)
  assert.equal(selected.runtime.version, '27.0')
  assert.equal(selected.device.name, 'iPhone 17 Pro')
})
test('ignores unsupported and retired phones and does not rely on list order', () => {
  const selected = selectIPhone({ runtimes: [runtime('26.0', { supportedDeviceTypes: [{ identifier: 'iPhone-16' }] })], devicetypes: [phone('iPhone 18', '27.0'), phone('iPhone 16', '26.0.0'), phone('iPhone 6', '8.0', '12.5')] })
  assert.equal(selected.device.name, 'iPhone 16')
  assert.throws(() => selectIPhone({ runtimes: [runtime('25.0')], devicetypes: [phone('iPhone 17 Pro')] }), /No compatible/)
})
test('never adopts a user device by name alone or reuses a mismatched saved ID', () => {
  const target = { runtime: runtime('27.0'), device: phone('iPhone 17 Pro') }
  const device = { udid: 'owned', name: 'Daymark Preview · iPhone 17 Pro · iOS 27.0', isAvailable: true, deviceTypeIdentifier: target.device.identifier }
  const listing = { devices: { [target.runtime.identifier]: [device] } }
  assert.equal(savedPreviewDevice(undefined, listing, target), undefined)
  assert.equal(savedPreviewDevice({ udid: 'other', name: device.name }, listing, target), undefined)
  assert.equal(savedPreviewDevice({ udid: device.udid, name: 'Different' }, listing, target), undefined)
  assert.equal(savedPreviewDevice(device, listing, target), device)
  assert.equal(savedPreviewDevice(device, listing, { ...target, device: phone('iPhone 16') }), undefined)
})
