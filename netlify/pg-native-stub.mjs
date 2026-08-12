/**
 * pg-native stand-in for the bundled Netlify functions.
 *
 * `pg` reaches for the optional pg-native binding only when something
 * touches Client.native — nothing in this codebase does, and the native
 * binding needs a compiler toolchain that a serverless runtime does not
 * have. Without this, esbuild fails to resolve pg-native while bundling pg
 * and the whole function fails to build.
 *
 * It exports null rather than throwing at import time: pg's own loader
 * treats a missing binding as "use the pure-JS driver", and a module that
 * threw on import would take the function down at cold start instead.
 */
export default null;
