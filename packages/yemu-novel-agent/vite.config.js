import { defineConfig } from 'vite'

const codespacesHost = process.env.CODESPACE_NAME
  ? `${process.env.CODESPACE_NAME}-5173.${process.env.GITHUB_CODESPACES_PORT_FORWARDING_DOMAIN || 'app.github.dev'}`
  : null

export default defineConfig({
  server: {
    allowedHosts: codespacesHost ? [codespacesHost] : [],
    proxy: {
      '/api': 'http://127.0.0.1:8787',
    },
  },
})
