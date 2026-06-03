/** @type {import('next').NextConfig} */
const nextConfig = {
  images: {
    domains: [
      'cdn.akamai.steamstatic.com',
      'steamcdn-a.akamaihd.net',
      'shared.akamai.steamstatic.com'
    ],
  },
  experimental: {
    // @tobyg74/tiktok-api-dl drags in cheerio → undici whose source uses
    // private-field (#target) syntax that Next.js's webpack v5 can't parse.
    // Excluding from the server bundle makes Next require() it at runtime
    // instead, which works fine on Node 22 (Vercel's default runtime).
    serverComponentsExternalPackages: [
      '@tobyg74/tiktok-api-dl',
      'undici',
      'cheerio',
    ],
  },
}

module.exports = nextConfig
