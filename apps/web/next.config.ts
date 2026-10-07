import type { NextConfig } from 'next';
// The shared contracts keep Node ESM .js specifiers; resolve their existing TS sources in Next.
const contractModules = [
  'crm',
  'recruiting',
  'agenda',
  'field-visits',
  'product-master',
  'country-catalog',
  'commercial-calculator',
  'cpq',
  'quote-workflow',
  'order-commercial',
  'order-reconciliation',
  'order-read',
];
const config: NextConfig = {
  poweredByHeader: false,
  reactStrictMode: true,
  turbopack: {
    resolveAlias: Object.fromEntries(
      contractModules.map((name) => [`./${name}.js`, `../../packages/contracts/src/${name}.ts`]),
    ),
  },
  transpilePackages: ['@rpt/ui', '@rpt/design-tokens', '@rpt/test-fixtures', '@rpt/contracts'],
  async headers() {
    return [
      {
        source: '/:path*',
        headers: [
          { key: 'X-Content-Type-Options', value: 'nosniff' },
          { key: 'Referrer-Policy', value: 'no-referrer' },
          { key: 'Permissions-Policy', value: 'camera=(), microphone=(), geolocation=()' },
          { key: 'X-Frame-Options', value: 'DENY' },
          { key: 'Cache-Control', value: 'no-store' },
        ],
      },
    ];
  },
};
export default config;
