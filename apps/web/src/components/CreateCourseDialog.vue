<script setup lang="ts">
import { reactive, ref } from "vue";

const emit = defineEmits<{
  close: [];
  create: [input: { name: string; term: string; teacher: string; remoteCourseId?: string }];
}>();

defineProps<{ pending: boolean; error: string }>();

const form = reactive({
  name: "",
  term: "2026-2027-1",
  teacher: "",
  remoteCourseId: ""
});
const nameInput = ref<HTMLInputElement>();

function submit() {
  if (!form.name.trim() || !form.teacher.trim() || !form.term.trim()) return;
  emit("create", {
    name: form.name.trim(),
    term: form.term.trim(),
    teacher: form.teacher.trim(),
    ...(form.remoteCourseId.trim() ? { remoteCourseId: form.remoteCourseId.trim() } : {})
  });
}
</script>

<template>
  <div class="dialog-backdrop" @click.self="emit('close')">
    <section class="dialog" role="dialog" aria-modal="true" aria-labelledby="new-course-title">
      <header class="dialog-header">
        <div>
          <p class="eyebrow">COURSE WORKSPACE</p>
          <h2 id="new-course-title">新建课程</h2>
        </div>
        <button class="icon-button" aria-label="关闭" @click="emit('close')">×</button>
      </header>

      <form @submit.prevent="submit">
        <label>
          <span>课程名称</span>
          <input ref="nameInput" v-model="form.name" autofocus required placeholder="例如：计算机网络" />
        </label>
        <div class="field-row">
          <label>
            <span>学期</span>
            <input v-model="form.term" required placeholder="2026-2027-1" />
          </label>
          <label>
            <span>教师</span>
            <input v-model="form.teacher" required placeholder="教师姓名" />
          </label>
        </div>
        <label>
          <span>教学网课程 ID（可选）</span>
          <input v-model="form.remoteCourseId" placeholder="例如：_12345_1" />
          <small>用于稍后与 pku3b 的远端课程资源建立稳定映射。</small>
        </label>

        <p v-if="error" class="form-error" role="alert">{{ error }}</p>

        <footer class="dialog-actions">
          <button class="button ghost" type="button" @click="emit('close')">取消</button>
          <button
            class="button primary"
            type="submit"
            :disabled="pending || !form.name.trim() || !form.teacher.trim()"
          >
            {{ pending ? "正在创建…" : "创建课程" }}
          </button>
        </footer>
      </form>
    </section>
  </div>
</template>
