<script setup lang="ts">
// The banner at the top of an experimental or deprecated page, drawn from the page's `status`
// frontmatter (see `../page-status.mjs`). It replaced a warning box copied by hand into each page.
//
// No title line: the sentence itself names the status. The words name no use of tapflow on purpose:
// the status belongs to the page, and a page moves between sections more often than its status changes.
import { computed } from 'vue'
import { useData, withBase } from 'vitepress'

const { frontmatter, localeIndex } = useData()

const ko = computed(() => localeIndex.value === 'ko')
const status = computed(() => {
  const value = frontmatter.value.status
  return value === 'experimental' || value === 'deprecated' ? value : null
})
const meaning = computed(() => withBase(`${ko.value ? '/ko' : ''}/get-started/introduction#page-status`))
const replacement = computed(() => {
  const path = frontmatter.value.replacedBy
  return typeof path === 'string' ? withBase(`${ko.value ? '/ko' : ''}${path}`) : null
})
</script>

<template>
  <div v-if="status" class="vp-doc page-status">
    <div class="custom-block" :class="status === 'deprecated' ? 'danger' : 'warning'">
      <p v-if="status === 'experimental' && !ko">
        This page covers an experimental feature. It can change in a minor release, and every change is
        listed in the CHANGELOG. <a :href="meaning">What this means</a>
      </p>
      <p v-else-if="status === 'experimental'">
        이 페이지에서 다루는 기능은 아직 실험 단계입니다. 마이너 릴리스에서도 동작이 바뀔 수 있으며 바뀐
        내용은 CHANGELOG에서 확인할 수 있습니다. <a :href="meaning">페이지 상태 알아보기</a>
      </p>
      <p v-else-if="!ko">
        This page covers a deprecated feature. It still works but will be removed, so use
        <a :href="replacement ?? meaning">its replacement</a> instead. <a :href="meaning">What this means</a>
      </p>
      <p v-else>
        이 페이지에서 다루는 기능은 지원 중단 예정입니다. 지금은 동작하지만 이후 제거되므로
        <a :href="replacement ?? meaning">대체 기능</a>을 쓰세요. <a :href="meaning">페이지 상태 알아보기</a>
      </p>
    </div>
  </div>
</template>

<style scoped>
.page-status {
  margin-bottom: 24px;
}
/* VitePress pads a custom block 16px on top and 8px below, and makes the difference up with the
   bottom margin of a paragraph that follows the title. With no title the one paragraph is the first
   child, which VitePress gives no margin, so the bottom would be 8px short. */
.custom-block {
  padding-bottom: 16px;
}
/* A link label broken across lines read as two words ("상/태의 뜻"). */
a {
  white-space: nowrap;
}
</style>
