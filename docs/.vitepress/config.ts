import { defineConfig } from 'vitepress'
import tapflowLight from './theme/tapflow-light.json'
import tapflowDark from './theme/tapflow-dark.json'

export default defineConfig({
  title: 'tapflow',
  description: 'Self-hosted iOS/Android simulator streaming for QA teams',
  lang: 'en-US',

  head: [
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

  themeConfig: {
    logo: '/logo.svg',
    nav: [
      { text: 'Guide', link: '/guide/introduction' },
    ],

    sidebar: [
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
          { text: 'iOS Agent Setup', link: '/guide/ios-agent' },
          { text: 'Android Agent Setup', link: '/guide/android-agent' },
          { text: 'Self-Hosting the Relay', link: '/guide/self-hosting' },
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
        text: 'Contributing',
        items: [
          { text: 'Contributing Guide', link: '/guide/contributing' },
        ],
      },
    ],

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
})
