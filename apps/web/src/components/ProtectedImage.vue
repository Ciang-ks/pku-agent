<script setup lang="ts">
import { onBeforeUnmount, ref, watch } from "vue";
import type { ApiClient } from "../api";
const props = defineProps<{ api: ApiClient; courseId: string; path: string; alt?: string }>();
const url = ref("");
const failed = ref(false);
let generation = 0;
watch(() => [props.courseId, props.path], async () => {
  const current = ++generation;
  if (url.value) URL.revokeObjectURL(url.value);
  url.value = "";
  failed.value = false;
  try {
    const blob = await props.api.materialBlob(props.courseId, props.path);
    if (current === generation) url.value = URL.createObjectURL(blob);
  } catch { if (current === generation) failed.value = true; }
}, { immediate: true });
onBeforeUnmount(() => { generation++; if (url.value) URL.revokeObjectURL(url.value); });
</script>
<template><img v-if="url" :src="url" :alt="alt || '资料插图'" /><span v-else>{{ failed ? `图片不可用：${alt || path}` : '加载插图…' }}</span></template>
