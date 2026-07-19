import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { pgBridge } from './server/pgBridge.ts'

// https://vite.dev/config/
export default defineConfig({
  // relative base so the static build works on GitHub Pages under any repo name
  base: './',
  plugins: [react(), pgBridge()],
})
