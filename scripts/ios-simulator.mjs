import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'

export function run(tool, args, capture = false, options = {}) {
  const result = spawnSync(tool, args, { encoding: 'utf8', stdio: capture ? 'pipe' : 'inherit', ...options })
  if (result.error?.code === 'ETIMEDOUT') throw new Error(`${tool} ${args[0] ?? ''} timed out after ${options.timeout} ms. Native acceptance is unfinished.`)
  if (result.status !== 0) throw new Error(`${tool} ${args[0] ?? ''} failed. ${capture ? result.stderr?.trim() || result.error?.message || '' : 'See the output above.'}`)
  return result.stdout?.trim()
}
export function nativeTestEnvironment(environment = process.env, exists = existsSync) {
  // Homebrew keeps Java keg-only. Scope discovery to the test process; do not
  // change login files or create administrator-owned system symlinks.
  const scoped = { ...environment, MAESTRO_CLI_NO_ANALYTICS: '1', MAESTRO_CLI_ANALYSIS_NOTIFICATION_DISABLED: 'true' }
  if (environment.JAVA_HOME && exists(join(environment.JAVA_HOME, 'bin/java'))) return scoped
  for (const prefix of ['/opt/homebrew', '/usr/local']) {
    const java = join(prefix, 'opt/openjdk/libexec/openjdk.jdk/Contents/Home')
    if (exists(join(java, 'bin/java'))) return { ...scoped, JAVA_HOME: java }
  }
  return scoped
}
export function maestroXCTestArguments(args, version) {
  // Maestro 2.11.0's bundled descriptor also selects its own driver unit tests.
  // On Xcode 27 those can stall before the long-running HTTP server test starts.
  // Constrain only this known descriptor; app tests and future versions pass through.
  const descriptor = args[args.indexOf('-xctestrun') + 1]
  if (version !== '2.11.0' || args[0] !== 'test-without-building' || !args.includes('-xctestrun') ||
      !descriptor || basename(descriptor) !== 'maestro-driver-ios-config.xctestrun' ||
      args.some(arg => arg === '-only-testing' || arg.startsWith('-only-testing:'))) return args
  return [...args, '-only-testing:maestro-driver-iosUITests/maestro_driver_iosUITests/testHttpServer']
}
const compare = (a, b) => a.localeCompare(b, undefined, { numeric: true })
const compareVersion = (a, b) => {
  const left = a.split('.').map(Number), right = b.split('.').map(Number)
  for (let i = 0; i < Math.max(left.length, right.length); i++) {
    const difference = (left[i] ?? 0) - (right[i] ?? 0)
    if (difference) return difference
  }
  return 0
}
export function selectIPhone(listing) {
  const runtimes = listing.runtimes.filter(r => r.isAvailable && r.identifier.includes('.iOS-')).sort((a, b) => compareVersion(b.version, a.version))
  for (const runtime of runtimes) {
    const compatible = listing.devicetypes.filter(d => d.name.startsWith('iPhone') &&
      (!runtime.supportedDeviceTypes?.length || runtime.supportedDeviceTypes.some(t => (typeof t === 'string' ? t : t.identifier) === d.identifier)) &&
      (!d.minRuntimeVersionString || compareVersion(runtime.version, d.minRuntimeVersionString) >= 0) &&
      (!d.maxRuntimeVersionString || compareVersion(runtime.version, d.maxRuntimeVersionString) <= 0))
    const device = compatible.find(d => d.name === 'iPhone 17 Pro') ?? compatible.sort((a, b) => compare(b.name, a.name))[0]
    if (device) return { runtime, device }
  }
  throw new Error('No compatible iPhone simulator runtime is installed. In Xcode Settings → Components, install iOS platform support, then rerun ios:doctor.')
}
export function savedPreviewDevice(saved, listing, target) {
  // Reuse only the simulator recorded by this launcher, never a user's similarly named device.
  return (listing.devices[target.runtime.identifier] ?? []).find(d => d.udid === saved?.udid && d.name === saved?.name && d.name.startsWith('Daymark Preview · ') && d.deviceTypeIdentifier === target.device.identifier && d.isAvailable)
}
export function nativeViewer(developer, exists = existsSync) {
  // Xcode 27 moved developer apps next to Contents/Developer.
  const locations = [join(dirname(developer), 'Applications'), join(developer, 'Applications')]
  for (const name of ['DeviceHub.app', 'Device Hub.app', 'Simulator.app']) {
    const path = locations.map(location => join(location, name)).find(exists)
    if (path) return path
  }
}
export function nativeEnvironment() {
  if (process.platform !== 'darwin') throw new Error('The iPhone environment requires macOS with full Xcode.')
  const macOS = run('sw_vers', ['-productVersion'], true)
  const developer = process.env.DEVELOPER_DIR ?? run('xcode-select', ['-p'], true)
  if (!existsSync(join(developer, 'usr/bin/xcodebuild'))) throw new Error(`Full Xcode is missing or not selected. This Mac runs macOS ${macOS}; check the Xcode/macOS requirements in docs/IPHONE.md first. Active developer directory: ${developer}. Install compatible Xcode 26 or newer (27 for Device Hub) and iOS platform support, open it to finish setup, then select it in Xcode Settings → Locations → Command Line Tools. No system settings have been changed.`)
  const version = run('xcodebuild', ['-version'], true)
  if (Number(version.match(/Xcode (\d+)/)?.[1] ?? 0) < 26) throw new Error('Capacitor 8 needs Xcode 26 or newer. Use Xcode 27 for the Device Hub interface shown in Riley’s demo.')
  const listing = JSON.parse(run('xcrun', ['simctl', 'list', '--json'], true))
  const target = selectIPhone(listing)
  return { listing, target, version, viewer: nativeViewer(developer) }
}
