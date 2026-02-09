import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      '/search': 'http://localhost:3000',
      '/play': 'http://localhost:3000',
      '/playlist': 'http://localhost:3000',
      '/auth': 'http://localhost:3000'
    }
  }
})