/** @type {import('next').NextConfig} */
import path from 'path'

const isDev = process.env.NODE_ENV === 'development'

const nextConfig = {
  // Tell Next.js not to bundle better-sqlite3 (native addon — must be required at runtime)
  serverExternalPackages: ['better-sqlite3'],
  // middleware.ts's matcher runs on /api/* (its own auth-redirect logic is
  // separate from each route's own validateRequest()/API-key check — see
  // app/api/upload/route.ts:89). Next.js 15.5+ caps how much of the request
  // body it buffers for any matched route at 10MB by default, regardless of
  // whether the middleware function itself reads the body; past that cap the
  // body is silently truncated, which breaks request.formData() in the actual
  // route handler (no closing multipart boundary -> parse throws -> "Invalid
  // form data"). Raised to match this app's own existing 10 GB upload ceiling
  // (MAX_FILE_SIZE in app/api/upload/route.ts).
  experimental: {
    middlewareClientMaxBodySize: '10gb',
  },
  // Exclude large data folders from output file tracing (fixes slow builds)
  outputFileTracingExcludes: {
    '*': [
      './uploads/**',
      './clickhouse-data/**',
      './data/**',
      './.devtasks/**',
    ],
  },
  // Exclude data folders from webpack processing (these contain stealer logs with .ts files)
  webpack: (config, { isServer }) => {
    // Ignore data directories from file watching
    config.watchOptions = {
      ...config.watchOptions,
      ignored: ['**/uploads/**', '**/clickhouse-data/**', '**/data/**', '**/node_modules/**'],
    };
    
    // Add rule to completely ignore data folders from module bundling
    config.module.rules.push({
      test: /\.(ts|tsx|js|jsx|json)$/,
      exclude: [
        path.resolve('./uploads'),
        path.resolve('./clickhouse-data'),
        path.resolve('./data'),
      ],
    });

    // Exclude from snapshot paths to prevent webpack from scanning data dirs
    if (!config.snapshot) config.snapshot = {};
    config.snapshot.managedPaths = config.snapshot.managedPaths || [/node_modules/];
    config.snapshot.immutablePaths = config.snapshot.immutablePaths || [];
    
    return config;
  },
  // Enable standalone output for smaller Docker images (production only)
  ...(isDev ? {} : { output: 'standalone' }),
...(!isDev ? {
    compiler: {
      removeConsole: {
        exclude: ['error', 'warn']
      },
    },
  } : {}),
  eslint: {
    // Skip ESLint during builds — run `npm run lint` separately
    ignoreDuringBuilds: true,
  },
  typescript: {
    // Skip TypeScript errors during builds — run `npx tsc --noEmit` separately
    ignoreBuildErrors: true,
  },
  images: {
    unoptimized: true,
  },
  // Optimize module resolution for faster startup (only in production - not compatible with Turbo)
  ...(!isDev ? {
    modularizeImports: {
      'lucide-react': {
        transform: 'lucide-react/dist/esm/icons/{{kebabCase member}}',
      },
    },
  } : {}),
  // Add security headers
  async headers() {
    return [
      {
        source: '/(.*)',
        headers: [
          {
            key: 'X-Frame-Options',
            value: 'DENY',
          },
          {
            key: 'X-Content-Type-Options',
            value: 'nosniff',
          },
          {
            key: 'Referrer-Policy',
            value: 'origin-when-cross-origin',
          },
          // SECURITY: Add HSTS header (MED-18)
          {
            key: 'Strict-Transport-Security',
            value: 'max-age=63072000; includeSubDomains; preload',
          },
          // SECURITY: Add Content-Security-Policy (MED-18)
          {
            key: 'Content-Security-Policy',
            value: "default-src 'self'; script-src 'self' 'unsafe-inline' 'unsafe-eval'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self' data:; connect-src 'self' https://cdn.jsdelivr.net; frame-ancestors 'none';",
          },
          // SECURITY: Add Permissions-Policy header (MED-18)
          {
            key: 'Permissions-Policy',
            value: 'camera=(), microphone=(), geolocation=(), interest-cohort=()',
          },
        ],
      },
    ]
  },
}

export default nextConfig
