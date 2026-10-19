import type { CapacitorConfig } from '@capacitor/cli'

const config: CapacitorConfig = {
  appId: 'com.dylanxzthomas.wren',
  appName: 'Daymark',
  webDir: 'web/dist',
  // Bridge debug output can include secure-store reads and OAuth return payloads.
  loggingBehavior: 'none',
  plugins: { PushNotifications: { presentationOptions: [] } },
  ios: { contentInset: 'never', backgroundColor: '#f7f7f3' },
}
export default config
