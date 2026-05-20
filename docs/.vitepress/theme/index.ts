/// <reference types="vite/client" />
import DefaultTheme from 'vitepress/theme'
import './custom.css'
import VideoPlayer from './VideoPlayer.vue'

export default {
  extends: DefaultTheme,
  enhanceApp({ app }: { app: import('vue').App }) {
    app.component('VideoPlayer', VideoPlayer)
  },
}
