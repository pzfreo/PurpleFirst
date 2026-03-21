import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { execSync } from 'child_process'
import { writeFileSync } from 'fs'

const commitCount = execSync('git rev-list --count HEAD').toString().trim()
const commitHash = execSync('git rev-parse --short HEAD').toString().trim()
const version = `0.${commitCount}`

// Write version.json so deployed app can check for updates
writeFileSync('public/version.json', JSON.stringify({ version }))

export default defineConfig({
  base: '/PurpleFirst/',
  plugins: [react()],
  define: {
    __APP_VERSION__: JSON.stringify(version),
    __BUILD_HASH__: JSON.stringify(commitHash),
  },
})
