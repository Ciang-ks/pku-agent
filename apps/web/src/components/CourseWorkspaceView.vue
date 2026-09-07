<script setup lang="ts">
import { onMounted, ref } from "vue";
import { ApiClient } from "../api";
import type {
  CourseWorkspace,
  IntegrationState,
  JobRecord,
  DocumentSearchResult,
  RemoteContentNode,
  TeachingItem,
  TeachingItemKind,
  PracticeSet,
  PracticeSetSummary,
  CourseNoteSource,
  TeachingNetworkAnnouncementDetail,
} from "../types";
import RemoteResourceTree from "./RemoteResourceTree.vue";
import CourseAgentPanel from "./CourseAgentPanel.vue";

const props = defineProps<{ course: CourseWorkspace; api: ApiClient }>();
defineEmits<{ back: [] }>();

const tab = ref<"overview" | "resources" | "recordings" | "practice" | "notes">("overview");
const resources = ref<RemoteContentNode[]>([]);
const overview = ref<TeachingItem[]>([]);
const integration = ref<IntegrationState>();
const activeJob = ref<JobRecord>();
const busyResourceId = ref("");
const loading = ref(false);
const error = ref("");
const showOtp = ref(false);
const otp = ref("");
const documentQuery = ref("");
const documentResults = ref<DocumentSearchResult[]>([]);
const documentLoading = ref(false);
const documentMessage = ref("");
const documentError = ref("");
const showAgent = ref(false);
const agentPrompt = ref("");
const agentMode = ref<"course" | "lecture-notes">("course");
const agentNoteSources = ref<string[]>([]);
const assignmentApprovals = ref<Record<string, string>>({});
const assignmentMessage = ref("");
const announcementDetail = ref<TeachingNetworkAnnouncementDetail>();
const announcementMessage = ref("");
const practiceSets = ref<PracticeSetSummary[]>([]);
const activePractice = ref<PracticeSet>();
const practiceLoading = ref(false);
const practiceError = ref("");
const showPracticeAnswers = ref(false);
const noteSources = ref<CourseNoteSource[]>([]);
const selectedNoteSources = ref<string[]>([]);
const noteLoading = ref(false);
const noteError = ref("");

const modules = [
  { key: "resources", title: "课堂资料", meta: "教学网资源树与本地资产", mark: "01", ready: true },
  { key: "recordings", title: "录播与转写", meta: "视频、音频与逐字稿", mark: "02", ready: true },
  { key: "practice", title: "自测练习", meta: "题目与答案分离阅读", mark: "03", ready: true },
  { key: "notes", title: "讲义生成", meta: "确认课件与录播稿素材", mark: "04", ready: true },
  { key: "assignments", title: "作业工作台", meta: "草稿、检查与人工提交", mark: "05" },
  { key: "reviews", title: "选课风评", meta: "树洞证据与维度评分", mark: "06" },
  { key: "qa", title: "课程问答", meta: "资料与树洞双语境检索", mark: "07" }
];

async function loadResources() {
  loading.value = true;
  error.value = "";
  try {
    const [remote, status] = await Promise.all([
      props.api.listRemoteResources(props.course.courseId),
      props.api.getPku3bStatus()
    ]);
    resources.value = remote.tree;
    integration.value = status;
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : "读取教学网资料失败";
  } finally {
    loading.value = false;
  }
}

async function loadOverview() {
  try {
    overview.value = await props.api.listCourseOverview(props.course.courseId);
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : "读取课程概览失败";
  }
}

async function searchDocuments() {
  const query = documentQuery.value.trim();
  if (!query) {
    documentResults.value = [];
    documentMessage.value = "输入关键词检索已导入的课程文本";
    return;
  }
  documentLoading.value = true;
  documentError.value = "";
  documentMessage.value = "正在检索课程资料";
  try {
    documentResults.value = await props.api.searchCourseDocuments(props.course.courseId, query);
    documentMessage.value = documentResults.value.length ? "" : "没有找到匹配内容";
  } catch (cause) {
    documentError.value = cause instanceof Error ? cause.message : "课程资料检索失败";
    documentResults.value = [];
  } finally {
    documentLoading.value = false;
  }
}

async function rebuildDocuments() {
  documentLoading.value = true;
  documentError.value = "";
  documentMessage.value = "正在重建课程资料索引";
  try {
    const result = await props.api.rebuildCourseIndex(props.course.courseId);
    documentMessage.value = `已索引 ${result.assetCount} 份资料，共 ${result.blockCount} 个文本块`;
    if (documentQuery.value.trim()) await searchDocuments();
  } catch (cause) {
    documentError.value = cause instanceof Error ? cause.message : "重建索引失败";
  } finally {
    documentLoading.value = false;
  }
}

async function openResources() {
  tab.value = "resources";
  await loadResources();
}

async function openRecordings() {
  tab.value = "recordings";
  await loadOverview();
}

async function loadPractice() {
  practiceLoading.value = true;
  practiceError.value = "";
  try {
    practiceSets.value = await props.api.listPracticeSets(props.course.courseId);
  } catch (cause) {
    practiceError.value = cause instanceof Error ? cause.message : "读取自测练习失败";
  } finally {
    practiceLoading.value = false;
  }
}

async function openPractice() {
  tab.value = "practice";
  activePractice.value = undefined;
  showPracticeAnswers.value = false;
  await loadPractice();
}

async function loadNoteSources() {
  noteLoading.value = true;
  noteError.value = "";
  try {
    noteSources.value = await props.api.listCourseNoteSources(props.course.courseId);
  } catch (cause) {
    noteError.value = cause instanceof Error ? cause.message : "读取笔记素材失败";
  } finally {
    noteLoading.value = false;
  }
}

async function openNotes() {
  tab.value = "notes";
  selectedNoteSources.value = [];
  await loadNoteSources();
}

function openNoteAgent() {
  const paths = selectedNoteSources.value;
  if (!paths.length) return;
  agentPrompt.value = [
    "/skill:lecture-notes",
    "请只使用以下已确认的已索引素材生成课堂笔记；不要检索或引用其他课程文件：",
    ...paths.map((path) => `- ${path}`),
    "完成后按 Skill 要求保存笔记，并返回保存路径。",
  ].join("\n");
  agentMode.value = "lecture-notes";
  agentNoteSources.value = paths;
  showAgent.value = true;
}

function openCourseAgent() {
  agentMode.value = "course";
  agentPrompt.value = "";
  agentNoteSources.value = [];
  showAgent.value = true;
}

async function selectPractice(name: string) {
  practiceLoading.value = true;
  practiceError.value = "";
  showPracticeAnswers.value = false;
  try {
    activePractice.value = await props.api.getPracticeSet(props.course.courseId, name);
  } catch (cause) {
    practiceError.value = cause instanceof Error ? cause.message : "读取练习内容失败";
  } finally {
    practiceLoading.value = false;
  }
}

async function sync(force = false, otpCode?: string) {
  error.value = "";
  try {
    activeJob.value = await props.api.syncRemoteResources(props.course.courseId, {
      force,
      ...(otpCode ? { otp: otpCode } : {})
    });
    await followJob(activeJob.value.jobId);
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : "同步失败";
  }
}

async function syncOverview(force = true, otpCode?: string) {
  error.value = "";
  try {
    activeJob.value = await props.api.syncCourseOverview(props.course.courseId, {
      force,
      ...(otpCode ? { otp: otpCode } : {})
    });
    await followJob(activeJob.value.jobId, "overview");
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : "同步课程概览失败";
  }
}

async function importResource(resource: RemoteContentNode) {
  busyResourceId.value = resource.resourceId;
  error.value = "";
  try {
    activeJob.value = await props.api.importRemoteResource(
      props.course.courseId,
      resource.resourceId
    );
    await followJob(activeJob.value.jobId);
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : "导入失败";
  } finally {
    busyResourceId.value = "";
  }
}

async function transcribeRecording(recording: TeachingItem) {
  error.value = "";
  try {
    activeJob.value = await props.api.transcribeRecording(props.course.courseId, recording.remoteId);
    await followJob(activeJob.value.jobId, "recordings");
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : "录播转写失败";
  }
}

async function exportAssignment(assignment: TeachingItem) {
  assignmentMessage.value = "正在导出答案 PDF";
  error.value = "";
  try {
    const result = await props.api.exportAssignment(props.course.courseId, assignment.remoteId);
    assignmentMessage.value = `已生成 ${result.sourcePath}`;
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : "答案 PDF 导出失败";
  }
}

async function downloadAssignment(assignment: TeachingItem) {
  assignmentMessage.value = "正在下载作业附件";
  error.value = "";
  try {
    activeJob.value = await props.api.downloadAssignment(props.course.courseId, assignment.remoteId);
    await followJob(activeJob.value.jobId, "overview");
    if (activeJob.value.status === "completed") assignmentMessage.value = activeJob.value.message ?? "作业附件已下载";
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : "作业附件下载失败";
  }
}

async function showAnnouncement(announcement: TeachingItem) {
  announcementMessage.value = "正在读取公告详情";
  error.value = "";
  try {
    announcementDetail.value = await props.api.showAnnouncement(props.course.courseId, announcement.remoteId);
    announcementMessage.value = "";
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : "读取公告详情失败";
  }
}

async function approveAssignment(assignment: TeachingItem) {
  assignmentMessage.value = "正在记录本次审批";
  error.value = "";
  try {
    const approval = await props.api.approveAssignment(props.course.courseId, assignment.remoteId);
    assignmentApprovals.value = { ...assignmentApprovals.value, [assignment.remoteId]: approval.approvalId };
    assignmentMessage.value = `审批有效至 ${new Date(approval.expiresAt).toLocaleTimeString()}`;
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : "作业审批失败";
  }
}

async function submitAssignment(assignment: TeachingItem) {
  const approvalId = assignmentApprovals.value[assignment.remoteId];
  if (!approvalId) return;
  assignmentMessage.value = "正在提交作业";
  error.value = "";
  try {
    activeJob.value = await props.api.submitAssignment(props.course.courseId, assignment.remoteId, approvalId);
    await followJob(activeJob.value.jobId, "overview");
    if (activeJob.value.status === "completed") {
      const next = { ...assignmentApprovals.value };
      delete next[assignment.remoteId];
      assignmentApprovals.value = next;
      assignmentMessage.value = "作业已提交";
    }
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : "作业提交失败";
  }
}

async function followJob(
  jobId: string,
  refreshTab: "resources" | "overview" | "recordings" = activeJob.value?.kind === "pku3b.course-overview.sync" ? "overview" : "resources"
) {
  for (;;) {
    const job = await props.api.getJob(jobId);
    activeJob.value = job;
    if (job.status === "waiting_for_auth") {
      showOtp.value = job.requiresAction === "provide_otp";
      if (!showOtp.value) error.value = job.errorMessage ?? "需要先配置 pku3b";
      return;
    }
    if (["completed", "failed", "cancelled"].includes(job.status)) {
      if (job.status === "failed") error.value = job.errorMessage ?? "教学网任务失败";
      else if (refreshTab === "overview" || refreshTab === "recordings") await loadOverview();
      else await loadResources();
      return;
    }
    await new Promise((resolve) => window.setTimeout(resolve, 450));
  }
}

async function resumeWithOtp() {
  if (!activeJob.value || !otp.value.trim()) return;
  const jobId = activeJob.value.jobId;
  try {
    await props.api.resumeJobAuth(jobId, otp.value.trim());
    otp.value = "";
    showOtp.value = false;
    await followJob(jobId);
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : "恢复认证失败";
  }
}

onMounted(() => void Promise.all([loadResources(), loadOverview()]));

const overviewGroups: { kind: TeachingItemKind; title: string }[] = [
  { kind: "assignment", title: "作业与 DDL" },
  { kind: "announcement", title: "最新公告" },
  { kind: "video", title: "录播" },
  { kind: "grade", title: "成绩" }
];

function itemsOf(kind: TeachingItemKind) {
  return overview.value.filter((item) => item.kind === kind).slice(0, 4);
}

function recordings() {
  return overview.value.filter((item) => item.kind === "video");
}
</script>

<template>
  <main class="workspace-view">
    <button class="back-link" @click="$emit('back')">← 返回课程列表</button>
    <header class="course-hero">
      <div>
        <p class="eyebrow">{{ course.term }} · COURSE</p>
        <h1>{{ course.name }}</h1>
        <p>{{ course.teacher }} · {{ course.remoteCourseId || course.courseId }}</p>
      </div>
      <div class="course-actions">
        <button class="button secondary" @click="openCourseAgent">课程助手</button>
        <span class="phase-tag">{{ course.remoteCourseId ? "PKU3B MAPPED" : "LOCAL ONLY" }}</span>
      </div>
    </header>

    <template v-if="tab === 'overview'">
      <section class="workspace-grid" aria-label="课程功能">
        <button
          v-for="module in modules"
          :key="module.key"
          class="module-card"
          :class="{ ready: module.ready }"
          :disabled="!module.ready"
          @click="module.key === 'resources' ? openResources() : module.key === 'recordings' ? openRecordings() : module.key === 'practice' ? openPractice() : module.key === 'notes' ? openNotes() : undefined"
        >
          <span class="module-mark">{{ module.mark }}</span>
          <span class="module-copy">
            <strong>{{ module.title }}</strong>
            <small>{{ module.meta }}</small>
          </span>
          <span class="coming-soon">{{ module.ready ? "打开 →" : "下一阶段" }}</span>
        </button>
      </section>

      <section class="overview-panel">
        <header class="section-header compact">
          <div>
            <p class="eyebrow">COURSE OVERVIEW</p>
            <h2>最近动态</h2>
          </div>
          <button class="button secondary" :disabled="activeJob?.status === 'running'" @click="syncOverview()">
            {{ activeJob?.kind === "pku3b.course-overview.sync" && activeJob.status === "running" ? "同步中…" : "同步概览" }}
          </button>
        </header>
        <div class="overview-grid">
          <article v-for="group in overviewGroups" :key="group.kind" class="overview-group">
            <h3>{{ group.title }}</h3>
            <ul v-if="itemsOf(group.kind).length">
              <li v-for="item in itemsOf(group.kind)" :key="item.itemId">
                <strong>{{ item.title }}</strong>
                <small>
                  {{ item.kind === "assignment" ? (item.completed ? "已完成" : item.dueText || "未标注 DDL") : item.kind === "grade" ? `${item.score}${item.possibleScore ? ` / ${item.possibleScore}` : ""}` : item.occurredText || "已同步" }}
                </small>
                <div v-if="item.kind === 'assignment' && item.remoteIdStable" class="assignment-actions">
                  <button type="button" class="text-button" @click="downloadAssignment(item)">下载题目</button>
                  <button type="button" class="text-button" @click="exportAssignment(item)">导出 PDF</button>
                  <button type="button" class="text-button" @click="approveAssignment(item)">审批</button>
                  <button
                    v-if="assignmentApprovals[item.remoteId]"
                    type="button"
                    class="text-button danger"
                    @click="submitAssignment(item)"
                  >提交</button>
                </div>
                <div v-if="item.kind === 'announcement' && item.remoteIdStable" class="assignment-actions">
                  <button type="button" class="text-button" @click="showAnnouncement(item)">查看详情</button>
                </div>
              </li>
            </ul>
            <p v-else class="muted">尚无同步记录</p>
          </article>
        </div>
        <p v-if="assignmentMessage" class="document-status">{{ assignmentMessage }}</p>
        <p v-if="announcementMessage" class="document-status">{{ announcementMessage }}</p>
      </section>

      <section v-if="announcementDetail" class="announcement-detail-panel">
        <header class="section-header compact">
          <div>
            <p class="eyebrow">ANNOUNCEMENT DETAIL</p>
            <h2>{{ announcementDetail.title }}</h2>
            <p class="muted">{{ announcementDetail.courseLabel }} · {{ announcementDetail.publishedAt || "未标注发布时间" }}</p>
          </div>
          <button type="button" class="button secondary" @click="announcementDetail = undefined">关闭</button>
        </header>
        <div class="announcement-detail-copy">
          <p v-for="(line, index) in announcementDetail.descriptions" :key="`${announcementDetail.announcementId}-${index}`">{{ line }}</p>
        </div>
        <ul v-if="announcementDetail.attachments.length" class="announcement-attachments">
          <li v-for="attachment in announcementDetail.attachments" :key="attachment">{{ attachment }}</li>
        </ul>
      </section>

      <section class="document-search-panel">
        <header class="section-header compact">
          <div>
            <p class="eyebrow">COURSE SEARCH</p>
            <h2>资料检索</h2>
          </div>
          <button class="button secondary" :disabled="documentLoading" @click="rebuildDocuments">
            {{ documentLoading && !documentQuery.trim() ? "重建中…" : "重建索引" }}
          </button>
        </header>
        <form class="document-search-form" @submit.prevent="searchDocuments">
          <input v-model="documentQuery" type="search" placeholder="搜索概念、定理或关键词" aria-label="搜索课程资料" />
          <button class="button primary" :disabled="documentLoading || !documentQuery.trim()">检索</button>
        </form>
        <p v-if="documentMessage" class="document-status">{{ documentMessage }}</p>
        <p v-if="documentError" class="notice error">{{ documentError }}</p>
        <ol v-if="documentResults.length" class="document-results">
          <li v-for="result in documentResults" :key="result.block.blockId">
            <div class="document-result-meta">
              <span>{{ result.block.sourcePath }}</span>
              <code>{{ result.block.title }}</code>
            </div>
            <p>{{ result.block.text }}</p>
          </li>
        </ol>
      </section>

      <section class="workspace-path">
        <p class="eyebrow">LOCAL WORKSPACE</p>
        <code>{{ course.rootPath }}</code>
        <p>课程资料将以 PDF 与 Markdown 为中心保存在此目录；数据库只记录索引和运行状态。</p>
      </section>
    </template>

    <section v-else-if="tab === 'recordings'" class="recording-section">
      <header class="remote-header">
        <div>
          <button class="section-back" @click="tab = 'overview'">← 课程概览</button>
          <p class="eyebrow">RECORDINGS · TRANSCRIPTION</p>
          <h2>录播与转写</h2>
        </div>
        <button class="button secondary" :disabled="activeJob?.status === 'running'" @click="syncOverview()">
          同步录播清单
        </button>
      </header>

      <p v-if="error" class="notice error">{{ error }}</p>
      <div v-if="activeJob && !['completed', 'failed', 'cancelled'].includes(activeJob.status)" class="job-progress">
        <span :style="{ width: `${Math.max(activeJob.progress * 100, 4)}%` }" />
        <p>{{ activeJob.message }} · {{ Math.round(activeJob.progress * 100) }}%</p>
      </div>

      <ul v-if="recordings().length" class="recording-list">
        <li v-for="recording in recordings()" :key="recording.itemId">
          <div>
            <strong>{{ recording.title }}</strong>
            <small>{{ recording.occurredText || "已同步" }} · {{ recording.remoteIdStable ? "可转写" : "远端 ID 不稳定" }}</small>
          </div>
          <button
            class="button primary"
            :disabled="!recording.remoteIdStable || activeJob?.status === 'running'"
            @click="transcribeRecording(recording)"
          >转写</button>
        </li>
      </ul>
      <div v-else class="resource-empty">
        <span>⇣</span>
        <h3>尚未同步录播清单</h3>
        <p>先同步课程概览；转写时才会下载对应视频，并且任务结束后删除媒体缓存。</p>
      </div>
    </section>

    <section v-else-if="tab === 'practice'" class="practice-section">
      <header class="remote-header">
        <div>
          <button class="section-back" @click="tab = 'overview'">← 课程概览</button>
          <p class="eyebrow">SELF STUDY · PRACTICE</p>
          <h2>自测练习</h2>
        </div>
        <button class="button secondary" :disabled="practiceLoading" @click="loadPractice">刷新列表</button>
      </header>

      <p v-if="practiceError" class="notice error">{{ practiceError }}</p>
      <div v-if="practiceLoading && !practiceSets.length" class="loading-state"><span /><span /><span /><p>读取自测练习</p></div>
      <div v-else-if="practiceSets.length" class="practice-workbench">
        <nav class="practice-list" aria-label="练习集列表">
          <button
            v-for="practice in practiceSets"
            :key="practice.name"
            type="button"
            :class="{ active: activePractice?.name === practice.name }"
            :disabled="practiceLoading"
            @click="selectPractice(practice.name)"
          >
            <strong>{{ practice.name }}</strong>
            <small>{{ new Date(practice.updatedAt).toLocaleString() }}</small>
          </button>
        </nav>
        <article v-if="activePractice" class="practice-reader">
          <header>
            <div>
              <p class="eyebrow">QUESTIONS</p>
              <h3>{{ activePractice.name }}</h3>
            </div>
            <button class="button secondary" @click="showPracticeAnswers = !showPracticeAnswers">
              {{ showPracticeAnswers ? "隐藏答案" : "查看答案" }}
            </button>
          </header>
          <pre>{{ activePractice.questionsMarkdown }}</pre>
          <section v-if="showPracticeAnswers" class="practice-answers">
            <p class="eyebrow">ANSWERS</p>
            <pre>{{ activePractice.answersMarkdown }}</pre>
          </section>
        </article>
        <div v-else class="practice-placeholder">选择一套练习开始阅读题目</div>
      </div>
      <div v-else class="resource-empty">
        <span>?</span>
        <h3>尚无自测练习</h3>
        <p>从课程助手运行“生成自测”后，题目和答案会以独立 Markdown 文件出现在这里。</p>
      </div>
    </section>

    <section v-else-if="tab === 'notes'" class="notes-section">
      <header class="remote-header">
        <div>
          <button class="section-back" @click="tab = 'overview'">← 课程概览</button>
          <p class="eyebrow">LECTURE NOTES · SOURCES</p>
          <h2>笔记素材</h2>
        </div>
        <button class="button secondary" :disabled="noteLoading" @click="loadNoteSources">刷新素材</button>
      </header>
      <p v-if="noteError" class="notice error">{{ noteError }}</p>
      <div v-if="noteLoading" class="loading-state"><span /><span /><span /><p>读取已索引素材</p></div>
      <div v-else-if="noteSources.length" class="note-source-panel">
        <label v-for="source in noteSources" :key="source.sourcePath" class="note-source-row">
          <input v-model="selectedNoteSources" type="checkbox" :value="source.sourcePath" />
          <span class="note-source-copy">
            <strong>{{ source.title }}</strong>
            <small>{{ source.kind === 'material' ? '课件' : '录播转写' }} · {{ source.blockCount }} 个文本块 · {{ source.sourcePath }}</small>
          </span>
        </label>
        <footer class="note-source-footer">
          <span>{{ selectedNoteSources.length }} 份素材已确认</span>
          <button class="button primary" :disabled="!selectedNoteSources.length" @click="openNoteAgent">交给助手生成</button>
        </footer>
      </div>
      <div v-else class="resource-empty">
        <span>∅</span>
        <h3>没有可用的已索引素材</h3>
        <p>先导入课件或完成录播转写，再回到这里选择笔记来源。</p>
      </div>
    </section>

    <section v-else class="remote-section">
      <header class="remote-header">
        <div>
          <button class="section-back" @click="tab = 'overview'">← 课程概览</button>
          <p class="eyebrow">TEACHING NETWORK · PKU3B</p>
          <h2>教学网资源</h2>
        </div>
        <button
          class="button primary"
          :disabled="!course.remoteCourseId || activeJob?.status === 'running'"
          @click="sync(true)"
        >
          {{ activeJob?.status === "running" ? "同步中…" : "同步资料" }}
        </button>
      </header>

      <div class="integration-strip">
        <span class="status-dot" :class="integration?.authState === 'ready' ? 'ok' : 'warning'" />
        <strong>{{ integration?.authState || "checking" }}</strong>
        <span>{{ integration?.detail }}</span>
        <code v-if="integration?.version">v{{ integration.version }}</code>
      </div>

      <p v-if="!course.remoteCourseId" class="notice error">
        本课程还没有教学网课程 ID。新建课程时填写稳定的 Blackboard course ID 后才可同步。
      </p>
      <p v-if="error" class="notice error">{{ error }}</p>

      <div v-if="activeJob && !['completed', 'failed', 'cancelled'].includes(activeJob.status)" class="job-progress">
        <span :style="{ width: `${Math.max(activeJob.progress * 100, 4)}%` }" />
        <p>{{ activeJob.message }} · {{ Math.round(activeJob.progress * 100) }}%</p>
      </div>

      <div v-if="loading" class="loading-state"><span /><span /><span /><p>读取远端资源索引</p></div>
      <RemoteResourceTree
        v-else-if="resources.length"
        :nodes="resources"
        :busy-resource-id="busyResourceId"
        @import="importResource"
      />
      <div v-else class="resource-empty">
        <span>⇣</span>
        <h3>尚未同步教学网资源</h3>
        <p>同步只读取资源元数据；点击单项“导入”后才会下载附件到课程目录。</p>
      </div>
    </section>

    <div v-if="showOtp" class="dialog-backdrop">
      <section class="dialog token-dialog" role="dialog" aria-modal="true">
        <header class="dialog-header">
          <div><p class="eyebrow">IAAA · ONE TIME</p><h2>输入手机令牌</h2></div>
          <button class="icon-button" @click="showOtp = false">×</button>
        </header>
        <form @submit.prevent="resumeWithOtp">
          <label>
            <span>本次 OTP</span>
            <input v-model="otp" inputmode="numeric" pattern="[0-9]{4,12}" autocomplete="one-time-code" />
            <small>只传给当前 pku3b 进程，不写入数据库、课程目录或任务日志。</small>
          </label>
          <footer class="dialog-actions">
            <button class="button primary" :disabled="!otp.trim()">继续任务</button>
          </footer>
        </form>
      </section>
    </div>

    <CourseAgentPanel
      v-if="showAgent"
      :course="course"
      :api="api"
      :initial-prompt="agentPrompt"
      :mode="agentMode"
      :note-source-paths="agentNoteSources"
      :auto-send="agentMode === 'lecture-notes'"
      @close="showAgent = false"
    />
  </main>
</template>
