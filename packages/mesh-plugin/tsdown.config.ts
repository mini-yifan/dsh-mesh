import { defineConfig } from 'tsdown'

/**
 * The desktop and phone installs do not run `pnpm install` for this package.
 * Bundle everything that is not a DSH host service, and leave `@deepseek-ai/*`
 * to the host's own module tree. Native WebRTC backends stay external because
 * v0 only uses Relay.
 */
export default defineConfig({
  entry: {
    index: 'src/index.ts',
    'device-agent': 'src/device-agent.ts',
    'return-files': 'src/return-files.ts',
  },
  format: ['esm'],
  platform: 'node',
  target: 'node22',
  outDir: 'bundle',
  dts: false,
  clean: true,
  sourcemap: false,
  deps: {
    neverBundle: [/^@deepseek-ai\//, /^node:/, 'werift', '@roamhq/wrtc'],
    alwaysBundle: [
      /^ds-harness-remote/,
      /^@dsh-remote\//,
      /^@dsh-mesh\//,
      /^@xterm\//,
      /^@noble\//,
      'ws',
      'zod',
      'qrcode',
    ],
  },
})