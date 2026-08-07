import path from 'node:path'

/** @type {import('next').NextConfig} */
const nextConfig = {
  output: 'standalone',
  distDir: process.env.NEXT_DIST_DIR || '.next',
  poweredByHeader: false,
  outputFileTracingRoot: path.resolve(process.cwd()),
}

export default nextConfig
