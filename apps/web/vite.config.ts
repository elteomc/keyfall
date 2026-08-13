import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vite'

// The typing layer is consumed straight from source so a change there shows up
// in the running game without a build step in between.
export default defineConfig({
  resolve: {
    alias: {
      '@keyfall/typing-core': fileURLToPath(
        new URL('../../packages/typing-core/src/index.ts', import.meta.url),
      ),
    },
  },
  server: {
    open: false,
  },
})
