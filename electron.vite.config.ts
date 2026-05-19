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
        // Two entries: the app main, and the PTY Host utilityProcess.
        input: {
          index: resolve('src/main/index.ts'),
          'pty-host': resolve('src/main/pty-host/entry.ts')
        },
        // node-pty / pidusage have native .node — keep externalized so the
        // host resolves the unpacked copy at runtime (asarUnpack handles it).
        external: ['node-pty', 'pidusage'],
        output: {
          entryFileNames: '[name].js'
        }
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
        },
        output: {
          // Split du bundle renderer : isole les libs lourdes (xterm + addons,
          // electron-conf via lucide imports, etc.) dans des chunks dédiés.
          // Cold-start plus rapide : le main thread parse moins de JS d'un coup.
          manualChunks(id): string | void {
            if (!id.includes('node_modules')) return;
            // xterm + addons : ~400KB. Toujours utilisé → 1 chunk dédié.
            if (id.includes('@xterm/')) return 'xterm';
            // React core — séparé pour cache long-terme entre versions.
            if (
              id.includes('/react/') ||
              id.includes('/react-dom/') ||
              id.includes('/scheduler/')
            ) {
              return 'react';
            }
            // Zustand + immer-like : très petit mais utilisé partout.
            if (id.includes('/zustand/')) return 'state';
            // Lucide icons : tree-shaké mais reste ~100KB ; chunk dédié évite
            // que chaque dialog lazy en re-bundle des copies.
            if (id.includes('/lucide-react/')) return 'icons';
          }
        }
      }
    }
  }
});
