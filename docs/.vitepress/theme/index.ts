/// <reference types="vite/client" />
import { h } from 'vue'
import DefaultTheme from 'vitepress/theme'
import './custom.css'
import VideoPlayer from './VideoPlayer.vue'
import PageStatus from './PageStatus.vue'

export default {
  extends: DefaultTheme,
  Layout: () => h(DefaultTheme.Layout, null, { 'doc-before': () => h(PageStatus) }),
  enhanceApp({ app }: { app: import('vue').App }) {
    app.component('VideoPlayer', VideoPlayer)
  },
}
