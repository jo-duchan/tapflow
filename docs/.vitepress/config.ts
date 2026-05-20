import { defineConfig } from 'vitepress'
import { withMermaid } from 'vitepress-plugin-mermaid'
import tapflowLight from './theme/tapflow-light.json'
import tapflowDark from './theme/tapflow-dark.json'

const enSidebar = [
  {
    text: 'Getting Started',
    items: [
      { text: 'Introduction', link: '/guide/introduction' },
      { text: 'Quick Start', link: '/guide/getting-started' },
      { text: 'Requirements', link: '/guide/requirements' },
    ],
  },
  {
    text: 'Setup',
    items: [
      { text: 'Self-Hosting the Relay', link: '/guide/self-hosting' },
      { text: 'Agent Setup', link: '/guide/agent' },
      { text: 'Uploading Builds (CI/CD)', link: '/guide/upload-builds' },
      { text: 'Scaling Mac Resources', link: '/guide/scaling' },
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
    text: 'Reference',
    items: [
      { text: 'CLI Reference', link: '/reference/cli' },
      { text: 'Configuration', link: '/reference/configuration' },
      { text: 'REST API', link: '/reference/api' },
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
      { text: '빠른 시작', link: '/ko/guide/getting-started' },
      { text: '시스템 요구사항', link: '/ko/guide/requirements' },
    ],
  },
  {
    text: '설정',
    items: [
      { text: '릴레이 배포', link: '/ko/guide/self-hosting' },
      { text: '에이전트 설정', link: '/ko/guide/agent' },
      { text: '빌드 업로드 (CI/CD)', link: '/ko/guide/upload-builds' },
      { text: 'Mac 리소스 확장', link: '/ko/guide/scaling' },
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
    text: '레퍼런스',
    items: [
      { text: 'CLI 레퍼런스', link: '/ko/reference/cli' },
      { text: '설정 파일', link: '/ko/reference/configuration' },
      { text: 'REST API', link: '/ko/reference/api' },
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
  description: 'Self-hosted iOS/Android simulator streaming for QA',

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
  ],

  markdown: {
    theme: { light: tapflowLight as any, dark: tapflowDark as any },
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
