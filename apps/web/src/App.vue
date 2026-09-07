<script setup lang="ts">
import { computed, onMounted, ref } from "vue";
import { ApiClient, ApiError } from "./api";
import CourseWorkspaceView from "./components/CourseWorkspaceView.vue";
import CandidateWorkspaceView from "./components/CandidateWorkspaceView.vue";
import CreateCourseDialog from "./components/CreateCourseDialog.vue";
import DoctorPanel from "./components/DoctorPanel.vue";
import type { CourseTimelineItem, CourseWorkspace, DoctorCheck, JobRecord } from "./types";

const token = ref(localStorage.getItem("pku-study-api-token") ?? "");
const courses = ref<CourseWorkspace[]>([]);
const jobs = ref<JobRecord[]>([]);
const timeline = ref<CourseTimelineItem[]>([]);
const timelineRange = ref<"today" | "week">("week");
const selectedCourse = ref<CourseWorkspace>();
const showCandidates = ref(false);
const loading = ref(false);
const createPending = ref(false);
const createError = ref("");
const connectionError = ref("");
const showToken = ref(!token.value);
const showCreate = ref(false);
const showDoctor = ref(false);
const doctorLoading = ref(false);
const doctorChecks = ref<DoctorCheck[]>([]);
const api = new ApiClient(() => token.value);

const activeJobs = computed(() =>
  jobs.value.filter((job) => !["completed", "failed", "cancelled"].includes(job.status))
);

function saveToken() {
  localStorage.setItem("pku-study-api-token", token.value.trim());
  showToken.value = false;
  void refresh();
}

function openCandidates() {
  selectedCourse.value = undefined;
  showCandidates.value = true;
}

async function refresh() {
  loading.value = true;
  connectionError.value = "";
  try {
    [courses.value, jobs.value, timeline.value] = await Promise.all([api.listCourses(), api.listJobs(), api.listTimeline(20, timelineRange.value)]);
  } catch (error) {
    if (error instanceof ApiError && error.status === 401) {
      connectionError.value = "API 令牌无效，请从 `pku-study token` 读取后重新填写。";
      showToken.value = true;
    } else {
      connectionError.value = error instanceof Error ? error.message : "无法连接本地服务";
    }
  } finally {
    loading.value = false;
  }
}

async function createCourse(input: {
  name: string;
  term: string;
  teacher: string;
  remoteCourseId?: string;
}) {
  createPending.value = true;
  createError.value = "";
  try {
    const course = await api.createCourse(input);
    courses.value = [course, ...courses.value];
    showCreate.value = false;
    selectedCourse.value = course;
  } catch (error) {
    createError.value = error instanceof Error ? error.message : "创建课程失败";
  } finally {
    createPending.value = false;
  }
}

async function runDoctor() {
  doctorLoading.value = true;
  try {
    doctorChecks.value = await api.runDoctor();
  } catch (error) {
    connectionError.value = error instanceof Error ? error.message : "诊断失败";
  } finally {
    doctorLoading.value = false;
  }
}

function timelineText(entry: CourseTimelineItem): string {
  if (entry.resource) return entry.resource.isImported ? "资料已导入" : "新资料";
  const item = entry.item;
  if (!item) return "已同步";
  if (item.kind === "assignment") return item.completed ? "作业已完成" : item.dueText || "作业待处理";
  if (item.kind === "grade") return item.score === undefined ? "成绩已同步" : `成绩 ${item.score}${item.possibleScore ? ` / ${item.possibleScore}` : ""}`;
  if (item.kind === "video") return "录播已同步";
  return item.attachmentCount ? `公告 · ${item.attachmentCount} 个附件` : "公告已同步";
}

onMounted(() => {
  if (token.value) void refresh();
});
</script>

<template>
  <div class="app-shell">
    <header class="topbar">
      <button class="brand" aria-label="返回首页" @click="selectedCourse = undefined; showCandidates = false">
        <span class="brand-sigil">北</span>
        <span>
          <strong>PKU STUDY</strong>
          <small>LOCAL LEARNING SYSTEM</small>
        </span>
      </button>
      <nav>
        <button class="nav-button" @click="openCandidates">候选课程</button>
        <button class="nav-button" @click="showDoctor = true">环境诊断</button>
        <button class="nav-button" @click="showToken = true">连接设置</button>
        <span class="job-indicator" :class="{ active: activeJobs.length }">
          {{ activeJobs.length ? `${activeJobs.length} 项运行中` : "系统就绪" }}
        </span>
      </nav>
    </header>

    <CourseWorkspaceView
      v-if="selectedCourse"
      :course="selectedCourse"
      :api="api"
      @back="selectedCourse = undefined"
    />

    <CandidateWorkspaceView v-else-if="showCandidates" :api="api" @back="showCandidates = false" />

    <main v-else class="dashboard">
      <section class="intro">
        <div>
          <p class="eyebrow">COURSE-CENTRIC · LOCAL-FIRST · AGENT-READY</p>
          <h1>把散落的学习资料，<br /><em>编织成一门课。</em></h1>
        </div>
        <p class="intro-copy">
          围绕课程收纳课件、录播、转写、讲义与作业。所有写操作都可追踪，提交永远经过你的确认。
        </p>
      </section>

      <section class="course-section">
        <header class="section-header">
          <div>
            <p class="eyebrow">YOUR COURSES</p>
            <h2>课程工作区</h2>
          </div>
          <button class="button primary" @click="showCreate = true">＋ 新建课程</button>
        </header>

        <p v-if="connectionError" class="notice error" role="alert">
          {{ connectionError }}
        </p>

        <div v-if="loading" class="loading-state">
          <span /> <span /> <span />
          <p>正在读取本地课程索引</p>
        </div>

        <div v-else-if="courses.length" class="course-list">
          <button
            v-for="(course, index) in courses"
            :key="course.courseId"
            class="course-row"
            @click="selectedCourse = course"
          >
            <span class="course-index">{{ String(index + 1).padStart(2, "0") }}</span>
            <span class="course-main">
              <strong>{{ course.name }}</strong>
              <small>{{ course.teacher }} · {{ course.term }}</small>
            </span>
            <span class="course-state">本地工作区</span>
            <span class="course-arrow">↗</span>
          </button>
        </div>

        <div v-else class="empty-state">
          <div class="empty-orbit"><span>课</span></div>
          <h3>从第一门课程开始</h3>
          <p>创建工作区后，平台会生成标准目录、课程清单和可定制提示词。</p>
          <button class="text-button" @click="showCreate = true">建立课程工作区 →</button>
        </div>
      </section>

      <section class="timeline-section">
        <header class="section-header">
          <div>
            <p class="eyebrow">RECENT ACTIVITY</p>
            <h2>跨课程时间线</h2>
          </div>
          <div class="timeline-range" role="group" aria-label="时间范围">
            <button type="button" :class="{ active: timelineRange === 'today' }" @click="timelineRange = 'today'; void refresh()">今日</button>
            <button type="button" :class="{ active: timelineRange === 'week' }" @click="timelineRange = 'week'; void refresh()">本周</button>
          </div>
        </header>
        <ol v-if="timeline.length" class="timeline-list">
          <li v-for="entry in timeline" :key="`${entry.courseId}-${entry.item?.itemId || entry.resource?.resourceId}`">
            <time>{{ new Date(entry.sortAt).toLocaleDateString() }}</time>
            <div>
              <strong>{{ entry.courseName }}</strong>
              <span>{{ entry.item?.title || entry.resource?.title }}</span>
            </div>
            <small>{{ timelineText(entry) }}</small>
          </li>
        </ol>
        <p v-else class="timeline-empty muted">当前范围没有已同步动态</p>
      </section>

      <footer class="principles">
        <span>01 · 文件即真相</span>
        <span>02 · 证据可追溯</span>
        <span>03 · 人工确认提交</span>
      </footer>
    </main>

    <CreateCourseDialog
      v-if="showCreate"
      :pending="createPending"
      :error="createError"
      @close="showCreate = false"
      @create="createCourse"
    />

    <div v-if="showToken" class="dialog-backdrop" @click.self="showToken = false">
      <section class="dialog token-dialog" role="dialog" aria-modal="true">
        <header class="dialog-header">
          <div>
            <p class="eyebrow">LOCAL API</p>
            <h2>连接本地服务</h2>
          </div>
          <button class="icon-button" aria-label="关闭" @click="showToken = false">×</button>
        </header>
        <form @submit.prevent="saveToken">
          <label>
            <span>API 令牌</span>
            <input v-model="token" type="password" autocomplete="off" placeholder="粘贴 pku-study token 的输出" />
            <small>令牌仅保存在当前浏览器的 localStorage 中。</small>
          </label>
          <footer class="dialog-actions">
            <button class="button primary" type="submit" :disabled="!token.trim()">保存并连接</button>
          </footer>
        </form>
      </section>
    </div>

    <div v-if="showDoctor" class="panel-backdrop" @click.self="showDoctor = false">
      <DoctorPanel
        :checks="doctorChecks"
        :loading="doctorLoading"
        @run="runDoctor"
        @close="showDoctor = false"
      />
    </div>
  </div>
</template>
