<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from "vue";
import { ApiClient } from "../api";
import type { AgentSessionInfo, AgentSessionSummary, AgentStreamEvent, CourseWorkspace } from "../types";

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
  autoSend?: boolean;
}>();
const emit = defineEmits<{ close: [] }>();

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

const skillCommands = [
  { name: "course-sync", label: "同步资料" },
  { name: "lecture-notes", label: "整理笔记" },
  { name: "assignment-solver", label: "作业草稿" },
  { name: "practice-generator", label: "生成自测" },
] as const;

const canSend = computed(() => Boolean(draft.value.trim()) && !pending.value);

async function ensureSession(): Promise<AgentSessionInfo> {
  if (session.value) return session.value;
  if (props.mode === "lecture-notes") {
    session.value = await props.api.createLectureNotesSession(props.course.courseId, props.noteSourcePaths ?? []);
    return session.value;
  }
  session.value = await props.api.createCourseAgentSession(
    props.course.courseId,
    sessionName.value.trim() || undefined,
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
  error.value = "";
  try {
    const restored = await props.api.resumeCourseAgentSession(props.course.courseId, sessionId);
    session.value = restored;
    sessionName.value = restored.name ?? "";
    messages.value = restored.messages.map((message) => ({ id: nextMessageId++, ...message }));
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : "无法恢复课程对话";
    selectedSessionId.value = "";
  }
}

async function send(): Promise<void> {
  const text = draft.value.trim();
  if (!text || pending.value) return;
  draft.value = "";
  error.value = "";
  activity.value = "";
  messages.value.push({ id: nextMessageId++, role: "user", text });
  const assistant = { id: nextMessageId++, role: "assistant" as const, text: "" };
  messages.value.push(assistant);
  pending.value = true;
  try {
    const activeSession = await ensureSession();
    await props.api.streamAgentMessage(activeSession.sessionId, text, (event) => handleEvent(event, assistant));
    if (!assistant.text) assistant.text = "未返回可显示的回答。";
  } catch (cause) {
    messages.value = messages.value.filter((message) => message.id !== assistant.id);
    error.value = cause instanceof Error ? cause.message : "课程助手暂时不可用";
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

function runSkill(name: (typeof skillCommands)[number]["name"]): void {
  if (pending.value) return;
  draft.value = `/skill:${name}`;
  void send();
}

async function close(): Promise<void> {
  const sessionId = session.value?.sessionId;
  if (sessionId) {
    try {
      await props.api.closeAgentSession(sessionId);
    } catch {
      // The local service may already have been restarted; no further action is needed.
    }
  }
  emit("close");
}

onBeforeUnmount(() => {
  const sessionId = session.value?.sessionId;
  if (sessionId) void props.api.closeAgentSession(sessionId).catch(() => undefined);
});

onMounted(() => {
  if (props.initialPrompt?.trim()) {
    draft.value = props.initialPrompt.trim();
    if (props.autoSend) void send();
  }
  void loadSavedSessions();
});
</script>

<template>
  <aside class="course-agent-panel" aria-label="课程助手">
    <header class="agent-panel-header">
      <div>
        <p class="eyebrow">COURSE AGENT</p>
        <h2>{{ course.name }}</h2>
      </div>
      <button class="icon-button" aria-label="关闭课程助手" @click="close">×</button>
    </header>

    <div class="agent-messages" aria-live="polite">
      <p v-if="!messages.length" class="agent-empty">输入问题开始课程对话</p>
      <article v-for="message in messages" :key="message.id" class="agent-message" :class="message.role">
        <span>{{ message.role === "user" ? "你" : "助手" }}</span>
        <p>{{ message.text }}</p>
      </article>
    </div>

    <label v-if="mode !== 'lecture-notes'" class="agent-session-name">
      <span>会话名称</span>
      <input v-model="sessionName" :disabled="Boolean(session) || pending" maxlength="100" placeholder="可选，留空使用内存会话" />
    </label>
    <label v-if="mode !== 'lecture-notes' && savedSessions.length && !session" class="agent-session-name">
      <span>恢复会话</span>
      <select v-model="selectedSessionId" :disabled="pending" @change="resumeSelectedSession">
        <option value="">选择已命名会话</option>
        <option v-for="saved in savedSessions" :key="saved.sessionId" :value="saved.sessionId">
          {{ saved.name || saved.firstMessage || saved.sessionId }}
        </option>
      </select>
    </label>
    <div v-if="mode !== 'lecture-notes'" class="agent-skills" aria-label="课程工作流">
      <button
        v-for="skill in skillCommands"
        :key="skill.name"
        type="button"
        class="agent-skill"
        :disabled="pending"
        @click="runSkill(skill.name)"
      >
        {{ skill.label }}
      </button>
    </div>
    <p v-if="activity" class="agent-activity">{{ activity }}</p>
    <p v-if="error" class="agent-error" role="alert">{{ error }}</p>

    <form class="agent-composer" @submit.prevent="send">
      <textarea v-model="draft" rows="4" maxlength="20000" placeholder="询问本课程资料、资源或任务" :disabled="pending" />
      <button class="button primary" type="submit" :disabled="!canSend">{{ pending ? "处理中…" : "发送" }}</button>
    </form>
  </aside>
</template>
