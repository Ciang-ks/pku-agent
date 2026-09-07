<script setup lang="ts">
import type { DoctorCheck } from "../types";

defineProps<{
  checks: DoctorCheck[];
  loading: boolean;
}>();

defineEmits<{ run: []; close: [] }>();
</script>

<template>
  <aside class="side-panel" aria-label="环境诊断">
    <header class="panel-header">
      <div>
        <p class="eyebrow">LOCAL RUNTIME</p>
        <h2>环境诊断</h2>
      </div>
      <button class="icon-button" aria-label="关闭" @click="$emit('close')">×</button>
    </header>

    <p class="panel-copy">检查学习平台运行所需及建议安装的本地工具，不会更改系统配置。</p>
    <button class="button primary full" :disabled="loading" @click="$emit('run')">
      {{ loading ? "检查中…" : checks.length ? "重新检查" : "开始检查" }}
    </button>

    <ol v-if="checks.length" class="check-list">
      <li v-for="check in checks" :key="check.id" class="check-item">
        <span class="status-dot" :class="check.status" />
        <div>
          <strong>{{ check.label }}</strong>
          <p>{{ check.detail }}</p>
          <small v-if="check.version">版本 {{ check.version }}</small>
        </div>
      </li>
    </ol>
    <div v-else class="panel-empty">
      <span>◎</span>
      <p>尚未运行诊断</p>
    </div>
  </aside>
</template>
