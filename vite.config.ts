import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { execSync } from 'child_process'

const commitCount = execSync('git rev-list --count HEAD').toString().trim()
const commitHash = execSync('git rev-parse --short HEAD').toString().trim()

export default defineConfig({
  base: '/PurpleFirst/',
  plugins: [react()],
  define: {
    __APP_VERSION__: JSON.stringify(`0.${commitCount}`),
    __BUILD_HASH__: JSON.stringify(commitHash),
  },
})
