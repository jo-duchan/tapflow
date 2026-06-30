import { defineConfig } from 'vitepress'
import { withMermaid } from 'vitepress-plugin-mermaid'
import tapflowLight from './theme/tapflow-light.json'
import tapflowDark from './theme/tapflow-dark.json'

// VitePress(mdit-vue) 기본 slugify는 NFKD 정규화라 한글 음절을 자모 분리(NFD) 형태의 헤딩 id로 만든다.
// 브라우저 URL hash는 NFC라 바이트가 어긋나 비ASCII 헤딩으로 스크롤이 안 된다.
// mdit-vue와 동일한 특수문자·_숫자 prefix 처리에 정규화만 NFC로 바꿔 id를 완성형으로 만든다.
function nfcSlugify(str: string): string {
  return str
    .normalize('NFC')
    .replace(/[\s~`!@#$%^&*()\-_+=[\]{}|\\;:"'“”‘’<>,.?/]+/g, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^-+|-+$/g, '')
    .replace(/^(\d)/, '_$1')
    .toLowerCase()
}

const enSidebar = [
  {
    text: 'Getting Started',
    items: [
      { text: 'Introduction', link: '/guide/introduction' },
      { text: 'Requirements', link: '/guide/requirements' },
      { text: 'Quick Start', link: '/guide/getting-started' },
    ],
  },
  {
    text: 'Setup',
    items: [
      { text: 'Environment Setup', link: '/guide/environment-setup' },
      { text: 'Configuring tapflow', link: '/guide/configure' },
      { text: 'Self-Hosting the Relay', link: '/guide/self-hosting' },
      { text: 'Agent Setup', link: '/guide/agent' },
      { text: 'Scaling Mac Resources', link: '/guide/scaling' },
    ],
  },
  {
    text: 'Distribution',
    items: [
      { text: 'Uploading Builds', link: '/guide/upload-builds' },
      { text: 'Build Distribution', link: '/guide/build-distribution' },
    ],
  },
  {
    text: 'Dashboard',
    items: [
      { text: 'First-time Setup', link: '/dashboard/setup' },
      { text: 'Dashboard Overview', link: '/dashboard/overview' },
    ],
  },
  {
    text: 'AI Agent',
    items: [
      { text: 'MCP Server', link: '/guide/mcp-server' },
      { text: 'MCP in CI/CD', link: '/guide/mcp-ci' },
    ],
  },
  {
    text: 'Reference',
    items: [
      { text: 'Changelog', link: '/changelog' },
      { text: 'CLI Reference', link: '/reference/cli' },
      { text: 'Configuration', link: '/reference/configuration' },
      { text: 'Streaming Quality', link: '/guide/streaming' },
      { text: 'Audio', link: '/guide/audio' },
      { text: 'REST API', link: '/reference/api' },
      { text: 'Performance & Latency', link: '/reference/performance' },
      { text: 'Security & Privacy', link: '/reference/security' },
    ],
  },
  {
    text: 'Troubleshooting',
    items: [
      { text: 'Troubleshooting', link: '/guide/troubleshooting' },
    ],
  },
  {
    text: 'Contributing',
    items: [
      { text: 'Contributing Guide', link: '/guide/contributing' },
    ],
  },
]

const koSidebar = [
  {
    text: '시작하기',
    items: [
      { text: '소개', link: '/ko/guide/introduction' },
      { text: '시스템 요구사항', link: '/ko/guide/requirements' },
      { text: '빠른 시작', link: '/ko/guide/getting-started' },
    ],
  },
  {
    text: '설정',
    items: [
      { text: '환경 준비', link: '/ko/guide/environment-setup' },
      { text: 'tapflow 설정', link: '/ko/guide/configure' },
      { text: '릴레이 배포', link: '/ko/guide/self-hosting' },
      { text: '에이전트 설정', link: '/ko/guide/agent' },
      { text: 'Mac 리소스 확장', link: '/ko/guide/scaling' },
    ],
  },
  {
    text: '빌드 배포',
    items: [
      { text: '빌드 업로드', link: '/ko/guide/upload-builds' },
      { text: '빌드 배포', link: '/ko/guide/build-distribution' },
    ],
  },
  {
    text: '대시보드',
    items: [
      { text: '최초 설정', link: '/ko/dashboard/setup' },
      { text: '대시보드 개요', link: '/ko/dashboard/overview' },
    ],
  },
  {
    text: 'AI 에이전트',
    items: [
      { text: 'MCP 서버', link: '/ko/guide/mcp-server' },
      { text: 'CI/CD에서 MCP 활용', link: '/ko/guide/mcp-ci' },
    ],
  },
  {
    text: '레퍼런스',
    items: [
      { text: '변경 기록', link: '/ko/changelog' },
      { text: 'CLI 레퍼런스', link: '/ko/reference/cli' },
      { text: '설정 파일', link: '/ko/reference/configuration' },
      { text: '스트림 품질', link: '/ko/guide/streaming' },
      { text: '오디오', link: '/ko/guide/audio' },
      { text: 'REST API', link: '/ko/reference/api' },
      { text: '성능과 지연', link: '/ko/reference/performance' },
      { text: '보안 및 개인정보', link: '/ko/reference/security' },
    ],
  },
  {
    text: '트러블슈팅',
    items: [
      { text: '문제 해결', link: '/ko/guide/troubleshooting' },
    ],
  },
  {
    text: '기여',
    items: [
      { text: '기여 가이드', link: '/ko/guide/contributing' },
    ],
  },
]

export default withMermaid(defineConfig({
  title: 'tapflow',
  description: 'Self-hosted iOS/Android simulator streaming for the whole team',
  cleanUrls: true,

  sitemap: {
    hostname: 'https://tapflow.dev',
  },

  locales: {
    root: {
      label: 'English',
      lang: 'en-US',
      themeConfig: {
        nav: [
          { text: 'Guide', link: '/guide/introduction', activeMatch: '^/(guide|dashboard)' },
          { text: 'Reference', link: '/reference/cli', activeMatch: '^/reference' },
        ],
        sidebar: enSidebar,
      },
    },
    ko: {
      label: '한국어',
      lang: 'ko-KR',
      themeConfig: {
        nav: [
          { text: '가이드', link: '/ko/guide/introduction', activeMatch: '^/ko/(guide|dashboard)' },
          { text: '레퍼런스', link: '/ko/reference/cli', activeMatch: '^/ko/reference' },
        ],
        sidebar: koSidebar,
      },
    },
  },

  head: [
    ['link', { rel: 'icon', href: '/favicon.ico', sizes: '32x32' }],
    ['link', { rel: 'icon', href: '/favicon.svg', type: 'image/svg+xml' }],
    ['link', { rel: 'preconnect', href: 'https://fonts.googleapis.com' }],
    ['link', { rel: 'preconnect', href: 'https://fonts.gstatic.com', crossorigin: '' }],
    [
      'link',
      {
        href: 'https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600&family=JetBrains+Mono:wght@400&display=swap',
        rel: 'stylesheet',
      },
    ],
    [
      'script',
      { type: 'application/ld+json' },
      JSON.stringify({
        '@context': 'https://schema.org',
        '@type': 'SoftwareApplication',
        name: 'tapflow',
        applicationCategory: 'DeveloperApplication',
        operatingSystem: 'macOS, Linux',
        description:
          'Open-source, self-hosted alternative to Appetize and BrowserStack App Live. Run iOS simulators and Android emulators in the browser for your whole team — app binaries never leave your network.',
        url: 'https://tapflow.dev',
        license: 'https://opensource.org/licenses/MIT',
        isAccessibleForFree: true,
        offers: { '@type': 'Offer', price: '0', priceCurrency: 'USD' },
        sameAs: ['https://github.com/jo-duchan/tapflow'],
      }),
    ],
    ['meta', { property: 'og:type', content: 'website' }],
    ['meta', { property: 'og:url', content: 'https://tapflow.dev' }],
    ['meta', { property: 'og:title', content: 'tapflow — Self-hosted simulator streaming for your whole team' }],
    [
      'meta',
      {
        property: 'og:description',
        content:
          'Open-source, self-hosted alternative to Appetize and BrowserStack App Live. Run iOS & Android simulators in the browser — no data leaving your network.',
      },
    ],
    ['meta', { property: 'og:image', content: 'https://tapflow.dev/demo-thumbnail.png' }],
    ['meta', { name: 'twitter:card', content: 'summary_large_image' }],
    ['meta', { name: 'twitter:title', content: 'tapflow — Self-hosted simulator streaming for your whole team' }],
    [
      'meta',
      {
        name: 'twitter:description',
        content:
          'Open-source, self-hosted alternative to Appetize and BrowserStack App Live. Run iOS & Android simulators in the browser — no data leaving your network.',
      },
    ],
    ['meta', { name: 'twitter:image', content: 'https://tapflow.dev/demo-thumbnail.png' }],
  ],

  markdown: {
    theme: { light: tapflowLight as any, dark: tapflowDark as any },
    anchor: { slugify: nfcSlugify },
  },

  vite: {
    optimizeDeps: {
      include: ['mermaid'],
    },
  },

  themeConfig: {
    logo: { light: '/logo.svg', dark: '/logo-dark.svg' },
    socialLinks: [
      { icon: 'github', link: 'https://github.com/jo-duchan/tapflow' },
    ],
    footer: {
      message: 'Released under the MIT License.',
      copyright: 'Copyright © 2026-present tapflow contributors',
    },
    search: {
      provider: 'local',
    },
  },
}))
