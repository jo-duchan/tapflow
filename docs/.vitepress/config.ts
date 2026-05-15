import { defineConfig } from 'vitepress'

export default defineConfig({
  title: 'tapflow',
  description: 'Self-hosted iOS/Android simulator streaming for QA teams',
  lang: 'en-US',

  themeConfig: {
    logo: '/logo.svg',
    nav: [
      { text: 'Guide', link: '/guide/getting-started' },
      { text: 'Reference', link: '/reference/cli' },
      { text: 'GitHub', link: 'https://github.com/jo-duchan/tapflow' },
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
        text: 'Guides',
        items: [
          { text: 'Self-Hosting the Relay', link: '/guide/self-hosting' },
          { text: 'iOS Agent Setup', link: '/guide/ios-agent' },
          { text: 'Android Agent Setup', link: '/guide/android-agent' },
          { text: 'Uploading Builds (CI/CD)', link: '/guide/upload-builds' },
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
      copyright: 'Copyright © 2025-present tapflow contributors',
    },

    search: {
      provider: 'local',
    },
  },
})
