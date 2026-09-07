import type {
  CourseWorkspace,
  DoctorCheck,
  IntegrationState,
  JobRecord,
  RemoteContentNode,
  RemoteResource,
  CourseDocumentBlock,
  DocumentSearchResult,
  CourseNoteSource,
  TeachingItem,
  TeachingItemKind,
  AgentSessionInfo,
  AgentSessionSummary,
  AgentStreamEvent,
  CourseCandidate,
  CourseCandidateReview,
  CandidateStatus,
  TreeholeEvidence,
  TreeholeAuthStatus,
  AssignmentApproval,
  PracticeSet,
  PracticeSetSummary,
  TeachingNetworkAnnouncementDetail,
  CourseTimelineItem,
} from "./types";

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code?: string,
  ) {
    super(message);
  }
}

export class ApiClient {
  constructor(private readonly getToken: () => string) {}

  private async request<T>(path: string, init: RequestInit = {}): Promise<T> {
    const token = this.getToken().trim();
    const response = await fetch(path, {
      ...init,
      headers: {
        ...(init.body ? { "content-type": "application/json" } : {}),
        ...(token ? { authorization: `Bearer ${token}` } : {}),
        ...init.headers
      }
    });

    const payload = (await response.json().catch(() => undefined)) as
      | { ok: true; data: T }
      | { ok: false; error: { message: string; code?: string } }
      | undefined;
    if (!response.ok) {
      throw new ApiError(
        payload && !payload.ok ? payload.error.message : `请求失败 (${response.status})`,
        response.status,
        payload && !payload.ok ? payload.error.code : undefined,
      );
    }
    if (!payload || !payload.ok) throw new ApiError("本地服务返回了无效响应", response.status);
    return payload.data;
  }

  listCourses(): Promise<CourseWorkspace[]> {
    return this.request("/api/courses");
  }

  listTimeline(limit = 20, range: "today" | "week" | "all" = "week"): Promise<CourseTimelineItem[]> {
    return this.request(`/api/timeline?limit=${encodeURIComponent(String(limit))}&range=${range}`);
  }

  createCourse(input: {
    name: string;
    term: string;
    teacher: string;
    remoteCourseId?: string;
  }): Promise<CourseWorkspace> {
    return this.request("/api/courses", {
      method: "POST",
      body: JSON.stringify(input)
    });
  }

  listCourseCandidates(): Promise<CourseCandidate[]> {
    return this.request("/api/candidates");
  }

  getTreeholeAuthStatus(): Promise<TreeholeAuthStatus> {
    return this.request("/api/auth/treehole/status");
  }

  loginTreehole(input: { username: string; password: string; verificationCode?: string }): Promise<TreeholeAuthStatus> {
    return this.request("/api/auth/treehole/login", {
      method: "POST",
      body: JSON.stringify(input),
    });
  }

  createCourseCandidate(input: { name: string; teacher: string; aliases?: string[] }): Promise<CourseCandidate> {
    return this.request("/api/candidates", {
      method: "POST",
      body: JSON.stringify(input),
    });
  }

  updateCourseCandidateStatus(candidateId: string, status: CandidateStatus): Promise<CourseCandidate> {
    return this.request(`/api/candidates/${encodeURIComponent(candidateId)}`, {
      method: "PATCH",
      body: JSON.stringify({ status }),
    });
  }

  reviewCourseCandidate(
    candidateId: string,
    keywords?: string[],
    review?: Omit<CourseCandidateReview, "reviewedAt">,
  ): Promise<{ candidate: CourseCandidate; evidence: TreeholeEvidence }> {
    return this.request(`/api/candidates/${encodeURIComponent(candidateId)}/review`, {
      method: "POST",
      body: JSON.stringify({
        ...(keywords?.length ? { keywords } : {}),
        ...(review ? { review } : {}),
      }),
    });
  }

  listJobs(): Promise<JobRecord[]> {
    return this.request("/api/jobs");
  }

  getPku3bStatus(): Promise<IntegrationState> {
    return this.request("/api/integrations/pku3b/status");
  }

  listCourseOverview(courseId: string, kind?: TeachingItemKind): Promise<TeachingItem[]> {
    const suffix = kind ? `?kind=${encodeURIComponent(kind)}` : "";
    return this.request(`/api/courses/${encodeURIComponent(courseId)}/overview${suffix}`);
  }

  syncCourseOverview(
    courseId: string,
    input: { force?: boolean; otp?: string } = {},
  ): Promise<JobRecord> {
    return this.request(`/api/courses/${encodeURIComponent(courseId)}/overview/sync`, {
      method: "POST",
      body: JSON.stringify(input),
    });
  }

  transcribeRecording(
    courseId: string,
    recordingId: string,
    otp?: string,
  ): Promise<JobRecord> {
    return this.request(
      `/api/courses/${encodeURIComponent(courseId)}/recordings/${encodeURIComponent(recordingId)}/transcribe`,
      { method: "POST", body: JSON.stringify(otp ? { otp } : {}) },
    );
  }

  downloadAssignment(courseId: string, assignmentId: string, otp?: string): Promise<JobRecord> {
    return this.request(`/api/courses/${encodeURIComponent(courseId)}/assignments/${encodeURIComponent(assignmentId)}/download`, {
      method: "POST",
      body: JSON.stringify(otp ? { otp } : {}),
    });
  }

  showAnnouncement(courseId: string, announcementId: string, otp?: string): Promise<TeachingNetworkAnnouncementDetail> {
    return this.request(`/api/courses/${encodeURIComponent(courseId)}/announcements/${encodeURIComponent(announcementId)}/show`, {
      method: "POST",
      body: JSON.stringify(otp ? { otp } : {}),
    });
  }

  exportAssignment(courseId: string, assignmentId: string): Promise<{ assignmentId: string; sourcePath: string }> {
    return this.request(`/api/courses/${encodeURIComponent(courseId)}/assignments/${encodeURIComponent(assignmentId)}/export`, {
      method: "POST",
    });
  }

  approveAssignment(courseId: string, assignmentId: string): Promise<AssignmentApproval> {
    return this.request(`/api/courses/${encodeURIComponent(courseId)}/assignments/${encodeURIComponent(assignmentId)}/approve`, {
      method: "POST",
      body: JSON.stringify({}),
    });
  }

  submitAssignment(courseId: string, assignmentId: string, approvalId: string, otp?: string): Promise<JobRecord> {
    return this.request(`/api/courses/${encodeURIComponent(courseId)}/assignments/${encodeURIComponent(assignmentId)}/submit`, {
      method: "POST",
      body: JSON.stringify({ approvalId, ...(otp ? { otp } : {}) }),
    });
  }

  listPracticeSets(courseId: string): Promise<PracticeSetSummary[]> {
    return this.request(`/api/courses/${encodeURIComponent(courseId)}/practice`);
  }

  getPracticeSet(courseId: string, name: string): Promise<PracticeSet> {
    return this.request(`/api/courses/${encodeURIComponent(courseId)}/practice/${encodeURIComponent(name)}`);
  }

  indexCourseAsset(courseId: string, path: string): Promise<CourseDocumentBlock[]> {
    return this.request(`/api/courses/${encodeURIComponent(courseId)}/documents/index`, {
      method: "POST",
      body: JSON.stringify({ path })
    });
  }

  rebuildCourseIndex(courseId: string): Promise<{ assetCount: number; blockCount: number }> {
    return this.request(`/api/courses/${encodeURIComponent(courseId)}/documents/rebuild`, {
      method: "POST",
      body: JSON.stringify({})
    });
  }

  searchCourseDocuments(courseId: string, query: string, limit = 10): Promise<DocumentSearchResult[]> {
    const params = new URLSearchParams({ query, limit: String(limit) });
    return this.request(`/api/courses/${encodeURIComponent(courseId)}/documents/search?${params}`);
  }

  listCourseNoteSources(courseId: string): Promise<CourseNoteSource[]> {
    return this.request(`/api/courses/${encodeURIComponent(courseId)}/note-sources`);
  }

  listRemoteResources(courseId: string): Promise<{
    resources: RemoteResource[];
    tree: RemoteContentNode[];
  }> {
    return this.request(`/api/courses/${encodeURIComponent(courseId)}/remote-resources`);
  }

  syncRemoteResources(
    courseId: string,
    input: { force?: boolean; otp?: string } = {}
  ): Promise<JobRecord> {
    return this.request(`/api/courses/${encodeURIComponent(courseId)}/remote-resources/sync`, {
      method: "POST",
      body: JSON.stringify(input)
    });
  }

  importRemoteResource(
    courseId: string,
    resourceId: string,
    otp?: string
  ): Promise<JobRecord> {
    return this.request(
      `/api/courses/${encodeURIComponent(courseId)}/remote-resources/${encodeURIComponent(resourceId)}/import`,
      { method: "POST", body: JSON.stringify(otp ? { otp } : {}) }
    );
  }

  getJob(jobId: string): Promise<JobRecord> {
    return this.request(`/api/jobs/${encodeURIComponent(jobId)}`);
  }

  resumeJobAuth(jobId: string, otp: string): Promise<JobRecord> {
    return this.request(`/api/jobs/${encodeURIComponent(jobId)}/resume-auth`, {
      method: "POST",
      body: JSON.stringify({ otp })
    });
  }

  createCourseAgentSession(courseId: string, name?: string): Promise<AgentSessionInfo> {
    return this.request(`/api/courses/${encodeURIComponent(courseId)}/sessions`, {
      method: "POST",
      ...(name?.trim() ? { body: JSON.stringify({ name: name.trim() }) } : {}),
    });
  }

  createLectureNotesSession(courseId: string, sourcePaths: string[]): Promise<AgentSessionInfo> {
    return this.request(`/api/courses/${encodeURIComponent(courseId)}/lecture-notes/session`, {
      method: "POST",
      body: JSON.stringify({ sourcePaths }),
    });
  }

  listCourseAgentSessions(courseId: string): Promise<AgentSessionSummary[]> {
    return this.request(`/api/courses/${encodeURIComponent(courseId)}/sessions`);
  }

  resumeCourseAgentSession(courseId: string, sessionId: string): Promise<AgentSessionInfo> {
    return this.request(
      `/api/courses/${encodeURIComponent(courseId)}/sessions/${encodeURIComponent(sessionId)}/resume`,
      { method: "POST" },
    );
  }

  async closeAgentSession(sessionId: string): Promise<void> {
    const token = this.getToken().trim();
    const response = await fetch(`/api/sessions/${encodeURIComponent(sessionId)}`, {
      method: "DELETE",
      headers: token ? { authorization: `Bearer ${token}` } : {},
    });
    if (!response.ok && response.status !== 404) {
      const payload = await response.json().catch(() => undefined) as { error?: { message?: string } } | undefined;
      throw new ApiError(payload?.error?.message ?? `请求失败 (${response.status})`, response.status);
    }
  }

  async streamAgentMessage(
    sessionId: string,
    message: string,
    onEvent: (event: AgentStreamEvent) => void,
  ): Promise<void> {
    const token = this.getToken().trim();
    const response = await fetch(`/api/sessions/${encodeURIComponent(sessionId)}/messages`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify({ message }),
    });
    if (!response.ok) {
      const payload = await response.json().catch(() => undefined) as { error?: { message?: string } } | undefined;
      throw new ApiError(payload?.error?.message ?? `请求失败 (${response.status})`, response.status);
    }
    if (!response.body) throw new ApiError("本地服务未返回流式响应", response.status);

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    const dispatch = (frame: string) => {
      const lines = frame.split("\n");
      const type = lines.find((line) => line.startsWith("event:"))?.slice(6).trim();
      const data = lines
        .filter((line) => line.startsWith("data:"))
        .map((line) => line.slice(5).trim())
        .join("\n");
      if (!type || !data) return;
      try {
        onEvent({ type: type as AgentStreamEvent["type"], data: JSON.parse(data) as Record<string, unknown> });
      } catch {
        // Ignore malformed individual SSE frames; the next frame remains usable.
      }
    };

    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      buffer += decoder.decode(chunk.value, { stream: true }).replace(/\r\n/g, "\n");
      let separator = buffer.indexOf("\n\n");
      while (separator >= 0) {
        dispatch(buffer.slice(0, separator));
        buffer = buffer.slice(separator + 2);
        separator = buffer.indexOf("\n\n");
      }
    }
    buffer += decoder.decode();
    if (buffer.trim()) dispatch(buffer);
  }

  async runDoctor(): Promise<DoctorCheck[]> {
    const report = await this.request<{ ok: boolean; checks: DoctorCheck[] }>("/api/doctor");
    return report.checks;
  }
}
