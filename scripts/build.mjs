/**
 * Bundles the browser-side TypeScript into files that can be served as static
 * assets from apps/pwa/public/. Vercel handles the api/ functions separately.
 *
 * Two bundles:
 *   app.js  — the attendance screen and outbox (loaded as an ES module)
 *   sw.js   — the service worker (loaded as a classic script, IIFE format)
 */
import { build } from 'esbuild';

const SHARED = {
  bundle: true,
  minify: true,
  platform: 'browser',
  // esbuild resolves .ts imports natively; no plugin needed.
  resolveExtensions: ['.ts', '.js'],
};

await build({
  ...SHARED,
  entryPoints: ['apps/pwa/src/app.ts'],
  format: 'esm',
  outfile: 'apps/pwa/public/app.js',
  define: { 'process.env.NODE_ENV': '"production"' },
});

await build({
  ...SHARED,
  entryPoints: ['apps/pwa/src/sw.ts'],
  // Service workers are registered as classic scripts; ES module SWs have
  // limited browser support on the Android Go devices this app targets.
  format: 'iife',
  outfile: 'apps/pwa/public/sw.js',
});

console.log('build complete — app.js + sw.js written to apps/pwa/public/');
