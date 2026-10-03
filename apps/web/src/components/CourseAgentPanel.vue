<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, reactive, ref, nextTick, watch } from "vue";
import { assistantSkillsFor } from "../../../../packages/core/src/agent/skill-catalog";
import type { AssistantRequest } from "../assistant-scope";
import { ApiClient } from "../api";
import type { AgentSessionInfo, AgentSessionSummary, AgentStreamEvent, CourseWorkspace, Material, LessonContext } from "../types";

interface ChatMessage {
  id: number;
  role: "user" | "assistant";
  text: string;
}

const props = defineProps<{
  course: CourseWorkspace;
  api: ApiClient;
  initialPrompt?: string;
  mode?: "course" | "lecture-notes";
  noteSourcePaths?: string[];
  lessonId?: string | undefined;
  autoSend?: boolean;
  scopeLabel?: string;
  visible?: boolean;
  request?: AssistantRequest | undefined;
}>();
const emit = defineEmits<{ close: []; busyChange: [busy: boolean]; completed: [success: boolean] }>();

const session = ref<AgentSessionInfo>();
const messages = ref<ChatMessage[]>([]);
const draft = ref("");
const sessionName = ref("");
const savedSessions = ref<AgentSessionSummary[]>([]);
const selectedSessionId = ref("");
const pending = ref(false);
const error = ref("");
const activity = ref("");
let nextMessageId = 1;

const files = ref<Material[]>([]);
const mentions = ref<Material[]>([]);
const composer = ref<HTMLTextAreaElement>();
const trigger = ref<{ symbol: "@" | "/"; start: number; end: number; query: string }>();
const pickerIndex = ref(0);
const context = ref<LessonContext>();
let sessionScope = "";
let disposed = false;
const skillCommands = computed(() => assistantSkillsFor(props.lessonId ? "lesson" : props.mode === "lecture-notes" ? "lecture-notes" : "course", mentions.value.length > 0));
const scopeNotice = ref("");
let requestReady = false;
watch(pending, busy => emit("busyChange", busy));
watch(() => props.request?.id, () => { if (requestReady) acceptRequest(); });
function acceptRequest() {
  if (!props.request || pending.value) return;
  const hasDraft = Boolean(draft.value.trim());
  draft.value = hasDraft ? `${draft.value.trim()}\n\n${props.request.prompt}` : props.request.prompt;
  if (hasDraft) scopeNotice.value = "已保留草稿并加入本次要求，请检查后发送。";
  if (props.request.autoSend && !hasDraft) void send();
  else void nextTick(() => composer.value?.focus());
}
async function newConversation() {
  if (pending.value) return;
  const id = session.value?.sessionId;
  session.value = undefined; context.value = undefined; messages.value = []; selectedSessionId.value = ""; error.value = ""; activity.value = "";
  scopeNotice.value = "已开始新对话，将重新读取当前范围。";
  if (id) await props.api.closeAgentSession(id).catch(() => undefined);
}
watch(() => mentions.value.map(m => m.assetId).sort().join(","), () => {
  if (!session.value) return;
  void newConversation();
  scopeNotice.value = "引用文件已变更，已开始新对话；旧对话不会进入新的文件范围。";
});

const choices = computed(() => {
  const query = trigger.value?.query.toLowerCase() ?? "";
  return trigger.value?.symbol === "@" ? files.value.filter(f => !mentions.value.some(m => m.assetId === f.assetId) && f.title.toLowerCase().includes(query)).map(f => ({ id: f.assetId, label: f.title })) : skillCommands.value.filter(s => `${s.name} ${s.label}`.toLowerCase().includes(query)).map(s => ({ id: s.name, label: s.label }));
});
function inspectComposer() {
  const end = composer.value?.selectionStart ?? draft.value.length;
  const match = draft.value.slice(0, end).match(/(?:^|\s)([@/])([^\s@/]*)$/);
  trigger.value = match ? { symbol: match[1] as "@" | "/", start: end - match[2]!.length - 1, end, query: match[2]! } : undefined;
  pickerIndex.value = 0;
}
function chooseCommand(id: string) {
  const match = trigger.value; if (!match) return;
  if (match.symbol === "@") { const file = files.value.find(f => f.assetId === id); if (file) mentions.value.push(file); }
  const replacement = match.symbol === "/" ? `/skill:${id} ` : "";
  draft.value = draft.value.slice(0, match.start) + replacement + draft.value.slice(match.end);
  trigger.value = undefined;
  void nextTick(() => { composer.value?.focus(); composer.value?.setSelectionRange(match.start + replacement.length, match.start + replacement.length); });
}
function commandKey(event: KeyboardEvent) {
  if (!trigger.value) return;
  if (event.key === "Escape") { trigger.value = undefined; event.preventDefault(); }
  else if (choices.value.length && ["ArrowDown", "ArrowUp"].includes(event.key)) { event.preventDefault(); pickerIndex.value = (pickerIndex.value + (event.key === "ArrowDown" ? 1 : -1) + choices.value.length) % choices.value.length; }
  else if (choices.value.length && ["Enter", "Tab"].includes(event.key)) { event.preventDefault(); chooseCommand(choices.value[pickerIndex.value]!.id); }
}
async function previewContext() {
  if (!props.lessonId) return;
  try { context.value = await props.api.lessonContext(props.course.courseId, props.lessonId, mentions.value.map(m => m.assetId)); }
  catch (cause) { error.value = cause instanceof Error ? cause.message : "上下文读取失败"; }
}

const canSend = computed(() => Boolean(draft.value.trim()) && !pending.value);

async function ensureSession(): Promise<AgentSessionInfo> {
  const scope = JSON.stringify(mentions.value.map(m => m.assetId).sort());
  if (session.value && sessionScope !== scope) {
    await props.api.closeAgentSession(session.value.sessionId); session.value = undefined;
  }
  if (session.value) return session.value;
  sessionScope = scope;
  if (props.lessonId) {
    context.value = await props.api.lessonContext(props.course.courseId, props.lessonId, mentions.value.map(m => m.assetId));
    session.value = await props.api.createLessonSession(props.course.courseId, props.lessonId, context.value.contextId, mentions.value.map(m => m.assetId));
    return session.value;
  }
  if (props.mode === "lecture-notes" && !mentions.value.length) {
    session.value = await props.api.createLectureNotesSession(props.course.courseId, props.noteSourcePaths ?? []);
    return session.value;
  }
  session.value = await props.api.createCourseAgentSession(
    props.course.courseId,
    sessionName.value.trim() || undefined,
    mentions.value.map(m => m.assetId),
  );
  return session.value;
}

async function loadSavedSessions(): Promise<void> {
  try {
    savedSessions.value = await props.api.listCourseAgentSessions(props.course.courseId);
  } catch {
    savedSessions.value = [];
  }
}

async function resumeSelectedSession(): Promise<void> {
  const sessionId = selectedSessionId.value;
  if (!sessionId || session.value || pending.value) return;
  pending.value = true;
  error.value = "";
  try {
    const restored = await props.api.resumeCourseAgentSession(props.course.courseId, sessionId);
    if (disposed) { await props.api.closeAgentSession(restored.sessionId); return; }
    session.value = restored;
    sessionScope = "[]";
    sessionName.value = restored.name ?? "";
    messages.value = restored.messages.map((message) => ({ id: nextMessageId++, ...message }));
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : "无法恢复课程对话";
    selectedSessionId.value = "";
  } finally { pending.value = false; }
}

async function send(): Promise<void> {
  const originalDraft = draft.value.trim();
  const text = originalDraft + (mentions.value.length ? `\n引用文件：${mentions.value.map(m => m.title).join("、")}` : "");
  if (!text || pending.value) return;
  draft.value = "";
  error.value = "";
  activity.value = "";
  messages.value.push({ id: nextMessageId++, role: "user", text });
  const assistant = reactive({ id: nextMessageId++, role: "assistant" as const, text: "" });
  messages.value.push(assistant);
  pending.value = true;
  try {
    const activeSession = await ensureSession();
    if (disposed) { await props.api.closeAgentSession(activeSession.sessionId); return; }
    await props.api.streamAgentMessage(activeSession.sessionId, text, (event) => handleEvent(event, assistant));
    if (!disposed) emit("completed", !error.value);
    if (!assistant.text && error.value) messages.value = messages.value.filter(message => message.id !== assistant.id);
    else if (!assistant.text) assistant.text = "未返回可显示的回答。";
  } catch (cause) {
    messages.value = messages.value.filter((message) => message.id !== assistant.id);
    error.value = cause instanceof Error ? cause.message : "课程助手暂时不可用";
    draft.value = originalDraft;
    if (!disposed) emit("completed", false);
  } finally {
    pending.value = false;
    activity.value = "";
  }
}

function handleEvent(event: AgentStreamEvent, assistant: ChatMessage): void {
  if (event.type === "text_delta" && typeof event.data.delta === "string") {
    assistant.text += event.data.delta;
    return;
  }
  if (event.type === "tool_start" && typeof event.data.toolName === "string") {
    activity.value = `正在调用 ${event.data.toolName}`;
    return;
  }
  if (event.type === "tool_end" && typeof event.data.toolName === "string") {
    activity.value = `${event.data.toolName} 已完成`;
    return;
  }
  if (event.type === "error" && typeof event.data.message === "string") {
    error.value = event.data.message;
  }
}

function close() { emit("close"); }

onBeforeUnmount(() => {
  disposed = true;
  const sessionId = session.value?.sessionId;
  if (sessionId) void props.api.closeAgentSession(sessionId).catch(() => undefined);
});

onMounted(() => {
  requestReady = true;
  acceptRequest();
  if (!props.request && props.initialPrompt?.trim()) {
    draft.value = props.initialPrompt.trim();
    if (props.autoSend) void send();
  }
  if (!props.lessonId && props.mode !== "lecture-notes") void loadSavedSessions();
  void loadFiles();
});
async function loadFiles() {
    try {
      const [materials, lesson] = await Promise.all([props.api.listMaterials(props.course.courseId), props.lessonId ? props.api.getLesson(props.course.courseId, props.lessonId) : Promise.resolve(undefined)]);
      files.value = materials.filter(m => m.status === "ready" && (m.coursePublic !== false || lesson?.materialRefs?.some(r => r.assetId === m.assetId)) && (props.mode !== "lecture-notes" || props.noteSourcePaths?.includes(m.sourcePath ?? "")));
    } catch (cause) { error.value = cause instanceof Error ? cause.message : "无法读取文件列表"; }
}
watch(() => props.visible, visible => { if (visible) void loadFiles(); });
</script>

<template>
  <aside class="course-agent-panel" aria-label="课程助手">
    <header class="agent-panel-header">
      <div>
        <p class="eyebrow">COURSE AGENT</p>
        <h2>学习助手</h2>
      </div>
      <button class="icon-button" aria-label="收起学习助手" @click="close">×</button>
    </header>

    <div class="assistant-scope" aria-label="当前助手范围"><strong>{{ scopeLabel || course.name }}</strong><small>{{ lessonId ? '使用本节选材与录播转写 · 成果保存到本节' : mode === 'lecture-notes' ? '使用已选素材 · 保存为独立笔记' : '课程范围 · / 选择工作流，@ 限定文件问答' }}</small><button class="button ghost" :disabled="pending" @click="newConversation">新对话 / 更新上下文</button><p v-if="scopeNotice" role="status">{{ scopeNotice }}</p></div>
    <div class="agent-messages" aria-live="polite">
      <p v-if="!messages.length" class="agent-empty">输入问题，或用 / 选择工作流。切换页面时显示对应范围的对话。</p>
      <article v-for="message in messages" :key="message.id" class="agent-message" :class="message.role">
        <span>{{ message.role === "user" ? "你" : "助手" }}</span>
        <p>{{ message.text }}</p>
      </article>
    </div>

    <details v-if="!lessonId && !mentions.length && mode !== 'lecture-notes'" class="agent-session-settings"><summary>保存与恢复会话</summary>
    <label class="agent-session-name">
      <span>会话名称</span>
      <input v-model="sessionName" :disabled="Boolean(session) || pending" maxlength="100" placeholder="可选，留空使用内存会话" />
    </label>
    <label v-if="savedSessions.length && !session" class="agent-session-name">
      <span>恢复会话</span>
      <select v-model="selectedSessionId" :disabled="pending" @change="resumeSelectedSession">
        <option value="">选择已命名会话</option>
        <option v-for="saved in savedSessions" :key="saved.sessionId" :value="saved.sessionId">
          {{ saved.name || saved.firstMessage || saved.sessionId }}
        </option>
      </select>
    </label>
    </details>
    <details v-if="lessonId" class="agent-context"><summary @click="previewContext">本节上下文与缺失资料</summary><template v-if="context"><p>{{ context.sources.length }} 组原文 · {{ context.characters }} 字符</p><p v-for="warning in context.warnings" :key="warning">{{ warning }}</p><p v-for="(source, index) in context.sources" :key="index">{{ source.title }} · {{ source.blocks.length }} 个片段</p></template></details>
    <p v-if="mentions.length" class="agent-context">{{ lessonId ? '引用会加入本节上下文' : '当前为引用文件问答，可读取范围仅限所选文件' }}。更改引用后开启新会话。</p>
    <p v-if="activity" class="agent-activity">{{ activity }}</p>
    <p v-if="error" class="agent-error" role="alert">{{ error }}</p>

    <form class="agent-composer" @submit.prevent="send">
      <div v-if="mentions.length" class="reference-chips"><button v-for="file in mentions" :key="file.assetId" type="button" :disabled="pending" :aria-label="`移除引用 ${file.title}`" @click="mentions = mentions.filter(m => m.assetId !== file.assetId)">@{{ file.title }} ×</button></div>
      <div v-if="trigger" class="composer-picker" role="listbox" :aria-label="trigger.symbol === '@' ? '引用文件' : '选择 Skill'"><button v-for="(choice, index) in choices" :key="choice.id" type="button" role="option" :aria-selected="index === pickerIndex" :class="{ selected: index === pickerIndex }" @click="chooseCommand(choice.id)">{{ choice.label }}</button><p v-if="!choices.length">没有匹配项{{ trigger.symbol === '/' && mentions.length && !lessonId ? '，引用文件模式只支持问答' : '' }}</p></div>
      <textarea ref="composer" v-model="draft" rows="4" maxlength="19000" aria-label="助手消息" placeholder="输入问题，@ 引用文件，/ 选择 Skill" :disabled="pending" @input="inspectComposer" @click="inspectComposer" @keydown="commandKey" />
      <small>输入 @ 选择文件，/ 选择工作流；选择后可补充要求再发送。</small>
      <button class="button primary" type="submit" :disabled="!canSend">{{ pending ? "处理中…" : "发送" }}</button>
    </form>
  </aside>
</template>
