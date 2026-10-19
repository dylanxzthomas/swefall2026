import type { AuthConfig } from 'convex/server'
export default { providers: [
  { domain: process.env.AUTH0_DOMAIN!, applicationID: process.env.AUTH0_CLIENT_ID! },
  ...(process.env.AUTH0_NATIVE_CLIENT_ID ? [{ domain: process.env.AUTH0_DOMAIN!, applicationID: process.env.AUTH0_NATIVE_CLIENT_ID }] : []),
] } satisfies AuthConfig
