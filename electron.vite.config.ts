import { resolve } from 'node:path';
import { defineConfig } from 'electron-vite';
import react from '@vitejs/plugin-react';
import { visualizer } from 'rollup-plugin-visualizer';

const ANALYZE = process.env.ANALYZE === '1';

// electron-vite v5 : `build.externalizeDeps` activé par défaut → plus besoin
// d'`externalizeDepsPlugin`. Les natifs (node-pty, pidusage) restent externalisés
// automatiquement via la lecture de package.json.
export default defineConfig({
  main: {
    resolve: {
      alias: {
        '@shared': resolve('src/shared')
      }
    },
    build: {
      rollupOptions: {
        // node-pty et pidusage ont du natif (.node) → on garde la garantie
        // d'externalisation explicite, indépendante du parsing de package.json.
        external: ['node-pty', 'pidusage']
      }
    }
  },
  preload: {
    resolve: {
      alias: {
        '@shared': resolve('src/shared')
      }
    }
  },
  renderer: {
    root: 'src/renderer',
    resolve: {
      alias: {
        '@': resolve('src/renderer/src'),
        '@shared': resolve('src/shared')
      }
    },
    plugins: [
      react(),
      ...(ANALYZE
        ? [
            visualizer({
              filename: 'bundle-stats.html',
              open: true,
              gzipSize: true,
              brotliSize: true,
              template: 'treemap'
            })
          ]
        : [])
    ],
    server: {
      // Port "exotique" pour éviter les collisions avec les dev servers usuels
      // (5173 = Vite app, 3000 = Next.js, 8000 = Python http.server, 8080 = divers).
      // Si on garde 5173, le PreviewPane risque de charger l'UI cmux elle-même
      // quand l'app utilisateur démarre sur le même port.
      port: 5183,
      strictPort: false
    },
    build: {
      rollupOptions: {
        input: {
          index: resolve('src/renderer/index.html')
        }
      }
    }
  }
});
