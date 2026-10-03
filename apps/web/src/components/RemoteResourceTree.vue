<script setup lang="ts">
import type { RemoteContentNode } from "../types";

defineOptions({ name: "RemoteResourceTree" });
defineProps<{ nodes: RemoteContentNode[]; busyResourceId: string | undefined }>();
defineEmits<{ import: [resource: RemoteContentNode]; detail: [resource: RemoteContentNode] }>();

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
          <small v-if="node.kind === 'section' || node.kind === 'folder'">{{ node.children.length }} 项内容</small>
        </span>
        <span v-if="node.isImported" class="imported-mark">已导入</span>
        <button v-if="node.hasDetails && node.kind !== 'section'" class="resource-action" @click="$emit('detail', node)">详情</button>
        <button
          v-if="!node.isImported && node.kind !== 'section' && node.kind !== 'folder'"
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
        @detail="$emit('detail', $event)"
      />
    </li>
  </ol>
</template>
