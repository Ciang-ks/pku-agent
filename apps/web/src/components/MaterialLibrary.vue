<script setup lang="ts">
import { onMounted, ref } from "vue";
import type { ApiClient } from "../api";
import type { Material, MaterialRole } from "../types";
const props = defineProps<{ courseId: string; api: ApiClient }>();
const emit = defineEmits<{ changed: [] }>();
const materials = ref<Material[]>([]);
const role = ref<MaterialRole>("textbook");
const pending = ref(false);
const message = ref("");
const error = ref("");
const dragging = ref(false);
const roles: { value: MaterialRole; label: string }[] = [{ value: "textbook", label: "主教材" }, { value: "supplement", label: "补充教材" }, { value: "slides", label: "课件" }, { value: "recording", label: "录播 / 音频" }, { value: "other", label: "其他资料" }];
const statuses = { imported: "待处理", processing: "解析中", ready: "可用于讲义", failed: "解析失败" };
async function refresh() { materials.value = (await props.api.listMaterials(props.courseId)).filter(m => m.coursePublic !== false); }
async function upload(files: FileList | null) {
  if (!files?.length || pending.value) return;
  pending.value = true; error.value = "";
  try {
    for (const file of Array.from(files)) {
      message.value = `上传 ${file.name}`;
      const material = await props.api.uploadMaterial(props.courseId, file, role.value);
      await refresh();
      if (material.role !== "recording" && material.status !== "ready") {
        message.value = `云端解析 ${file.name}`;
        const parsed = await props.api.parseMaterial(material);
        if (parsed.status === "failed") error.value = parsed.error ?? "解析失败";
      }
      await refresh();
    }
    message.value = "资料已加入本课程";
    emit("changed");
  } catch (e) { error.value = e instanceof Error ? e.message : "上传失败"; }
  finally { pending.value = false; }
}
async function parse(material: Material) {
  pending.value = true; error.value = ""; message.value = `云端解析 ${material.title}`;
  try { await props.api.parseMaterial(material); await refresh(); emit("changed"); }
  catch (e) { error.value = e instanceof Error ? e.message : "解析失败"; }
  finally { pending.value = false; message.value = ""; }
}
async function classify(material: Material, event: Event) {
  try { await props.api.classifyMaterial(material, (event.target as HTMLSelectElement).value as MaterialRole); await refresh(); }
  catch (e) { error.value = e instanceof Error ? e.message : "分类失败"; }
}
function drop(event: DragEvent) { dragging.value = false; void upload(event.dataTransfer?.files ?? null); }
defineExpose({ refresh });
onMounted(() => refresh().catch(e => { error.value = String(e); }));
</script>
<template>
  <section class="material-library">
    <header class="learning-toolbar"><h3>课程公共库</h3><button class="button ghost" :disabled="pending" @click="refresh().catch(e => error = String(e))">刷新</button></header>
    <p>教材与课件可供多节课引用；本节补充资料请放入对应课次的「本节文件」。选择用途后拖入文件，自动上传并解析。</p>
    <div class="material-drop" :class="{ dragging }" @dragover.prevent="dragging = true" @dragleave.prevent="dragging = false" @drop.prevent="drop">
      <select v-model="role" aria-label="上传资料用途" :disabled="pending"><option v-for="r in roles" :key="r.value" :value="r.value">{{ r.label }}</option></select>
      <label class="button secondary">{{ pending ? '正在处理…' : '选择文件或拖入此处' }}<input type="file" multiple :disabled="pending" accept=".pdf,.md,.txt,.ppt,.pptx,.doc,.docx,.png,.jpg,.jpeg,.webp,.mp3,.mp4,.m4a,.wav,.webm" @change="upload(($event.target as HTMLInputElement).files)" /></label>
      <small>PDF、课件、Word、图片、音视频，每个文件不超过 100 MB</small>
    </div>
    <p v-if="message" role="status">{{ message }}</p><p v-if="error" class="notice error" role="alert">{{ error }}</p>
    <div v-for="material in materials" :key="material.assetId" class="material-row">
      <div><strong>{{ material.title }}</strong><small>{{ statuses[material.status] }}</small><p v-if="material.error" class="notice error">{{ material.error }}</p></div>
      <select :value="material.role" :aria-label="`${material.title} 的用途`" @change="classify(material, $event)"><option v-for="r in roles" :key="r.value" :value="r.value">{{ r.label }}</option></select>
      <button v-if="material.status !== 'ready' && material.role !== 'recording'" class="button ghost" :disabled="pending" @click="parse(material)">解析</button>
    </div>
    <p v-if="!materials.length && !pending">加入教材和课件后，助手会按本节大纲选取相关内容。</p>
  </section>
</template>
