import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import path from 'path';

export default defineConfig(({ mode }) => {
  const env = { ...loadEnv(mode, process.cwd(), ''), ...process.env };
  const apiTarget = env.API_URL || 'http://localhost:8080';
  const allowedHosts = (env.VITE_ALLOWED_HOSTS || 'localhost,127.0.0.1')
    .split(',')
    .map(host => host.trim().toLowerCase())
    .filter(Boolean);
  const isAllowedHost = (host: string | undefined) => {
    if (!host) return false;
    try {
      return allowedHosts.includes(new URL(`http://${host}`).hostname.toLowerCase());
    } catch {
      return false;
    }
  };

  return {
    plugins: [react(), tailwindcss()],
    resolve: {
      alias: {
        '@': path.resolve(__dirname, './src'),
      },
    },
    server: {
      host: env.HOST || '127.0.0.1',
      port: 8081,
      allowedHosts,
      proxy: {
        '/api': apiTarget,
        '/ws': {
          target: apiTarget.replace('http', 'ws'),
          ws: true,
          configure(proxy) {
            proxy.on('proxyReqWs', (_proxyReq, req, socket) => {
              if (!isAllowedHost(req.headers.host)) socket.destroy();
            });
          },
        },
      },
    },
  };
});
