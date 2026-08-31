/**
 * Build the component gallery into the dev preview.  (P2)
 *
 * The gallery renders every component in `apps/pwa/src/ui/` with every state
 * on one page. It is how P2 was accepted, and it found five defects that no
 * unit test could have — a spinner that laid out as a 4×30 vertical bar, a
 * primary button that had been `width: 100%` since the app was phone-only,
 * and a stacked action order that did the opposite of what its own comment
 * claimed.
 *
 * ── Why it is not in `public/` ─────────────────────────────────────────────
 * Everything under `apps/pwa/public/` is deployed. A component gallery served
 * from a school's own domain is a platform-internal page on a tenant surface,
 * which is exactly the boundary D11 draws. The source lives in `apps/pwa/dev/`,
 * which ships nowhere, and this script copies it into the preview on demand.
 * Both outputs are gitignored, so a stray build cannot become a deployment.
 *
 *     node scripts/build-gallery.mjs      # then open /ui-gallery.html
 *
 * Delete them again with `git clean -n apps/pwa/public` to check first.
 */
import { build } from 'esbuild';
import { copyFile } from 'node:fs/promises';

await build({
  entryPoints: ['apps/pwa/dev/gallery.ts'],
  bundle: true,
  // Not minified: this is read in a debugger as often as it is looked at.
  minify: false,
  platform: 'browser',
  resolveExtensions: ['.ts', '.js'],
  format: 'esm',
  outfile: 'apps/pwa/public/ui-gallery.js',
});
await copyFile('apps/pwa/dev/gallery.html', 'apps/pwa/public/ui-gallery.html');

console.log('gallery built — http://localhost:4173/ui-gallery.html');
console.log('NOT deployable: both outputs are gitignored (see .gitignore).');
