<script setup lang="ts">
import { compareLessons, recordingLessonDate } from "../../../../packages/core/src/learning/lesson-order";
import { computed, onMounted, ref, watch } from "vue";
import type { ApiClient } from "../api";
import type { CourseWorkspace, Lesson, LessonOutline, TeachingItem, CourseNoteSource, SourceSelection, CourseDocumentBlock, Material } from "../types";
import LessonFiles from "./LessonFiles.vue";
import MarkdownDocument from "./MarkdownDocument.vue";
const props = defineProps<{ course: CourseWorkspace; api: ApiClient; agentBusy?: boolean }>();
const emit = defineEmits<{ dirtyChange: [dirty: boolean]; activeChange: [lesson: Lesson]; assistant: [prompt: string] }>();
const lessons = ref<Lesson[]>([]);
const sortedLessons = computed(() => [...lessons.value].sort(compareLessons));
const recordingMode = ref<"none" | "remote" | "uploaded">("none");
const active = ref<Lesson>();
const tab = ref<"document" | "outline" | "sources" | "files">("document");
const resultTab = ref<"lecture" | "practice" | "other">("lecture");
const title = ref(""); const date = ref(""); const dateManual = ref(false); const recordingId = ref(""); const transcriptPath = ref("");
const mediaAssetId = ref(""); const uploadedRecordings = ref<Material[]>([]);
const recordings = ref<TeachingItem[]>([]); const transcripts = ref<CourseNoteSource[]>([]);
const createOpen = ref(false); const pending = ref(false); const error = ref("");
const editing = ref(false); const markdown = ref(""); const outline = ref<LessonOutline>({ basis: "manual", topics: [] });
const sourcePassages = ref<(SourceSelection & { blocks: CourseDocumentBlock[] })[]>([]);
const outlineDirty = computed(() => JSON.stringify(outline.value) !== JSON.stringify(active.value?.outline ?? { basis: "manual", topics: [] }));
const documentDirty = computed(() => editing.value && markdown.value !== (active.value?.document?.markdown ?? ""));
const inferredDate = computed(() => {
  const recording = recordings.value.find(item => item.remoteId === recordingId.value);
  return recordingMode.value === "remote" && recording ? recordingLessonDate(recording) ?? "" : "";
});
watch(inferredDate, value => { if (!dateManual.value) date.value = value; });
watch(recordingMode, mode => {
  if (mode !== "remote") recordingId.value = "";
  if (mode !== "uploaded") mediaAssetId.value = "";
});
function useRecordingDate() { dateManual.value = false; date.value = inferredDate.value; }
watch(() => documentDirty.value || outlineDirty.value, dirty => emit("dirtyChange", dirty));
function select(lesson: Lesson, replace = false) {
  if (!replace && (documentDirty.value || outlineDirty.value)) { error.value = "请先保存或取消正文/大纲的修改，再切换课次"; return; }
  lessons.value = lessons.value.map(l => l.lessonId === lesson.lessonId ? lesson : l);
  active.value = lesson; emit("activeChange", lesson); markdown.value = lesson.document?.markdown ?? "";
  outline.value = JSON.parse(JSON.stringify(lesson.outline ?? { basis: "manual", topics: [] }));
  editing.value = false; error.value = "";
}
async function refresh() {
  try {
    lessons.value = await props.api.listLessons(props.course.courseId);
    if (!documentDirty.value && !outlineDirty.value) {
      const selected = lessons.value.find(l => l.lessonId === active.value?.lessonId) ?? sortedLessons.value[0];
      if (selected) select(selected);
    }
    const [items, sources, materials] = await Promise.all([props.api.listCourseOverview(props.course.courseId), props.api.listCourseNoteSources(props.course.courseId), props.api.listMaterials(props.course.courseId)]);
    uploadedRecordings.value = materials.filter(m => m.role === "recording");
    recordings.value = items.filter(i => i.kind === "video" && i.remoteIdStable);
    transcripts.value = sources.filter(s => s.kind === "recording-transcript");
  } catch (e) { error.value = e instanceof Error ? e.message : "读取失败"; }
}
async function create() {
  if (!title.value.trim() || pending.value || documentDirty.value || outlineDirty.value) return;
  await run(async () => {
    const lesson = await props.api.createLesson(props.course.courseId, { title: title.value.trim(), ...(date.value ? { date: date.value } : {}),
      recordingIds: recordingId.value ? [recordingId.value] : [], recordingAssetIds: mediaAssetId.value ? [mediaAssetId.value] : [], transcriptPaths: transcriptPath.value ? [transcriptPath.value] : [] });
    lessons.value.push(lesson); select(lesson); createOpen.value = false; title.value = ""; recordingMode.value = "none"; date.value = ""; dateManual.value = false; recordingId.value = ""; mediaAssetId.value = ""; transcriptPath.value = "";
  });
}
async function run(action: () => Promise<void>) { pending.value = true; error.value = ""; try { await action(); } catch (e) { error.value = e instanceof Error ? e.message : "操作失败"; } finally { pending.value = false; } }
async function save() { if (outlineDirty.value) { error.value = "请先保存或取消大纲修改"; return; } if (active.value) await run(async () => { const updated = await props.api.saveLessonDocument(active.value!, markdown.value); editing.value = false; select(updated, true); await refresh(); }); }
async function saveOutline() { if (documentDirty.value) { error.value = "请先保存或取消正文修改"; return; } if (active.value) await run(async () => { select(await props.api.saveLessonOutline(active.value!, outline.value), true); await refresh(); }); }
async function removeSelection(index: number) { if (documentDirty.value || outlineDirty.value) { error.value = "请先保存或取消当前修改，再调整选材"; return; } if (active.value) await run(async () => { select(await props.api.saveLessonSelections(active.value!, active.value!.selections.filter((_, i) => i !== index)), true); }); }
function generate(kind: "lecture" | "practice" | "other" = "lecture") {
  if (!active.value) return;
  const prompt = kind === "practice" ? "/skill:practice-generator\n请根据本节原文和讲义生成并保存 5 道配套练习，题目与答案分开。" : kind === "other" ? "请基于本节原文生成并保存一份复习提纲。" : "/skill:lesson-learning\n请根据本节上下文生成并保存讲义，保留人工编辑，说明缺失来源。";
  emit("assistant", prompt);
}
function addTopic() { outline.value.topics.push({ topicId: crypto.randomUUID(), title: "", summary: "" }); }
defineExpose({ refresh, select });
watch(() => [active.value?.lessonId, active.value?.revision], async () => {
  const lesson = active.value;
  sourcePassages.value = [];
  if (!lesson?.selections.length) return;
  try {
    const sources = await props.api.request<(SourceSelection & { blocks: CourseDocumentBlock[] })[]>(`/api/courses/${props.course.courseId}/lessons/${lesson.lessonId}/sources`);
    if (active.value?.lessonId === lesson.lessonId && active.value.revision === lesson.revision) sourcePassages.value = sources;
  } catch (e) { error.value = e instanceof Error ? e.message : "读取来源失败"; }
});
onMounted(refresh);
</script>
<template>
  <section class="learning-workspace">
    <aside class="lesson-sidebar">
      <header class="learning-toolbar"><h2>每节课</h2><button class="button ghost" :disabled="pending || documentDirty || outlineDirty" @click="createOpen = !createOpen">＋ 新建</button></header>
      <form v-if="createOpen" class="lesson-form" @submit.prevent="create">
        <select v-model="recordingMode" aria-label="是否关联录播" :disabled="pending"><option value="none">暂不关联录播</option><option value="remote">关联教学网录播</option><option value="uploaded">关联已上传录播</option></select>
        <select v-if="recordingMode === 'remote'" v-model="recordingId" aria-label="关联录播" :disabled="pending" required><option value="">选择教学网录播</option><option v-for="r in recordings" :key="r.remoteId" :value="r.remoteId">{{ recordingLessonDate(r) || '日期未知' }} · {{ r.title }}</option></select>
        <select v-if="recordingMode === 'uploaded'" v-model="mediaAssetId" aria-label="关联上传录播" :disabled="pending" required><option value="">选择上传录播</option><option v-for="m in uploadedRecordings" :key="m.assetId" :value="m.assetId">{{ m.title }}</option></select>
        <input v-model="title" placeholder="本节课标题" aria-label="课次标题" :disabled="pending" required />
        <input v-model="date" type="date" aria-label="授课日期" :disabled="pending" @input="dateManual = Boolean(date)" />
        <small v-if="inferredDate">{{ dateManual ? '使用手动日期' : '已从录播提取日期' }} · {{ inferredDate }}<button v-if="dateManual" type="button" class="button ghost" :disabled="pending" @click="useRecordingDate">恢复录播日期</button></small>
        <small v-else-if="recordingMode !== 'none'">{{ recordingMode === 'remote' && !recordingId ? '选择录播后自动提取授课日期。' : '录播未提供可用日期，可手动填写。' }}</small>
        <select v-model="transcriptPath" aria-label="关联已有转写稿"><option value="">选择已有转写稿（可选）</option><option v-for="t in transcripts" :key="t.sourcePath" :value="t.sourcePath">{{ t.title }}</option></select>
        <button class="button primary" :disabled="pending">建立课次</button>
      </form>
      <button v-for="lesson in sortedLessons" :key="lesson.lessonId" class="lesson-item" :class="{ selected: active?.lessonId === lesson.lessonId }" @click="select(lesson)">
        <small>{{ lesson.date || '日期未设置' }}</small><strong>{{ lesson.title }}</strong><span>{{ lesson.documentStale ? '讲义待更新' : lesson.document ? '讲义已保存' : lesson.selections.length ? '已选材' : lesson.outline ? '已有大纲' : '待整理' }}</span>
      </button>
      <p v-if="!lessons.length">从一节课开始，将录播和资料整理为可持续编辑的讲义。</p>

    </aside>
    <div class="lesson-main">
      <header class="learning-toolbar"><div><p class="eyebrow">LESSON WORKSPACE</p><h2>{{ active?.title || '课程学习空间' }}</h2></div>
        <div class="learning-actions"><button class="button ghost" :disabled="pending || editing" @click="refresh">刷新</button></div>
      </header>
      <nav class="learning-tabs" aria-label="课次内容"><button :class="{ selected: tab !== 'files' }" @click="tab = 'document'">讲义与练习</button><button :class="{ selected: tab === 'files' }" :disabled="documentDirty || outlineDirty" @click="tab = 'files'">本节文件 <small>{{ active?.materialRefs?.length ?? 0 }}</small></button></nav>
      <p v-if="error" class="notice error" role="alert">{{ error }}</p>
      <LessonFiles v-if="tab === 'files' && active" :key="active.lessonId" :lesson="active" :api="api" :agent-busy="agentBusy" @updated="select($event, true)" @organize="generate()" />
      <template v-else-if="active">
        <nav class="result-nav" aria-label="本节成果"><button v-for="item in [{ id: 'lecture', label: '讲义' }, { id: 'practice', label: '配套练习' }, { id: 'other', label: '其他资料' }]" :key="item.id" class="button" :class="resultTab === item.id ? 'secondary' : 'ghost'" :disabled="documentDirty || outlineDirty" @click="resultTab = item.id as typeof resultTab; tab = 'document'">{{ item.label }}</button></nav>
        <section v-if="resultTab !== 'lecture'">
          <header class="learning-toolbar"><h3>{{ resultTab === 'practice' ? '本节配套练习' : '本节其他资料' }}</h3><button v-if="resultTab === 'practice'" class="button primary" :disabled="pending || agentBusy" @click="generate('practice')">生成配套练习</button></header>
          <p v-if="!active.artifacts?.some(a => a.kind === resultTab)">{{ resultTab === 'other' ? '在助手中输入 /，选择复习提纲或描述需要的资料。成果会保存在这里。' : '生成后会保存到当前课次。' }}</p>
          <article v-for="artifact in (active.artifacts ?? []).filter(a => a.kind === resultTab)" :key="artifact.artifactId" class="lesson-artifact"><h3>{{ artifact.title }}</h3><MarkdownDocument :markdown="artifact.markdown" :course-id="course.courseId" :api="api" /><details v-if="artifact.answersMarkdown"><summary>查看答案与解析</summary><MarkdownDocument :markdown="artifact.answersMarkdown" :course-id="course.courseId" :api="api" /></details></article>
        </section>
        <template v-else>
        <details class="lesson-detail"><summary>大纲与来源</summary><div class="learning-actions"><button class="button ghost" :disabled="documentDirty" @click="tab = 'outline'">编辑本节大纲</button><button class="button ghost" :disabled="documentDirty || outlineDirty" @click="tab = 'sources'">查看讲义引用</button><button class="button ghost" @click="tab = 'document'">返回讲义</button></div></details>
        <div v-if="tab === 'document'">
          <p v-if="active.documentStale" class="notice">大纲或选材已更新，当前讲义仍保留原内容。可交给助手按新范围更新。</p>
          <header class="learning-toolbar"><button class="button primary" :disabled="editing || outlineDirty || pending || agentBusy" @click="generate()">{{ active.document ? '更新讲义' : '生成讲义' }}</button><small>{{ active.document ? '已保存到本课次' : '讲义尚未生成' }}</small><button v-if="!editing" class="button secondary" :disabled="outlineDirty" @click="editing = true">编辑讲义</button><div v-else class="learning-actions"><button class="button ghost" @click="editing = false; markdown = active.document?.markdown ?? ''">取消</button><button class="button primary" :disabled="pending || !markdown.trim()" @click="save">保存</button></div></header>
          <textarea v-if="editing" v-model="markdown" class="document-editor" aria-label="讲义 Markdown 编辑器" placeholder="使用 Markdown 记录本节内容…" />
          <MarkdownDocument v-else-if="active.document" :markdown="active.document.markdown" :course-id="course.courseId" :api="api" />
          <div v-else class="lesson-empty"><h3>先确定本节内容，再整理讲义</h3><p>在「本节文件」中拖入资料或引用教材片段，再生成讲义。有已关联的录播转写稿时，会一并参考。</p></div>
        </div>
        <div v-else-if="tab === 'outline'" class="outline-editor">
          <label>大纲依据<select v-model="outline.basis"><option value="recording">录播</option><option value="materials">资料推断</option><option value="manual">人工范围</option></select></label>
          <div v-for="(topic, index) in outline.topics" :key="topic.topicId" class="outline-topic"><input v-model="topic.title" :aria-label="`主题 ${index + 1}`" placeholder="主题" /><textarea v-model="topic.summary" aria-label="主题内容与范围" /><small v-if="topic.startSeconds !== undefined">录播 {{ topic.startSeconds }}–{{ topic.endSeconds }} 秒</small><button class="button ghost" @click="outline.topics.splice(index, 1)">移除主题</button></div>
          <div class="learning-actions"><button class="button secondary" @click="addTopic()">＋ 主题</button><button class="button primary" :disabled="pending || !outline.topics.length" @click="saveOutline">保存大纲</button></div>
          <button v-if="outlineDirty" class="button ghost" @click="outline = JSON.parse(JSON.stringify(active?.outline ?? { basis: 'manual', topics: [] }))">取消修改</button><p>修改大纲后需重新选材，已有讲义会保留并标记待更新。</p>
        </div>
        <div v-else-if="tab === 'sources'"><p v-if="!active.selections.length">助手会将本节主题与具体资料片段关联；每项保留原文位置和选择理由。</p><article v-for="(source, index) in active.selections" :key="index" class="source-card"><h3>{{ active.outline?.topics.find(t => t.topicId === source.topicId)?.title }}</h3><p>{{ source.reason }}</p><small>{{ source.sourcePath }} · {{ source.blockIds.length }} 个文本块</small><div v-for="block in sourcePassages[index]?.blocks ?? []" :key="block.blockId"><small v-if="block.page !== undefined">原资料第 {{ block.page }} 页</small><MarkdownDocument :markdown="block.text" :course-id="course.courseId" :api="api" /></div><button class="button ghost" :disabled="pending" @click="removeSelection(index)">移除</button></article></div>
        </template>
      </template>
      <div v-else class="lesson-empty"><h3>建立第一节课</h3><p>课程资料可以先加入资料库；讲义按每节课保存。</p></div>
    </div>
  </section>
</template>
