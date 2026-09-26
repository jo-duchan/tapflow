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
// (`/get-started/`, `/testing/`, `/operate/`, `/automation/`, `/reference/`, `/troubleshooting/`).
// One sidebar for
// every page rather than one per section, so each reader can see the other's pages.
//
// Interim entry until the page is merged: `/dashboard/setup` (Get started) keeps its old URL for now.
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
      { text: 'Overview', link: '/testing' },
      { text: 'App Center', link: '/testing/app-center' },
      {
        text: 'QA Session',
        items: [
          { text: 'QA Session', link: '/testing/qa-session' },
          { text: 'Network control', link: '/testing/network-control' },
          { text: 'Audio', link: '/testing/audio' },
        ],
      },
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
          { text: 'iOS network extension', link: '/operate/network-extension' },
        ],
      },
      {
        text: 'Deploy the relay',
        collapsed: true,
        items: [
          { text: 'Deployment options', link: '/operate/deployment' },
          { text: 'Docker', link: '/operate/docker' },
          { text: 'External access', link: '/operate/external-access' },
          { text: 'Stream quality', link: '/operate/streaming-quality' },
          { text: 'Backups & uptime', link: '/operate/relay-operations' },
        ],
      },
      {
        text: 'Run the team',
        collapsed: true,
        items: [
          { text: 'Team, roles & tokens', link: '/operate/team-and-roles' },
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
      { text: 'Overview', link: '/troubleshooting' },
      { text: 'Install & agents', link: '/troubleshooting/install-and-agents' },
      { text: 'iOS simulator', link: '/troubleshooting/ios-simulator' },
      { text: 'Android emulator', link: '/troubleshooting/android-emulator' },
      { text: 'Builds & uploads', link: '/troubleshooting/builds' },
      { text: 'Stream & sessions', link: '/troubleshooting/streaming' },
      { text: 'Sign-in & accounts', link: '/troubleshooting/accounts' },
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
      { text: '개요', link: '/ko/testing' },
      { text: 'App Center', link: '/ko/testing/app-center' },
      {
        text: 'QA 세션',
        items: [
          { text: 'QA 세션', link: '/ko/testing/qa-session' },
          { text: '네트워크 제어', link: '/ko/testing/network-control' },
          { text: '오디오', link: '/ko/testing/audio' },
        ],
      },
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
          { text: 'iOS 네트워크 확장', link: '/ko/operate/network-extension' },
        ],
      },
      {
        text: '릴레이 배포',
        collapsed: true,
        items: [
          { text: '배포 방식 선택', link: '/ko/operate/deployment' },
          { text: 'Docker로 배포', link: '/ko/operate/docker' },
          { text: '외부 접속', link: '/ko/operate/external-access' },
          { text: '스트림 품질', link: '/ko/operate/streaming-quality' },
          { text: '백업과 상시 운영', link: '/ko/operate/relay-operations' },
        ],
      },
      {
        text: '팀 운영',
        collapsed: true,
        items: [
          { text: '팀·역할·토큰', link: '/ko/operate/team-and-roles' },
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
      { text: '개요', link: '/ko/troubleshooting' },
      { text: '설치와 에이전트', link: '/ko/troubleshooting/install-and-agents' },
      { text: 'iOS 시뮬레이터', link: '/ko/troubleshooting/ios-simulator' },
      { text: 'Android 에뮬레이터', link: '/ko/troubleshooting/android-emulator' },
      { text: '빌드와 업로드', link: '/ko/troubleshooting/builds' },
      { text: '스트림과 세션', link: '/ko/troubleshooting/streaming' },
      { text: '로그인과 계정', link: '/ko/troubleshooting/accounts' },
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
          // The `dashboard/setup` alternative covers the interim entry named above `enSidebar`;
          // drop it when that page moves. `^/testing` without a slash also matches the section
          // overview, which is the sibling file `testing.md` rather than `testing/index.md`.
          { text: 'Get started', link: '/get-started/introduction', activeMatch: '^/(get-started/|dashboard/setup)' },
          { text: 'Test apps', link: '/testing', activeMatch: '^/testing(/|$)' },
          { text: 'Operate', link: '/operate/requirements', activeMatch: '^/(operate|automation)/' },
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
          { text: '앱 테스트', link: '/ko/testing', activeMatch: '^/ko/testing(/|$)' },
          { text: '운영', link: '/ko/operate/requirements', activeMatch: '^/ko/(operate|automation)/' },
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
