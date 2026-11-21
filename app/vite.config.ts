import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  // The engine worker (src/engine/worker.ts) is an ES module worker that imports the
  // WebAssembly bindings from src/wasm/pkg (built by `pnpm build:wasm`).
  worker: { format: 'es' },
  build: { target: 'es2022' },
})
