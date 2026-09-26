import { defineConfig } from 'vitepress'
import { withMermaid } from 'vitepress-plugin-mermaid'
import tapflowLight from './theme/tapflow-light.json'
import tapflowDark from './theme/tapflow-dark.json'
import { emitAgentArtifacts } from './agent-artifacts.mjs'

// The canonical origin, written once.
//
// `tapflow.dev` answers 307 to `www.tapflow.dev` — that is the Vercel domain setting, and the
// user-facing docs (both READMEs, the Docker Hub overview, the dashboard's sidebar) already link
// to `www`. This file used to spell the apex in five places, which put a redirect in front of
// every one of the sitemap's 47 URLs and every link in `llms.txt`. Repeating the string is what
// let the two drift, so it is a constant now.
const SITE = 'https://www.tapflow.dev'

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

// Sections follow what the reader is doing, and a page's URL prefix names its section
// (`/get-started/`, `/testing/`, `/operate/`, `/automation/`, `/reference/`). One sidebar for
// every page rather than one per section, so each reader can see the other's pages.
//
// Interim entries until the pages are split or merged: `/dashboard/setup` (Get started),
// `/dashboard/overview` (Test apps), `/guide/self-hosting` (Deploy the relay) and
// `/guide/troubleshooting` keep their old URLs for now.
//
// `koSidebar` must mirror this one — same groups, same order, every link prefixed with `/ko` —
// and `docs/public/llms.txt` lists the same links under the same top-level group names.
// `scripts/__tests__/agentReadableDocs.test.mjs` checks both.
const enSidebar = [
  {
    text: 'Get started',
    items: [
      { text: 'Introduction', link: '/get-started/introduction' },
      { text: 'Quick Start', link: '/get-started/quick-start' },
      { text: 'First-time Setup', link: '/dashboard/setup' },
    ],
  },
  {
    text: 'Test apps',
    items: [
      { text: 'Overview', link: '/dashboard/overview' },
      { text: 'App Center', link: '/testing/app-center' },
      { text: 'Network control', link: '/testing/network-control' },
      { text: 'Audio', link: '/testing/audio' },
    ],
  },
  {
    text: 'Operate',
    items: [
      {
        text: 'Set up a Mac',
        collapsed: true,
        items: [
          { text: 'Requirements', link: '/operate/requirements' },
          { text: 'Environment setup', link: '/operate/environment-setup' },
          { text: 'Configure tapflow', link: '/operate/configure' },
          { text: 'Agents', link: '/operate/agents' },
        ],
      },
      {
        text: 'Deploy the relay',
        collapsed: true,
        items: [
          { text: 'Self-Hosting the Relay', link: '/guide/self-hosting' },
          { text: 'Stream quality', link: '/operate/streaming-quality' },
        ],
      },
      {
        text: 'Run the team',
        collapsed: true,
        items: [
          { text: 'Scaling Mac resources', link: '/operate/scaling' },
        ],
      },
      {
        text: 'Deliver builds',
        collapsed: true,
        items: [
          { text: 'Upload from CI', link: '/operate/ci-distribution' },
          { text: 'Review webhooks', link: '/operate/webhooks' },
        ],
      },
      {
        text: 'AI automation (experimental)',
        collapsed: true,
        items: [
          { text: 'MCP server', link: '/automation/mcp-server' },
          { text: 'Flow reference', link: '/automation/flows' },
          { text: 'MCP in CI/CD', link: '/automation/mcp-ci' },
        ],
      },
    ],
  },
  {
    text: 'Reference',
    items: [
      { text: 'CLI', link: '/reference/cli' },
      { text: 'Configuration', link: '/reference/configuration' },
      { text: 'REST API', link: '/reference/api' },
      { text: 'Security & privacy', link: '/reference/security' },
      { text: 'Performance & latency', link: '/reference/performance' },
      { text: 'Sustainability', link: '/reference/sustainability' },
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
      { text: 'Contributing guide', link: '/contributing' },
    ],
  },
]

const koSidebar = [
  {
    text: '시작하기',
    items: [
      { text: '소개', link: '/ko/get-started/introduction' },
      { text: '빠른 시작', link: '/ko/get-started/quick-start' },
      { text: '최초 설정', link: '/ko/dashboard/setup' },
    ],
  },
  {
    text: '앱 테스트',
    items: [
      { text: '개요', link: '/ko/dashboard/overview' },
      { text: 'App Center', link: '/ko/testing/app-center' },
      { text: '네트워크 제어', link: '/ko/testing/network-control' },
      { text: '오디오', link: '/ko/testing/audio' },
    ],
  },
  {
    text: '운영',
    items: [
      {
        text: 'Mac 준비',
        collapsed: true,
        items: [
          { text: '시스템 요구사항', link: '/ko/operate/requirements' },
          { text: '환경 준비', link: '/ko/operate/environment-setup' },
          { text: 'tapflow 설정', link: '/ko/operate/configure' },
          { text: '에이전트 설정', link: '/ko/operate/agents' },
        ],
      },
      {
        text: '릴레이 배포',
        collapsed: true,
        items: [
          { text: '릴레이 셀프 호스팅', link: '/ko/guide/self-hosting' },
          { text: '스트림 품질', link: '/ko/operate/streaming-quality' },
        ],
      },
      {
        text: '팀 운영',
        collapsed: true,
        items: [
          { text: 'Mac 리소스 확장', link: '/ko/operate/scaling' },
        ],
      },
      {
        text: '빌드 전달',
        collapsed: true,
        items: [
          { text: 'CI에서 빌드 올리기', link: '/ko/operate/ci-distribution' },
          { text: '리뷰 웹훅', link: '/ko/operate/webhooks' },
        ],
      },
      {
        text: 'AI 자동화 (실험적)',
        collapsed: true,
        items: [
          { text: 'MCP 서버', link: '/ko/automation/mcp-server' },
          { text: '플로우 레퍼런스', link: '/ko/automation/flows' },
          { text: 'CI/CD에서 MCP 활용', link: '/ko/automation/mcp-ci' },
        ],
      },
    ],
  },
  {
    text: '레퍼런스',
    items: [
      { text: 'CLI 레퍼런스', link: '/ko/reference/cli' },
      { text: '설정 파일', link: '/ko/reference/configuration' },
      { text: 'REST API', link: '/ko/reference/api' },
      { text: '보안 및 개인정보', link: '/ko/reference/security' },
      { text: '성능과 지연', link: '/ko/reference/performance' },
      { text: '지속가능성', link: '/ko/reference/sustainability' },
    ],
  },
  {
    text: '문제 해결',
    items: [
      { text: '문제 해결', link: '/ko/guide/troubleshooting' },
    ],
  },
  {
    text: '기여',
    items: [
      { text: '기여 가이드', link: '/ko/contributing' },
    ],
  },
]

export default withMermaid(defineConfig({
  title: 'tapflow',
  description: 'Self-hosted iOS/Android simulator streaming for the whole team',
  cleanUrls: true,

  // `docs/AGENTS.md` and `docs/CLAUDE.md` are contributor rules for working on this VitePress site.
  // Without this they built into the public site and took the first two rows of the sitemap, so a
  // crawler or an agent surveying tapflow's documentation met our internal writing conventions
  // before it met the product. The files stay where they are — INDEX.md links them.
  //
  // `**/` because a bare `AGENTS.md` matches the srcDir root only, so a second one added under a
  // locale would publish itself.
  srcExclude: ['**/AGENTS.md', '**/CLAUDE.md'],

  // Ship the source markdown beside the HTML, and the English prose as one file. See
  // `agent-artifacts.mjs` for what an agent gets without it.
  async buildEnd(siteConfig) {
    const { copied, bundled } = await emitAgentArtifacts({
      srcDir: siteConfig.srcDir,
      outDir: siteConfig.outDir,
      pages: siteConfig.pages,
      hostname: SITE,
    })
    siteConfig.logger.info(
      `agent artifacts: ${copied.length} .md copied, ${bundled.length} pages in llms-full.txt`,
    )
  },

  sitemap: {
    hostname: SITE,
  },

  locales: {
    root: {
      label: 'English',
      lang: 'en-US',
      themeConfig: {
        nav: [
          // The `dashboard/*` and `guide/*` alternatives cover the interim entries named above
          // `enSidebar`; drop each one when its page moves.
          { text: 'Get started', link: '/get-started/introduction', activeMatch: '^/(get-started/|dashboard/setup)' },
          { text: 'Test apps', link: '/dashboard/overview', activeMatch: '^/(testing/|dashboard/overview)' },
          { text: 'Operate', link: '/operate/requirements', activeMatch: '^/(operate/|automation/|guide/self-hosting)' },
          { text: 'Reference', link: '/reference/cli', activeMatch: '^/reference/' },
          { text: 'Changelog', link: 'https://github.com/jo-duchan/tapflow/blob/main/CHANGELOG.md' },
        ],
        sidebar: enSidebar,
      },
    },
    ko: {
      label: '한국어',
      lang: 'ko-KR',
      themeConfig: {
        nav: [
          { text: '시작하기', link: '/ko/get-started/introduction', activeMatch: '^/ko/(get-started/|dashboard/setup)' },
          { text: '앱 테스트', link: '/ko/dashboard/overview', activeMatch: '^/ko/(testing/|dashboard/overview)' },
          { text: '운영', link: '/ko/operate/requirements', activeMatch: '^/ko/(operate/|automation/|guide/self-hosting)' },
          { text: '레퍼런스', link: '/ko/reference/cli', activeMatch: '^/ko/reference/' },
          { text: '변경 기록', link: 'https://github.com/jo-duchan/tapflow/blob/main/CHANGELOG.md' },
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
        url: SITE,
        license: 'https://opensource.org/licenses/MIT',
        isAccessibleForFree: true,
        offers: { '@type': 'Offer', price: '0', priceCurrency: 'USD' },
        sameAs: ['https://github.com/jo-duchan/tapflow'],
      }),
    ],
    ['meta', { property: 'og:type', content: 'website' }],
    ['meta', { property: 'og:url', content: SITE }],
    ['meta', { property: 'og:title', content: 'tapflow — Self-hosted simulator streaming for your whole team' }],
    [
      'meta',
      {
        property: 'og:description',
        content:
          'Open-source, self-hosted alternative to Appetize and BrowserStack App Live. Run iOS & Android simulators in the browser — no data leaving your network.',
      },
    ],
    ['meta', { property: 'og:image', content: `${SITE}/demo-thumbnail.png` }],
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
    ['meta', { name: 'twitter:image', content: `${SITE}/demo-thumbnail.png` }],
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
