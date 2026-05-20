<script setup lang="ts">
import { ref, onMounted } from 'vue'

defineProps<{
  src: string
  poster?: string
}>()

const videoRef = ref<HTMLVideoElement>()

onMounted(() => {
  videoRef.value?.load()
})
</script>

<template>
  <video
    ref="videoRef"
    :src="src"
    :poster="poster"
    controls
    style="width: 100%; border-radius: 8px; margin: 1.5rem 0;"
  />
</template>
