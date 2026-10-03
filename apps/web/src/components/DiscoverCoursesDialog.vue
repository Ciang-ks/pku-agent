<script setup lang="ts">
import { computed, ref, onMounted } from "vue";
import type { ApiClient } from "../api";
import type { CourseWorkspace } from "../types";
const props = defineProps<{ api: ApiClient }>();
const emit = defineEmits<{ close: []; imported: [course: CourseWorkspace] }>();
interface RemoteCourse { title: string; remoteCourseId?: string; courseId?: string }
const courses = ref<RemoteCourse[]>([]); const pending = ref(false); const error = ref(""); const otp = ref("");
const query = ref("");
const availableOnly = ref(false);
const availableCount = computed(() => courses.value.filter(course => course.remoteCourseId).length);
const visibleCourses = computed(() => courses.value.filter(course => (!availableOnly.value || course.remoteCourseId) && course.title.toLowerCase().includes(query.value.trim().toLowerCase())));
async function discover() {
  pending.value = true; error.value = "";
  try { courses.value = await props.api.request("/api/teaching-network/courses/discover", { method: "POST", body: JSON.stringify(otp.value ? { otp: otp.value } : {}) }); otp.value = ""; }
  catch (e) { error.value = e instanceof Error ? e.message : "获取课程失败"; }
  finally { pending.value = false; }
}
async function add(course: RemoteCourse) {
  pending.value = true; error.value = "";
  try {
    const imported = await props.api.request<CourseWorkspace>("/api/teaching-network/courses/import", { method: "POST", body: JSON.stringify({ title: course.title, remoteCourseId: course.remoteCourseId, ...(otp.value ? { otp: otp.value } : {}) }) });
    otp.value = ""; emit("imported", imported);
  } catch (e) { error.value = e instanceof Error ? e.message : "导入失败"; }
  finally { pending.value = false; }
}
onMounted(discover);
</script>
<template>
  <div class="dialog-backdrop" @click.self="emit('close')">
    <section class="dialog discover-dialog" role="dialog" aria-modal="true" aria-labelledby="discover-title">
      <header class="learning-toolbar">
        <h2 id="discover-title">从教学网获取课程</h2>
        <button class="icon-button" @click="emit('close')" aria-label="关闭">×</button>
      </header>
      <p>已读取 {{ courses.length }} 门课程，{{ availableCount }} 门可直接导入。可导入表示已取得课程 ID，资料下载与解析仍需单独验证。</p>
      <p v-if="error" class="notice error" role="alert">{{ error }}</p>
      <form class="learning-actions" @submit.prevent="discover">
        <input v-model="otp" inputmode="numeric" autocomplete="one-time-code" aria-label="手机令牌" placeholder="需要认证时填写手机令牌" />
        <button class="button secondary" :disabled="pending">{{ pending ? '正在连接…' : '刷新课程' }}</button>
      </form>
      <div class="discover-filters">
        <input v-model="query" type="search" aria-label="搜索课程" placeholder="搜索课程名称或学期" />
        <label><input v-model="availableOnly" type="checkbox" />仅显示可导入课程</label>
      </div>
      <div class="discover-course-list" role="region" aria-label="教学网课程列表" tabindex="0">
        <div v-for="(course, index) in visibleCourses" :key="`${course.remoteCourseId}-${index}`" class="material-row">
          <div><strong>{{ course.title }}</strong><small>{{ course.courseId ? '已有工作区' : course.remoteCourseId ? '可导入' : '暂不可导入：教学网内容列表未提供课程 ID' }}</small></div>
          <button class="button primary" :disabled="pending || !course.remoteCourseId" @click="add(course)">{{ course.courseId ? '打开' : '加入' }}</button>
        </div>
        <p v-if="!pending && !visibleCourses.length && !error">{{ courses.length ? '没有符合筛选条件的课程。' : '教学网暂未返回课程。' }}</p>
      </div>
    </section>
  </div>
</template>
