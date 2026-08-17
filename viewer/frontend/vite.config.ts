import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  server: {
    port: 3000,
    // strictPort: 3000 が埋まっていたら黙って別ポートへドリフトせず即エラー終了する。
    // (以前は port 占有時に vite が 3001+ へずれて起動し、dev.sh が :3000 と誤表示していた)
    strictPort: true,
    proxy: {
      '/api': 'http://localhost:3001',
    },
  },
})
