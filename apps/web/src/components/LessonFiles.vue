<script setup lang="ts">
import { computed, ref, watch, nextTick } from "vue";
import type { ApiClient } from "../api";
import type { Lesson, Material, CourseDocumentBlock, LessonContext, LessonMaterialRef } from "../types";
import MarkdownDocument from "./MarkdownDocument.vue";
const props = defineProps<{ lesson: Lesson; api: ApiClient; agentBusy?: boolean }>();
const emit = defineEmits<{ updated: [lesson: Lesson]; organize: [] }>();
const materials = ref<Material[]>([]); const pending = ref(false); const error = ref("");
const focus = ref(""); const autoPublic = ref(true); const context = ref<LessonContext>();
const selected = ref<Material>(); const blocks = ref<CourseDocumentBlock[]>([]); const checked = ref<string[]>([]);
const publicIds = ref<string[]>([]); const preview = ref(false); const dragging = ref(false);
const files = computed(() => (props.lesson.materialRefs ?? []).map(r => ({ ref: r, material: materials.value.find(m => m.assetId === r.assetId) })));
const publicFiles = computed(() => materials.value.filter(m => m.coursePublic !== false && !files.value.some(f => f.ref.assetId === m.assetId)));
const remainingRefs = computed(() => Math.max(0, 100 - files.value.length));
const allPublicSelected = computed(() => publicFiles.value.length > 0 && publicIds.value.length === publicFiles.value.length);
async function refresh() { materials.value = await props.api.listMaterials(props.lesson.courseId); }
async function run(action: () => Promise<void>) { if (pending.value) return; pending.value = true; error.value = ""; try { await action(); } catch(e) { error.value = e instanceof Error ? e.message : "操作失败"; } finally { pending.value = false; } }
async function save(refs = props.lesson.materialRefs ?? [], exclusions = props.lesson.excludedBlockIds ?? []) {
  const updated = await props.api.saveLessonInputs(props.lesson, refs, focus.value, autoPublic.value, exclusions);
  context.value = undefined; emit("updated", updated);
}
async function upload(files: FileList | null) {
  if (!files?.length || pending.value) return;
  await run(async () => {
    let lesson = props.lesson;
    for (const file of Array.from(files)) {
      const material = await props.api.uploadMaterial(lesson.courseId, file, "supplement", lesson);
      lesson = await props.api.getLesson(lesson.courseId, lesson.lessonId); emit("updated", lesson);
      if (material.role !== "recording" && material.status !== "ready") {
        const parsed = await props.api.parseMaterial(material);
        if (parsed.status === "failed") error.value = parsed.error ?? "解析失败，文件已保留，可重试";
      }
      await refresh();
    }
  });
}
async function choose(material?: Material) {
  if (!material) return;
  await run(async () => { blocks.value = await props.api.materialBlocks(material); checked.value = [...(props.lesson.materialRefs?.find(r => r.assetId === material.assetId)?.blockIds ?? [])]; selected.value = material; });
}
async function include(blockIds: string[]) {
  if (!selected.value) return;
  const ref: LessonMaterialRef = { assetId: selected.value.assetId, blockIds };
  await run(async () => { await save([...(props.lesson.materialRefs ?? []).filter(r => r.assetId !== ref.assetId), ref]); selected.value = undefined; });
}
async function includePublic() {
  const additions = publicFiles.value.filter(file => publicIds.value.includes(file.assetId));
  if (!additions.length || additions.length > remainingRefs.value) return;
  await run(async () => {
    await save([...(props.lesson.materialRefs ?? []), ...additions.map(file => ({ assetId: file.assetId, blockIds: [] }))]);
    publicIds.value = [];
  });
}
async function parse(material: Material) { await run(async () => { const result = await props.api.parseMaterial(material); if (result.status === "failed") error.value = result.error ?? "解析失败"; await refresh(); }); }
async function showContext() { await run(async () => { await save(); }); if (error.value) return; await nextTick(); await run(async () => { context.value = await props.api.lessonContext(props.lesson.courseId, props.lesson.lessonId); preview.value = true; }); }
watch(() => props.lesson, lesson => { focus.value = lesson.focus ?? ""; autoPublic.value = lesson.autoPublic !== false; context.value = undefined; }, { immediate: true });
watch(publicFiles, available => { publicIds.value = publicIds.value.filter(id => available.some(file => file.assetId === id)).slice(0, remainingRefs.value); });
watch(() => props.lesson.lessonId, () => { publicIds.value = []; selected.value = undefined; preview.value = false; void refresh().catch(e => error.value = String(e)); }, { immediate: true });
</script>
<template>
  <section class="lesson-files">
    <header class="learning-toolbar"><div><h3>本节文件索引</h3><p>本节补充文件、公共库引用与关联录播共同确定学习范围。</p></div><button class="button ghost" :disabled="pending || agentBusy" @click="run(async () => { await save(); await nextTick(); emit('organize'); })">AI 整理本节</button></header>
    <p v-if="error" class="notice error" role="alert">{{ error }}</p>
    <div class="material-drop" :class="{ dragging }" @dragover.prevent="dragging = true" @dragleave.prevent="dragging = false" @drop.prevent="dragging = false; upload($event.dataTransfer?.files ?? null)">
      <label class="button secondary">{{ pending ? '处理中…' : '拖入本节补充资料，或选择文件' }}<input type="file" multiple :disabled="pending" @change="upload(($event.target as HTMLInputElement).files)" /></label><small>文件自动关联本节；文档自动解析，音视频保留待转写。每个文件最多 100 MB。</small>
    </div>
    <article v-for="file in files" :key="file.ref.assetId" class="material-row">
      <div><strong>{{ file.material?.title ?? '资料暂不可用' }}</strong><small>{{ file.material?.coursePublic === false ? '本节补充' : '公共库引用' }} · {{ file.ref.blockIds.length ? `${file.ref.blockIds.length} 个指定片段` : '文件内容（受上下文预算限制）' }} · {{ file.material?.status === 'ready' ? '已索引' : file.material?.status === 'failed' ? '解析失败' : '待解析 / 转写' }}</small></div>
      <div class="learning-actions"><button v-if="file.material?.status === 'ready'" class="button ghost" :disabled="pending" @click="choose(file.material)">选择片段</button><button v-else-if="file.material && file.material.role !== 'recording'" class="button ghost" :disabled="pending" @click="parse(file.material)">重试解析</button><button class="button ghost" :disabled="pending" @click="run(() => save((lesson.materialRefs ?? []).filter(r => r.assetId !== file.ref.assetId)))">移出本节</button></div>
    </article>
    <p v-if="!files.length">还没有补充文件。也可以直接从公共库选择本节所需内容。</p>
    <section class="public-reference-picker" aria-label="引用公共库文件">
      <header class="learning-toolbar"><h3>引用公共库文件</h3><span>已勾选 {{ publicIds.length }} 个</span></header>
      <p>勾选多个文件，一次加入本节。加入后可逐个「选择片段」，缩小教材范围；内容仍受上下文预算限制。</p>
      <template v-if="publicFiles.length">
        <label class="public-reference-option"><input type="checkbox" :checked="allPublicSelected" :indeterminate="publicIds.length > 0 && !allPublicSelected" :disabled="pending || (!allPublicSelected && publicFiles.length > remainingRefs)" @change="publicIds = allPublicSelected ? [] : publicFiles.map(file => file.assetId)" />全选待引用文件</label>
        <div class="public-reference-list">
          <label v-for="file in publicFiles" :key="file.assetId" class="public-reference-option">
            <input v-model="publicIds" type="checkbox" :value="file.assetId" :disabled="pending || (!publicIds.includes(file.assetId) && publicIds.length >= remainingRefs)" />
            <span><strong>{{ file.title }}</strong><small>{{ file.status === 'ready' ? '已索引' : file.status === 'failed' ? '解析失败 · 加入后需重试解析' : '待解析 / 转写 · 完成后才能进入上下文' }}</small></span>
          </label>
        </div>
        <div class="learning-actions"><button class="button secondary" :disabled="pending || !publicIds.length || publicIds.length > remainingRefs" @click="includePublic">加入本节（{{ publicIds.length }}）</button><button class="button ghost" :disabled="pending || !publicIds.length" @click="publicIds = []">清空勾选</button></div>
        <small v-if="publicFiles.length > remainingRefs">本节最多引用 100 个文件，还可加入 {{ remainingRefs }} 个。</small>
      </template>
      <p v-else>{{ materials.some(file => file.coursePublic !== false) ? '公共库文件已全部加入本节。' : '公共库暂无文件，可先到公共资料库上传。' }}</p>
      <div class="public-reference-auto">
        <label class="public-reference-option"><input v-model="autoPublic" type="checkbox" :disabled="pending" />自动参考公共库相关片段</label>
        <p>开启后，系统也会从未勾选的公共资料中检索本节相关片段，交给助手生成讲义；不会修改公共库原文件。关闭后仅使用本节指定资料、关联转写稿及对话中 @ 的文件。</p>
        <button class="button ghost" :disabled="pending || autoPublic === (lesson.autoPublic !== false)" @click="run(() => save())">保存自动参考设置</button>
      </div>
    </section>
    <section v-if="selected" class="source-picker"><header class="learning-toolbar"><h3>{{ selected.title }} · 选择原文片段</h3><button class="button ghost" @click="selected = undefined">关闭</button></header>
      <p>勾选本节需要的片段；教材建议按章节或页码选取。</p>
      <div class="source-picker-blocks"><label v-for="block in blocks" :key="block.blockId" class="source-choice"><input v-model="checked" type="checkbox" :value="block.blockId" /><span><small>{{ block.page ? `第 ${block.page} 页` : block.title }}</small><span>{{ block.text }}</span></span></label></div>
      <div class="learning-actions"><button class="button primary" :disabled="pending || !checked.length" @click="include(checked)">引用 {{ checked.length }} 个片段</button><button class="button ghost" :disabled="pending" @click="include([])">引用文件（可能截断）</button></div>
    </section>
    <details class="lesson-detail"><summary>关联录播与转写稿 · {{ lesson.recordingIds.length + lesson.recordingAssetIds.length }} 个录播 / {{ lesson.transcriptPaths.length }} 份转写</summary><p v-for="path in lesson.transcriptPaths" :key="path">{{ path }}</p><p v-if="!lesson.transcriptPaths.length">尚无关联转写稿。录播内容只有完成转写并关联后才会进入生成上下文。</p></details>
    <details class="lesson-detail" :open="preview"><summary>生成范围与原文预览</summary>
      <label class="scope-field">本节内容范围<input v-model="focus" placeholder="例如：特征值定义及求解，不包含对角化" /></label>
      <div class="learning-actions"><button class="button secondary" :disabled="pending" @click="run(() => save())">保存范围</button><button class="button ghost" :disabled="pending" @click="showContext">保存并预览上下文</button></div>
      <template v-if="context"><p>{{ context.sources.length }} 组原文 · {{ context.characters.toLocaleString() }} 字符。助手只能读取这些原文及本节已生成内容。</p><p v-for="warning in context.warnings" :key="warning" class="notice">{{ warning }}</p>
        <details v-for="(source, i) in context.sources" :key="i"><summary>{{ source.title }} · {{ source.origin === 'public' ? '自动参考' : source.origin === 'transcript' ? '录播转写' : '指定资料' }} · {{ source.blocks.length }} 片段</summary><article v-for="block in source.blocks" :key="block.blockId"><small>{{ block.page ? `第 ${block.page} 页` : block.title }}</small><MarkdownDocument :markdown="block.text" :course-id="lesson.courseId" :api="api" /><button class="button ghost" :disabled="pending" @click="run(() => save(lesson.materialRefs ?? [], [...(lesson.excludedBlockIds ?? []), block.blockId]))">排除此片段</button></article></details>
      </template>
      <button v-if="lesson.excludedBlockIds?.length" class="button ghost" :disabled="pending" @click="run(() => save(lesson.materialRefs ?? [], []))">恢复已排除的 {{ lesson.excludedBlockIds.length }} 个片段</button>
    </details>
  </section>
</template>
