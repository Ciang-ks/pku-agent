# 以课次和学习文档为中心的代码结构

本轮把“课程资料 → 课次 → 大纲 → 精确选材 → 讲义”实现为共享业务服务。Vue、REST 和 Pi 使用同一套领域规则。既有课程、作业、练习和树洞功能继续保留。

## 模块职责

```text
apps/web/src/components/
  LearningWorkspace.vue       课次列表、大纲、来源、讲义阅读与编辑
  MaterialLibrary.vue         文件上传、用途分类、解析状态与重试
  MarkdownDocument.vue        文档渲染（Vue 节点；原始 HTML 不执行）
  ProtectedImage.vue          带认证读取解析图片，不把令牌放入 URL
  DiscoverCoursesDialog.vue   获取教学网课程并建立工作区
  CourseAgentPanel.vue        Agent 会话和流式输出

apps/server/src/routes/
  learning-routes.ts          课程发现、课次、资料、文档的 HTTP 适配

packages/core/src/
  application.ts              组合服务、Provider 和下载后入库回调
  learning/
    types.ts                  可序列化领域契约（前端仅导入类型）
    schemas.ts                输入校验
    learning-repository.ts    增量 SQLite 表与乐观并发控制
    lesson-service.ts         课次关联、大纲、选材、文档业务规则
  materials/
    material-service.ts       课程资料身份、按内容去重、分类、解析入库
  documents/
    document-service.ts       索引、来源读取和课程范围检索
    parsers/                  Markdown 与 MinerU 云端解析 Provider
    normalized-markdown.ts    规范化文本产物
    ranking.ts                余弦相似度与倒数排名融合
    errors.ts                 文档服务错误类型
  recordings/
    recording-service.ts      远端/上传录播共用转写处理链
    ffmpeg-audio-processor.ts  本地音频提取、切分
    openai-transcription-provider.ts  云端转写
  agent/
    pi-agent-service.ts       会话生命周期、工具范围、旧工具兼容
    learning-tools.ts         学习领域工具，调用上述共享服务
    course-skills.ts          固定 Skills；lesson-learning 编排主流程
  integrations/pku3b/
    course-discovery-service.ts  发现课程、核实远端 ID、避免重复导入
    teaching-network-service.ts 同步、下载、认证任务状态
    pku3b-adapter.ts             外部 pku3b 执行器
    structured-types.ts          独立的课程/资源快照契约（schemaVersion: 1）
    blackboard-reader.ts         直接读取课程目录、栏目、文件夹与附件；按资源下载
    session-http.ts              pku3b Cookie 边界、同域 HTTP、大小及跳转限制
```

## 调用与数据关系

课程拥有资料库；课次绑定远端录播 ID、上传录播资产 ID或已索引转写稿。一份教材/课件可以被多节课引用，课次不复制整本教材。

`lesson-learning` 按以下次序调用领域工具：读取课次 → 必要时同步/解析/转写 → 保存大纲 → 检索并读取具体块 → 保存主题与块的关联 → 读取已选原文 → 保存讲义。提示词负责内容判断，服务负责验证引用和保存条件。课程的 `prompts/notes.md` 会追加到会话提示中。

生成任务中，录播转写和资料解析使用云端 Provider，本地仅处理文件、音频切分和索引。课件下载后通过 composition root 注册的回调进入资料库并解析；解析失败记录在资料状态中，可独立重试。上传先持久化原件，再由前端或 Agent 调用解析接口。

每次修改使用 `revision` 检查旧状态。修改大纲会清空旧选材并把已有讲义标记为待更新；修改选材也会标记讲义待更新。旧版本写入返回 409，保持用户已保存的正文。服务会验证主题、来源课程和块 ID，拒绝跨课引用和失效片段。

`learning_lessons`、`learning_materials` 是新增表，不重建旧数据库。SQLite 保存课次/资料元数据和当前正文；讲义同时写到 `lessons/<lessonId>/lecture.md`，便于外部阅读。现有 `notes/` 文件保持原路径。当前迁移新学习空间时需要同时迁移应用数据库和课程目录；仅复制课程目录还不能恢复大纲与选材元数据。

文档解析保存图片附件，保留表格换行及解析器提供的页码。规范化来源路径参与文本块 ID 计算，首次解析按落盘 Markdown 的相同分段索引，重建后保持身份。正文支持受控图片及 KaTeX 数学排版。

教学网接入采用渐进替换：`Pku3bExecutor.structured` 提供 `listCourses/readCourse/downloadResource`，默认实现直接请求 Blackboard HTML。课程发现不再扫描所有课程内容或元数据缓存；资源同步按实际栏目 ID 遍历文件夹，使用 visited 集合和层级/数量限制，仅在所有页面成功后事务性保存资源及 `remote_resource_details`。详情 JSON 保存正文、原始页面和内部附件地址；Web/Agent 只收到附件名，不暴露附件直链。现有资源 ID 计算不变，更新标题、类型、父级时保留下载状态。

认证仍复用 pku3b 0.16 的 Cookie；失效时调用 pku3b 强制刷新一次并传递 OTP。该刷新目前仍通过原 `course-content list` 命令完成。结构化页面失败不会静默退回文本列表并覆盖数据；可通过 `PKU_STUDY_STRUCTURED_TEACHING=0` 显式选择旧适配器。公告/成绩/录播/作业工作台尚未迁移。下载与入库仍执行现有解析回调，本轮没有改变自动解析行为。

## 主要接口

| 接口 | 用途 |
| --- | --- |
| `POST /api/teaching-network/courses/discover` | 发现课程，可在请求体提供一次性 OTP。 |
| `POST /api/teaching-network/courses/import` | 核实远端课程后建立工作区；已有映射直接返回。 |
| `GET /api/courses/:courseId/remote-resources/:resourceId` | 已同步资源正文、附件名和来源页面；旧快照以 detailsAvailable=false 明示需要重新同步。 |
| `GET/POST /api/courses/:courseId/lessons` | 列表/创建课次。 |
| `GET /api/courses/:courseId/lessons/:lessonId` | 读取完整课次，包括文档和 revision。 |
| `PUT .../lessons/:lessonId/outline` | 保存大纲，要求 revision。 |
| `PUT .../lessons/:lessonId/selections` | 保存主题到文本块的关联，要求 revision。 |
| `GET .../lessons/:lessonId/sources` | 展开已选原文及页码。 |
| `PUT .../lessons/:lessonId/document` | 保存人工编辑的正文，要求 revision。 |
| `GET/POST /api/courses/:courseId/materials` | 资料列表/二进制上传；单文件上限 100 MB。 |
| `PATCH .../materials/:assetId` | 调整用途分类。 |
| `POST .../materials/:assetId/parse` | 云端解析并索引，可重试。 |
| `GET /api/courses/:courseId/material-file?path=...` | 读取注册原件或解析图片，沿用 Bearer 认证。 |

旧 API、CLI 和原有手选素材讲义会话保持兼容。新增学习功能首先通过共享 core、API、Web 和 Agent 暴露；CLI 尚未添加独立的课次命令。

## 验证与外部限制

测试覆盖：课次生成步骤、范围选材、跨课程隔离、版本冲突、同一教材去重、重建索引保留来源、图片和表格保存、解析失败重试、上传录播转写、课程发现去重、HTTP 上传/编辑以及 Markdown 服务端渲染。教学网和云端模型使用注入的测试 Provider；这些测试不证明外部服务账号、额度或真实生成质量。

结构化接入已在当前 Linux/WSL 环境验证 56 门课程目录及三门课程的资源同步，包含空课程与多层目录；课堂视频仍使用音频转写，没有额外板书/画面识别。后台状态和已保存中间结果可用于继续学习流程，但尚无服务重启后自动续跑整条 Agent 任务的调度器。页面解析规则与 pku3b Cookie 序列化仍需随教学网及上游版本变化维护。
