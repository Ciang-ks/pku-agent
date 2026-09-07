<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, reactive, ref } from "vue";
import { ApiClient, ApiError } from "../api";
import type { CourseCandidate, CourseCandidateReview, TreeholeAuthStatus, TreeholeEvidence } from "../types";

const props = defineProps<{ api: ApiClient }>();
const emit = defineEmits<{ back: [] }>();

const candidates = ref<CourseCandidate[]>([]);
const evidence = ref<TreeholeEvidence>();
const evidenceCandidateId = ref("");
const form = reactive({ name: "", teacher: "", aliases: "" });
const loading = ref(false);
const creating = ref(false);
const queryingId = ref("");
const updatingId = ref("");
const error = ref("");
const savingReview = ref(false);
const treeholeAuth = ref<TreeholeAuthStatus>();
const treeholeLoginOpen = ref(false);
const treeholeLogging = ref(false);
const treeholeVerificationRequired = ref(false);
const treeholeCredentials = reactive({ username: "", password: "", verificationCode: "" });
const reviewDraft = reactive({
  teachingClarity: 3,
  contentValue: 3,
  grading: 3,
  workload: 3,
  predictability: 3,
  overall: 3,
  confidence: "medium" as CourseCandidateReview["confidence"],
  summary: "",
  positives: "",
  negatives: "",
  relatedPids: "",
});

const activeCandidates = computed(() => candidates.value.filter((candidate) => candidate.status === "followed"));

async function refresh(): Promise<void> {
  loading.value = true;
  error.value = "";
  try {
    const [nextCandidates, auth] = await Promise.all([
      props.api.listCourseCandidates(),
      props.api.getTreeholeAuthStatus(),
    ]);
    candidates.value = nextCandidates;
    treeholeAuth.value = auth;
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : "无法读取候选课程";
  } finally {
    loading.value = false;
  }
}

async function loginTreehole(): Promise<void> {
  if (!treeholeCredentials.username.trim() || !treeholeCredentials.password || treeholeLogging.value) return;
  treeholeLogging.value = true;
  error.value = "";
  try {
    treeholeAuth.value = await props.api.loginTreehole({
      username: treeholeCredentials.username.trim(),
      password: treeholeCredentials.password,
      ...(treeholeCredentials.verificationCode.trim() ? { verificationCode: treeholeCredentials.verificationCode.trim() } : {}),
    });
    treeholeLoginOpen.value = false;
    treeholeVerificationRequired.value = false;
    treeholeCredentials.username = "";
    treeholeCredentials.password = "";
    treeholeCredentials.verificationCode = "";
  } catch (cause) {
    treeholeVerificationRequired.value = cause instanceof ApiError && cause.code === "TREEHOLE_VERIFICATION_REQUIRED";
    error.value = cause instanceof Error ? cause.message : "树洞登录失败";
  } finally {
    treeholeLogging.value = false;
  }
}

async function create(): Promise<void> {
  if (!form.name.trim() || !form.teacher.trim() || creating.value) return;
  creating.value = true;
  error.value = "";
  try {
    const candidate = await props.api.createCourseCandidate({
      name: form.name.trim(),
      teacher: form.teacher.trim(),
      aliases: form.aliases.split(/[,，]/).map((item) => item.trim()).filter(Boolean),
    });
    candidates.value = [candidate, ...candidates.value];
    form.name = "";
    form.teacher = "";
    form.aliases = "";
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : "无法创建候选课程";
  } finally {
    creating.value = false;
  }
}

async function updateStatus(candidate: CourseCandidate): Promise<void> {
  if (updatingId.value) return;
  updatingId.value = candidate.candidateId;
  error.value = "";
  try {
    const next = candidate.status === "followed" ? "rejected" : "followed";
    const updated = await props.api.updateCourseCandidateStatus(candidate.candidateId, next);
    replaceCandidate(updated);
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : "无法更新候选状态";
  } finally {
    updatingId.value = "";
  }
}

async function collectEvidence(candidate: CourseCandidate): Promise<void> {
  if (queryingId.value) return;
  if (treeholeAuth.value?.authState !== "ready") {
    treeholeLoginOpen.value = true;
    return;
  }
  queryingId.value = candidate.candidateId;
  error.value = "";
  evidence.value = undefined;
  evidenceCandidateId.value = candidate.candidateId;
  try {
    const result = await props.api.reviewCourseCandidate(candidate.candidateId);
    replaceCandidate(result.candidate);
    evidence.value = result.evidence;
    reviewDraft.relatedPids = result.evidence.posts.map((post) => post.pid).join(", ");
  } catch (cause) {
    evidenceCandidateId.value = "";
    error.value = cause instanceof Error ? cause.message : "无法检索实时证据";
  } finally {
    queryingId.value = "";
  }
}

async function saveReview(): Promise<void> {
  if (!evidenceCandidateId.value || savingReview.value || !reviewDraft.summary.trim()) return;
  savingReview.value = true;
  error.value = "";
  const review: Omit<CourseCandidateReview, "reviewedAt"> = {
    teachingClarity: reviewDraft.teachingClarity,
    contentValue: reviewDraft.contentValue,
    grading: reviewDraft.grading,
    workload: reviewDraft.workload,
    predictability: reviewDraft.predictability,
    overall: reviewDraft.overall,
    confidence: reviewDraft.confidence,
    summary: reviewDraft.summary.trim(),
    positives: splitReviewList(reviewDraft.positives),
    negatives: splitReviewList(reviewDraft.negatives),
    relatedPids: splitReviewList(reviewDraft.relatedPids),
  };
  try {
    const candidate = candidates.value.find((item) => item.candidateId === evidenceCandidateId.value);
    if (!candidate) return;
    const result = await props.api.reviewCourseCandidate(candidate.candidateId, undefined, review);
    replaceCandidate(result.candidate);
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : "无法保存课程结论";
  } finally {
    savingReview.value = false;
  }
}

function splitReviewList(value: string): string[] {
  return value.split(/[,，\n]/).map((item) => item.trim()).filter(Boolean);
}

function replaceCandidate(candidate: CourseCandidate): void {
  candidates.value = candidates.value.map((item) => item.candidateId === candidate.candidateId ? candidate : item);
}

onMounted(() => void refresh());
onBeforeUnmount(() => {
  evidence.value = undefined;
  evidenceCandidateId.value = "";
});
</script>

<template>
  <main class="candidate-view">
    <button class="back-link" @click="emit('back')">← 返回课程列表</button>
    <header class="candidate-hero">
      <div>
        <p class="eyebrow">COURSE SELECTION</p>
        <h1>候选课程</h1>
        <p>已关注 {{ activeCandidates.length }} 门</p>
      </div>
      <div class="candidate-auth-summary">
        <span :class="['candidate-status', treeholeAuth?.authState === 'ready' ? 'followed' : 'rejected']">
          {{ treeholeAuth?.authState === 'ready' ? "树洞已连接" : "树洞未连接" }}
        </span>
        <button class="button ghost" type="button" @click="treeholeLoginOpen = !treeholeLoginOpen">
          {{ treeholeAuth?.authState === 'ready' ? "重新认证" : "连接树洞" }}
        </button>
      </div>
    </header>

    <section v-if="treeholeLoginOpen" class="treehole-auth-panel" aria-label="树洞认证">
      <header class="section-header compact">
        <div>
          <p class="eyebrow">TREEHOLE AUTH</p>
          <h2>连接树洞</h2>
        </div>
        <button type="button" class="button secondary" @click="treeholeLoginOpen = false">关闭</button>
      </header>
      <form class="treehole-auth-form" @submit.prevent="loginTreehole">
        <input v-model="treeholeCredentials.username" type="text" autocomplete="username" maxlength="100" required placeholder="学号" aria-label="学号" />
        <input v-model="treeholeCredentials.password" type="password" autocomplete="current-password" maxlength="256" required placeholder="密码" aria-label="密码" />
        <input v-if="treeholeVerificationRequired" v-model="treeholeCredentials.verificationCode" type="text" inputmode="numeric" autocomplete="one-time-code" maxlength="32" required placeholder="手机令牌或短信验证码" aria-label="手机令牌或短信验证码" />
        <button class="button primary" :disabled="treeholeLogging || !treeholeCredentials.username.trim() || !treeholeCredentials.password">
          {{ treeholeLogging ? "认证中…" : treeholeVerificationRequired ? "提交验证码" : "连接" }}
        </button>
      </form>
    </section>

    <section class="candidate-create">
      <header class="section-header compact">
        <div>
          <p class="eyebrow">NEW CANDIDATE</p>
          <h2>添加候选</h2>
        </div>
      </header>
      <form class="candidate-create-form" @submit.prevent="create">
        <input v-model="form.name" maxlength="200" required placeholder="课程名称" aria-label="课程名称" />
        <input v-model="form.teacher" maxlength="100" required placeholder="教师" aria-label="教师" />
        <input v-model="form.aliases" maxlength="300" placeholder="别名，用逗号分隔" aria-label="课程别名" />
        <button class="button primary" :disabled="creating || !form.name.trim() || !form.teacher.trim()">
          {{ creating ? "添加中…" : "添加" }}
        </button>
      </form>
    </section>

    <p v-if="error" class="notice error" role="alert">{{ error }}</p>
    <div v-if="loading" class="loading-state"><span /><span /><span /><p>读取候选课程</p></div>
    <section v-else class="candidate-list" aria-label="候选课程列表">
      <article v-for="candidate in candidates" :key="candidate.candidateId" class="candidate-row">
        <div class="candidate-meta">
          <span class="candidate-status" :class="candidate.status">{{ candidate.status === "followed" ? "关注" : "排除" }}</span>
          <div>
            <h2>{{ candidate.name }}</h2>
            <p>{{ candidate.teacher }}<template v-if="candidate.aliases.length"> · {{ candidate.aliases.join(" · ") }}</template></p>
          </div>
        </div>
        <div v-if="candidate.review" class="candidate-review">
          <strong>{{ candidate.review.overall }} / 5</strong>
          <span>{{ candidate.review.confidence }}</span>
          <p>{{ candidate.review.summary }}</p>
          <small>PID {{ candidate.review.relatedPids.join(" · ") }}</small>
        </div>
        <div class="candidate-actions">
          <button class="button ghost" :disabled="Boolean(queryingId)" @click="collectEvidence(candidate)">
            {{ queryingId === candidate.candidateId ? "检索中…" : "实时证据" }}
          </button>
          <button class="button ghost" :disabled="Boolean(updatingId)" @click="updateStatus(candidate)">
            {{ candidate.status === "followed" ? "排除" : "重新关注" }}
          </button>
        </div>
      </article>
      <div v-if="!candidates.length" class="empty-state compact-empty">
        <h3>尚无候选课程</h3>
      </div>
    </section>

    <section v-if="evidence" class="treehole-evidence" aria-live="polite">
      <header class="section-header compact">
        <div>
          <p class="eyebrow">LIVE EVIDENCE · {{ evidenceCandidateId }}</p>
          <h2>实时证据</h2>
        </div>
        <span>{{ evidence.posts.length }} 条</span>
      </header>
      <ol>
        <li v-for="post in evidence.posts" :key="post.pid">
          <header><code>PID {{ post.pid }}</code><span>{{ post.commentCount }} 条评论</span></header>
          <p>{{ post.text }}</p>
          <ul v-if="post.comments.length">
            <li v-for="comment in post.comments" :key="comment.commentId">{{ comment.text }}</li>
          </ul>
        </li>
      </ol>
      <form class="candidate-review-form" @submit.prevent="saveReview">
        <header class="section-header compact">
          <div>
            <p class="eyebrow">CURATED CONCLUSION</p>
            <h2>保存人工归纳</h2>
          </div>
          <span>原文不会保存</span>
        </header>
        <div class="review-score-grid">
          <label v-for="field in [
            ['teachingClarity', '讲解清晰度'],
            ['contentValue', '内容价值'],
            ['grading', '给分情况'],
            ['workload', '工作量'],
            ['predictability', '考核可预测性'],
            ['overall', '总体评价']
          ]" :key="field[0]">
            <span>{{ field[1] }}</span>
            <input v-model.number="reviewDraft[field[0] as keyof typeof reviewDraft]" type="number" min="1" max="5" required />
          </label>
        </div>
        <div class="review-form-grid">
          <label><span>置信度</span><select v-model="reviewDraft.confidence"><option value="low">低</option><option value="medium">中</option><option value="high">高</option></select></label>
          <label class="review-summary"><span>结论摘要</span><textarea v-model="reviewDraft.summary" rows="3" maxlength="4000" required placeholder="根据刚才的实时证据写下可复核的结论" /></label>
          <label><span>主要正面观点</span><textarea v-model="reviewDraft.positives" rows="2" maxlength="2000" placeholder="用逗号或换行分隔" /></label>
          <label><span>主要负面观点</span><textarea v-model="reviewDraft.negatives" rows="2" maxlength="2000" placeholder="用逗号或换行分隔" /></label>
          <label><span>相关 PID</span><input v-model="reviewDraft.relatedPids" maxlength="2000" placeholder="已从本次证据预填" /></label>
        </div>
        <footer class="dialog-actions"><button class="button primary" :disabled="savingReview || !reviewDraft.summary.trim()">{{ savingReview ? "保存中…" : "保存结论" }}</button></footer>
      </form>
    </section>
  </main>
</template>
