# 联调记录（更新至 2026-09-09）

## 结构化教学网接入层（2026-09-09）

默认启用 TypeScript Blackboard reader，复用 pku3b 0.16 登录会话。课程发现直接读取主页；资源同步保留栏目/文件夹真实父级 ID、正文和附件元数据。同步失败不替换旧快照，Web 和 Agent 使用同一个详情服务。元数据读取不下载文件；具体资源导入仍沿用下载后自动入库解析的现有行为。

| 检查 | 结果 |
| --- | --- |
| 真实课程发现 | 56 门课程都有稳定 ID，直接从教学网页面读取，不扫描全部课程内容或 pku3b 元数据缓存。 |
| 空课程 | 人工智能中的编程返回 0 项资源、0 个内容栏目，保持空状态。 |
| 宏观课程树 | 30 个节点：3 个栏目、2 个文件夹及 25 个其他资源；32 个附件条目。实际恢复 `教学内容 → Lecture Slides → Lecture 1`。 |
| NeuroAI 课程树 | 17 个节点，含 2 个栏目；3 个普通附件条目，其余 File 节点在下载时解析文件链接。 |
| 实际下载 | 普通附件 `lecture 1.pdf`（5,308,229 字节）与 File 链接 `第一讲：概述(1).pdf`（13,987,411 字节）均通过新 reader 下载并核验 PDF 文件头。修复跳转前 `xid-*` 地址没有文件扩展名的问题，优先读取响应文件名及最终 URL。 |
| API 和已有数据 | 三门课程同步成功，旧资料 resourceId、已导入状态保留；详情返回正文、附件名和来源页，附件下载直链不暴露。 |
| 新资料完整导入 | 从新详情 API 选中此前未下载的 `中宏课程大纲.pdf`，通过新下载器导入、MinerU Standard 解析及资料入库，状态为 ready。 |
| 浏览器 | 三级目录、附件详情、容器不可作为文件导入、已有导入状态均通过；刷新并重新进入课程后原讲义 21 张图片全部加载，无页面脚本错误。 |
| 回归覆盖 | 同名文件夹按 ID 区分、目录循环去重、页面结构变化和部分失败、跨域跳转、Cookie 不跨域发送、下载刷新附件地址、文件名跳转、认证失效只刷新一次、OTP 传递、跨课程详情拒绝及事务保存。 |
| 最终检查 | core 52、server 22、web 3，共 77 项测试通过；全部工作区 typecheck、生产 build 和 diff whitespace 检查通过。 |

证据位于 `.pku-study/integration/results/structured-2026-09-09/`，包括三门课程原始结构化快照、`api-checks.json`、`browser.json`、`import-check.json`、`resource-details.png` 和下载文件的 SHA-256 记录。

边界：本轮仍依赖 pku3b Cookie 序列化；会话刷新仍调用其 `course-content list --force`。公告、成绩、录播与作业工作台仍走现有 CLI。结构化解析失败不会静默退回旧路径，可用 `PKU_STUDY_STRUCTURED_TEACHING=0` 显式切换旧适配器。未执行真实 ASR、作业提交或更换用户凭据。

## 最新实测：手动授权后的非 ASR 流程

已解除此前网络和本地监听阻塞，使用真实 pku3b、MinerU、ZAI `glm-4.7`、Pandoc/Tectonic 及 Chromium 检查。以下结果优先于后面的历史阻塞记录。视频 ASR 未执行，真实作业未提交。

| 环节 | 实测结果 |
| --- | --- |
| 课程发现和导入 | API 和浏览器均返回 56 门课程，56 门都有稳定 ID。“人工智能中的编程(26-27学年第1学期)”已导入，ID `_104187_1`；该课程真实同步结果为课件、公告、作业、录播和成绩均为空。其工作区中的 `sample.pdf` 和带“联调”字样的课次是明确标记的验证样本。 |
| 真实概览和公告 | 高等数学A（二）同步得到 13 项资料、6 条公告、13 份作业、30 条录播、13 项成绩；成功读取“高数A期末查卷”公告详情。 |
| 真实课件下载 | NeuroAI“第一讲：概述”文件链接和中级宏观“Lecture 1”普通附件均下载成功，原 PDF 分别约 14 MB、5.3 MB。原 pku3b 返回 `expect redirection, but got status 200 OK`，已通过针对该错误的兼容下载修复。 |
| 作业附件 | 中级宏观历史作业 HW1 的 `HW1.pdf` 成功下载到固定 `assignments/<id>/original/`。修复下载缺失 `--all-term` 和同样的 WebDAV 重定向问题。高数第一次作业没有实际附件，不能作为附件成功样本。 |
| 云端文档解析 | 免费接口分卷完成 22 页和 107 页课件的文字解析，但实测图像只剩占位符。提供 token 后 Standard API 完整解析通过；107 页单独探针约 32 秒。应用现默认在 token 存在时选择 Standard，并读取其结构化 content list，宏观课件保留 21 张图、22 页页码；NeuroAI 保留 226 张图、107 页页码。 |
| 样本浏览器闭环 | PDF 上传→真实 MinerU→人工大纲→编辑备注→真实 Agent 精确选材→保存讲义→刷新保持一致。人工备注和 manual 大纲保留，SSE complete，无页面脚本错误。 |
| 真实课件 Agent | 根据宏观课件生成 materials 大纲、6 组选材、6847 字符中文讲义及 `intro-live-check` 三道自测题，问题和答案分开存储。升级图像/页码来源后重新生成，21 个图片引用均有实际路径，原有笔误已修正。命名会话在服务重启后可恢复，并通过关闭后再次恢复检查。 |
| 真实讲义浏览器验收 | Chromium 实际加载全部 21 张讲义图片，渲染 1 处数学公式；6 组选材来源可查看，自测答案可展开及隐藏，页面脚本错误为 0。截图为 `real-lecture.png`、`practice.png`，结构化结果为 `real-browser.json`。 |
| 索引、检索和录播关联 | 修复 Standard 图文块重建索引后分段变化的问题。原 Agent 选材按相同文本和原页码恢复到规范化段落，6 组共 114 个引用在再次重建后保持有效；GDP 检索返回 10 条结果。资料图片鉴权通过（已认证 200，未认证 401），时间线可读取；真实录播 ID 可关联课次，未生成转写。 |
| 中文 PDF 与审批 | Tectonic 首次下载 TeX bundle 后成功导出。修复缺失汉字却返回成功的问题，使用本机中文字体后从 PDF 中提取到完整中文和公式。隔离测试课程通过 API 导出真实 PDF（9796 字节）、审批，并验证 PDF 改动后提交任务在远端调用前因 `ASSIGNMENT_APPROVAL_STALE` 被拒绝。 |
| 回归与构建 | core 44、server 21、web 3，共 68 项测试通过。索引修复后重跑 core/server 测试，全部工作区 typecheck 和生产 build 通过。ASR 仅保留原有模拟单测，没有真实调用。 |

### 本次新增修复

- pku3b 下载兼容仅针对已识别的 200/重定向错误，使用 pku3b 已有会话与内容元数据；只跟随教学网同域跳转，检查文件名、体积与 HTML 登录页。作业 fallback 限定稳定课程 ID 内唯一且完全相同的作业标题，未改变提交实现。
- MinerU 增加可选 `PKU_STUDY_MINERU_SPLIT=1`（依赖 pypdf）；token 存在时优先 Standard，保留图片、表格、公式和原 PDF 页码。API 大小/页数限制不再误报为认证失败。
- 明确重解析支持 `{ "force": true }`；来源块改变时使相关旧选材失效、讲义标记待更新并保留正文，避免继续展示失效引用。
- 首次解析以落盘后的规范化 Markdown 分段建立索引，使多段正文、图注、图片和脚注在重建前后保持相同块 ID；新增结构化图文选材重建回归测试。联调数据中的旧选材按原 Agent 选中的文本和原页码迁移，讲义正文保留。
- 讲义使用 KaTeX 渲染 `$...$`、`$$...$$`、`\(...\)`、`\[...\]`，代码块保持原样，危险链接保持禁用。
- 中文 PDF 自动选择已安装的 CJK 字体，可用 `PKU_STUDY_PDF_CJK_FONT` 覆盖；缺字时不接受不完整导出，首次初始化超时有明确提示。

### 证据与剩余边界

本轮证据在 `.pku-study/integration/results/live-2026-09-09/`：`discovery.json`、`target.json`、`material-overview.json`、`announcement-detail.json`、`assignment-attachment-job.json`、`attachment-standard.json`、`slides-standard.json`、`standard/`、`browser.json`、`real-lesson.json`、`real-sources.json`、`real-practice.json`、`resumed-session.json`、`real-browser.json`、`source-repair.json`、`final-checks.json`、`final-search.json`、`final-timeline.json`、`pdf-api/result.json`。文件包含用户课程材料，仅保存在忽略的本地数据目录。

服务地址为 `http://127.0.0.1:4317`；启动入口仍为 `.pku-study/integration/start-server.sh`。本次 token 只注入进程环境，未写入启动脚本或仓库；重启后需要重新提供 `MINERU_TOKEN`。生成的课程工作区和学习结果已保存。

树洞状态实测为 `needs_password`，需要在页面单独登录，未把 pku3b 认证冒充树洞认证。真实树洞搜索/评价未验证。公告同名课程的跨学期归属仍受上游只有课程名的输出限制。没有执行视频 ASR 或真实作业提交；后者仅验证隔离流程和已有测试。免费接口的图片占位符不能视为图像解析成功。

---

## 续测（2026-09-09，排除视频 ASR）

**本轮完成代码修复和本地流程回归，尚不能认定真实非 ASR 全流程通过。** pku3b 配置已存在，版本为 0.16.0；实际调用在创建代理网络连接时返回 `Operation not permitted`。本地服务绑定 `127.0.0.1:4317` 返回 `EPERM`，请求启动服务的提权被自动审批拒绝。因此未将历史缓存、模拟上游或上一轮云端结果算作本轮联网成功。

### 修复与验证

| 项目 | 本轮结果 |
| --- | --- |
| 空课程无法导入 | 对照 reference/pku3b 的 `Blackboard::_get_courses` 序列化契约，新增仅读取 `[id, long_title, is_current][]` 的课程目录适配。必须先取得成功的课程列表；匹配完整标题，内容行 ID 优先，忽略无关、损坏、符号链接和不完整目录。网络失败不会用缓存伪装成功。 |
| 真实历史目录核对 | 只读核对已有发现结果与 pku3b 缓存：56 门课程全部可解析 ID，原内容列表只能解析 27 门。“人工智能中的编程(26-27学年第1学期)”为 `_104187_1`。本轮未伪造成功发现或向真实工作区写入模拟教学网数据。 |
| 概览漏项／跨学期混入 | 修复 `26-27学年第1学期` 后缀识别；学期可与 `2026-fall` 对齐，同名不同学期的作业、录播和成绩不再混入。保留课程名称本身的括号。公告上游只输出课程名，仍不能可靠区分同名课程的不同学期。 |
| 资料库假失败 | pku3b 自动生成的空 `description.txt` 不再入库为失败课件；有内容的说明归类为 other。 |
| API 串联 | 新增进程内 Fastify 回归：发现空课程→重复导入→空课程同步→出现课件后同步→概览学期隔离→下载、入库、Markdown 解析→重复导入去重→检索→录播 ID 关联→人工大纲→精确选材→讲义保存→重建索引后引用保持。教学网返回和下载文件为测试替身；无 ASR、云端解析或模型调用。 |
| PDF 配置诊断 | 实测默认 XeLaTeX 缺失，而旧 doctor 因 Tectonic 存在误报通过。doctor 现检查实际配置的引擎；联调启动脚本指定 `PKU_STUDY_PDF_ENGINE=tectonic`。Tectonic 实际渲染还因默认缓存目录不可写而失败，PDF 输出尚未通过。 |
| 回归与构建 | core 36、server 21、web 2，共 59 项通过；typecheck、生产 build、diff whitespace 检查通过。包含原有作业下载、PDF/审批/提交状态、树洞内存会话、Agent 工具和 SSE 错误测试；这些上游行为均为模拟验证，未提交真实作业。原有 ASR 单元测试随套件回归，本轮没有执行真实 ASR。 |

本轮证据位于 `.pku-study/integration/results/catalog-check-2026-09-09.json`、`checks-2026-09-09.json`，以及 `pdf-check/sample.md`。课程目录适配依赖 pku3b 0.16 内部缓存格式，版本变更需要重新核验。

### 待允许网络和本地服务后的实测

1. 启动 `.pku-study/integration/start-server.sh`，从 Web 重新发现并导入目标课程，确认实时 ID 与上述历史目录一致。
2. 同步概览和课件，查看公告；有附件时实测课件／作业附件下载。若目标课尚未发布课件，保留空状态，另选已有课件的课程检查下载。
3. 真实课件→MinerU→索引→手工大纲或资料大纲→Agent 选材和讲义→编辑并刷新；在浏览器确认状态和引用。视频仅核对元数据与课次关联，跳过 ASR。
4. 使 Tectonic 的缓存与 TeX bundle 可用后再验证真实 PDF 输出。树洞需要独立的内存认证，不能把 pku3b 登录等同于树洞登录。真实作业提交保持人工操作。

以下保留 9 月 8 日的历史记录。

目标真实课程：**人工智能中的编程**。当前已通过隔离样本课程的真实 Web/API、MinerU 云端解析、云端 Agent 选材与讲义保存。教学网尚未登录，真实课程导入和录播转写不能据此认定通过。

## 已通过

| 链路 | 方法与结果 |
| --- | --- |
| Web → API → 课程资料库 | Playwright 操作生产构建页面：上传教材 Markdown、解析、建立课次、保存人工大纲、编辑讲义。刷新后保持一致，页面无脚本错误。 |
| PDF → MinerU → 课程索引 | 自制一页线性变换 PDF，通过真实 HTTP 上传和解析接口调用 MinerU Agent API；状态从 failed 经重试变为 ready，输出正确的线性公式和对角矩阵示例。 |
| Web → Pi → 云端模型 | 浏览器点击“交给助手整理”；真实 ZAI `glm-4.7` 返回文本和工具事件，最终 SSE complete。另以 DeepSeek `deepseek-v4-flash` 通过最小连接实测。 |
| 大纲 → 精确选材 → 讲义 | Agent 保留人工大纲，选中教材两个相关段落，未选取下节课特征值段落；保存约 432 字符的 Markdown，保留“课堂上重点解释了线性性质。”，刷新后一致。大纲仍标明 manual，本次没有录播。 |
| 失败展示 | 服务端测试模拟 SDK 正常返回失败消息，确认只发 SSE error；Playwright 拦截消息接口注入同类错误，确认页面显示连接失败且没有空成功占位。这部分为模拟异常验证。 |
| 数据与错误回归 | 核心 31、服务端 20、Web 2，共 53 项测试通过；typecheck 和生产 build 通过。覆盖 revision 冲突、跨课引用拒绝、上传去重、解析重试、模拟转写与 SSE 失败处理。 |

## 本次修复

- Pi SDK 的 `prompt()` 在模型失败时可能正常返回，失败信息保存在最后一条 assistant 消息中。服务端现在检查最终状态，失败时发送 SSE error，不再发送 complete；保留重试成功的情况，屏蔽提供商错误里的敏感细节。
- 服务和 CLI 启动时初始化代理请求。只加 Node 的环境代理开关不足以覆盖 SDK 引入的 undici；已统一 fetch 与 dispatcher。真实模型调用验证了修复。
- 支持显式选择 Agent provider/model，并只读引用外部 Pi 凭据。目录中存在的模型仍可能没有账号权限：`glm-5.2-highspeed` 实测返回 403，因此联调选择已验证可用的 `glm-4.7`。
- MinerU-Skill 3.3.1 的池化请求未使用环境代理。新增独立兼容入口 `scripts/mineru-cloud.py`；代理请求保留上传所需的空 Content-Type，避免 OSS 返回 SignatureDoesNotMatch。
- MinerU CLI 采用 quiet + JSON 状态，应用从结构化错误生成可读提示，不将命令路径、签名 URL 或令牌写入页面。

## 仍需外部条件

1. **教学网登录**：pku3b 0.16.0 已安装；初始化终端等待账号输入，尚未生成本次隔离环境的配置。需在该终端完成 IAAA 登录后，发现并导入“人工智能中的编程”，才能验证其真实课程 ID、课件、录播及下载内容。不要把账号密码发到对话中。
2. **录播云端转写**：当前没有默认转写服务所需的 API 凭据。上传录播→分段→转写→课次关联只通过了注入 Provider 的测试，尚未真实调用 ASR。Agent 的 ZAI/DeepSeek 凭据不等于转写凭据。
3. **低优先级作业链路**：本轮没有提交或自动上传作业。

PDF 实测仅覆盖一页文字与简单公式，不代表复杂教材的图表、页码和大型文件均已验证。当前讲义保留公式源码，尚未增加专门的数学排版渲染。

## 本地复现与证据

服务地址：`http://127.0.0.1:4317`。本次使用 `.pku-study/integration/` 下隔离的 data、config、cache、courses；启动参数保存于该目录的 `start-server.sh`，不包含密钥。重启方式：`bash .pku-study/integration/start-server.sh`（先停止占用端口的旧进程）。

Web 的“连接设置”需要本次服务的本地 API token，文件位于 `.pku-study/integration/config/api-token`。默认数据目录下的 token 不适用于这个隔离实例。

本次生成的截图、SSE 事件、原始测试 PDF、解析结果与生成讲义位于 `.pku-study/integration/results/`，未加入版本控制。主要证据：`browser-flow.json`、`cloud-parser.json`、`agent-stream.txt`、`generated-lesson.json`、`browser-agent.json`、`browser-error.json`、`05-generated-document.png`。

reference 对照沿用 `reference/README.md` 和 `reference/PKU3B_REVIEW.md`：当前 pku3b 作为教学网执行层，使用稳定远端 ID；Agent/skill 负责编排，领域服务负责状态、验证与落盘。本轮因登录未完成，未新增真实教学网行为的验证结论。

## 后续：pku3b 初始化后无法刷新（2026-09-08）

初始化文件已正确写入隔离配置目录。排查时本地服务未运行；恢复服务后，首次发现课程仍返回 `fetch course handles: courses not found`。对照 reference，pku3b 0.16 的主页预检可能接受未登录门户，从而跳过真正的登录。强制登录后成功建立 Cookie 会话，课程发现 API 返回 56 门课程。

应用现已针对 `PKU3B_COMMAND_FAILED` 且包含 `courses not found` 的首次失败自动强制登录重试一次，保留 OTP 参数，并继续向页面传递认证需求；两个回归测试及 core 构建通过。目标“人工智能中的编程(26-27学年第1学期)”已出现在发现列表，但当前内容列表没有给出其稳定 ID，仍不能通过现有导入按钮加入。真实录播转写仍未验证。
