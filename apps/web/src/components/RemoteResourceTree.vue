<script setup lang="ts">
import type { RemoteContentNode } from "../types";

defineOptions({ name: "RemoteResourceTree" });
defineProps<{ nodes: RemoteContentNode[]; busyResourceId: string | undefined }>();
defineEmits<{ import: [resource: RemoteContentNode] }>();

const kindLabels: Record<RemoteContentNode["kind"], string> = {
  section: "栏目",
  folder: "文件夹",
  document: "文档",
  file: "文件",
  assignment: "作业",
  announcement: "公告",
  video: "录播",
  audio: "音频",
  quiz: "测验",
  unknown: "资料"
};
</script>

<template>
  <ol class="resource-tree">
    <li v-for="node in nodes" :key="node.resourceId">
      <div class="resource-row" :class="{ imported: node.isImported }">
        <span class="resource-kind">{{ kindLabels[node.kind] }}</span>
        <span class="resource-title">
          <strong>{{ node.title }}</strong>
          <small>{{ node.remoteResourceId }}</small>
        </span>
        <span v-if="node.isImported" class="imported-mark">已导入</span>
        <button
          v-else
          class="resource-action"
          :disabled="busyResourceId === node.resourceId"
          @click="$emit('import', node)"
        >
          {{ busyResourceId === node.resourceId ? "导入中…" : "导入" }}
        </button>
      </div>
      <RemoteResourceTree
        v-if="node.children.length"
        :nodes="node.children"
        :busy-resource-id="busyResourceId"
        @import="$emit('import', $event)"
      />
    </li>
  </ol>
</template>
