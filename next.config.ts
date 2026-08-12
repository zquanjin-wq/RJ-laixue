import type { NextConfig } from 'next';
import path from 'node:path';

const e2eAuthAlias: Record<string, string> = {};
if (process.env.E2E_TEST_MODE === '1') {
  // Build-time E2E-only alias. Vercel never sets this flag, so production
  // always resolves the normal Supabase-backed auth hook.
  e2eAuthAlias['@/lib/auth/use-auth'] = './e2e/fixtures/browser-auth.ts';
}

const nextConfig: NextConfig = {
  output: process.env.VERCEL ? undefined : 'standalone',
  transpilePackages: ['mathml2omml', 'pptxgenjs', '@openmaic/importer'],
  // tsc needs the workspace source mappings in tsconfig for type checking,
  // but Turbopack must consume the built ESM entries. The source indexes import
  // sibling files as `.js`, which Turbopack does not remap to `.ts` in a
  // production build. postinstall builds these dist entries before `next build`.
  // Every @openmaic/* package whose tsconfig path points at source MUST have a
  // matching dist alias here — see tests/openmaic-package-resolution.test.ts.
  turbopack: {
    resolveAlias: {
      // Keep this relative and POSIX-style: Turbopack does not support a
      // Windows absolute alias path during local production builds.
      '@openmaic/dsl': './packages/@openmaic/dsl/dist/index.js',
      '@openmaic/storage': './packages/@openmaic/storage/dist/index.js',
      ...e2eAuthAlias,
    },
  },
  // Keep webpack production builds on the same generated workspace entries as
  // Turbopack. Without this, tsconfig's source mapping makes webpack follow
  // the DSL source's `.js` sibling imports, which do not exist until TypeScript
  // emits the package's dist files.
  webpack: (config) => {
    // `JsConfigPathsPlugin` otherwise re-applies tsconfig's source-only
    // workspace mappings after this alias table. That is useful to tsc but
    // invalid for webpack because the package source imports emitted `.js`
    // siblings. Runtime bundling must use the package's generated entries.
    config.resolve.plugins = config.resolve.plugins?.filter(
      (plugin: { constructor?: { name?: string } }) =>
        plugin.constructor?.name !== 'JsConfigPathsPlugin',
    );
    config.resolve.alias = {
      ...config.resolve.alias,
      '@': process.cwd(),
      '@openmaic/dsl/schema': path.resolve(process.cwd(), 'packages/@openmaic/dsl/dist/schema'),
      '@openmaic/dsl': path.resolve(process.cwd(), 'packages/@openmaic/dsl/dist/index.js'),
      '@openmaic/storage': path.resolve(process.cwd(), 'packages/@openmaic/storage/dist/index.js'),
    };
    return config;
  },
  // These agent packages do a runtime `import(specifier)` with a computed
  // specifier (to lazily load node:fs/os/path without breaking browser/Vite
  // builds). webpack can't statically analyze that and bundling it throws
  // "Cannot find module as expression is too dynamic" at runtime on the server
  // (the "Edit with AI" Pro-mode path), which broke the #619 keep-alive e2e.
  // Mark them server-external so Next loads them natively and the dynamic
  // import resolves as a real Node call.
  serverExternalPackages: ['@earendil-works/pi-ai', '@earendil-works/pi-agent-core'],
  experimental: {
    proxyClientMaxBodySize: '200mb',
  },
  async headers() {
    const extraAncestors = process.env.ALLOWED_FRAME_ANCESTORS?.trim();
    const frameAncestors = extraAncestors ? `'self' ${extraAncestors}` : "'self'";

    return [
      {
        source: '/(.*)',
        headers: [
          // X-Frame-Options only supports SAMEORIGIN (no allow-list),
          // so we omit it when custom ancestors are configured.
          ...(!extraAncestors ? [{ key: 'X-Frame-Options', value: 'SAMEORIGIN' }] : []),
          {
            key: 'Content-Security-Policy',
            value: `frame-ancestors ${frameAncestors}`,
          },
        ],
      },
    ];
  },
};

export default nextConfig;
