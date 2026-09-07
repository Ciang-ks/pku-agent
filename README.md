# PKU Study

PKU Study is a local-first, text-centered learning workspace built around courses and a restricted Pi agent runtime.

The current implementation provides:

- portable course workspaces;
- SQLite-backed current state;
- an explicit asynchronous job state machine;
- authenticated local REST and SSE APIs;
- a JSON-first CLI and dependency doctor;
- a version-gated pku3b process adapter for resources, overview, announcement details, recordings, assignment downloads, and submission;
- MinerU parsing, FTS5 search, and optional OpenAI embeddings;
- restricted Pi Skills for notes, draft answers, and practice sets;
- live, in-memory Treehole authentication and evidence that are not persisted;
- recording transcription with temporary media cleanup;
- explicit lecture-note source confirmation for indexed materials and transcripts;
- controlled Pandoc PDF export and SHA-256-bound assignment approval;
- a Vue workspace for resources, recordings, searches, and assignment actions.

See [PLAN.md](PLAN.md) for the complete architecture, [docs/INSTALL.md](docs/INSTALL.md) for platform setup, [docs/SMOKE_TEST.md](docs/SMOKE_TEST.md) for controlled real-service verification, and [reference/README.md](reference/README.md) for the source-project review.

## Development

Requirements: Node.js 22 LTS and pnpm 10.

```bash
corepack enable
pnpm install
pnpm typecheck
pnpm test
pnpm build
pnpm --filter @pku-study/cli start -- doctor
pnpm --filter @pku-study/cli start -- token
pnpm --filter @pku-study/cli start -- serve
```

The server listens on `127.0.0.1:4317` by default. On first start it creates a persistent local API token and prints its path. Run `pku-study token` to read it; the Web client asks for that token and keeps it in browser local storage.

For split development, run the API with `pnpm dev` and Vite with `pnpm dev:web`. The development origin on port 5173 is allowed explicitly and proxied to the local API.

## Teaching-network integration

PKU Study delegates IAAA and Blackboard access to pku3b `>=0.16.0 <0.17.0`. Initialize the platform-owned configuration once, then map local courses to stable Blackboard course IDs:

```bash
pku3b --config ~/.config/pku-study/pku3b/config.toml init
pnpm --filter @pku-study/cli start -- course add \
  --name "机器学习" --teacher "教师" --term "2026-fall" \
  --remote-course-id "_123_1"
pnpm --filter @pku-study/cli start -- course sync --course-id <local-course-uuid>
pnpm --filter @pku-study/cli start -- course resources --course-id <local-course-uuid>
pnpm --filter @pku-study/cli start -- course announcement --course-id <local-course-uuid> --announcement-id <announcement-id>
```

The pku3b cookie cache is isolated below the PKU Study cache directory and is preserved between runs. If IAAA requires a mobile OTP, the job pauses at `waiting_for_auth`; provide the OTP through the Web dialog or `resume-auth`. The OTP is passed only to that process invocation and is never persisted.

Resource synchronization reads metadata only. Individual imports use the stored remote resource ID and always download through a staging directory owned by the target course; callers cannot choose an arbitrary filesystem path.

The home screen's read-only timeline can be filtered to today or this week. It aggregates synchronized assignments, announcements, recordings, grades, and remote course materials without starting downloads or submissions.

## Recordings and Assignments

After synchronizing a course overview, recordings with stable remote IDs can be transcribed from the Web workspace or CLI. Video downloads, extracted audio, and chunks are task-local temporary files; only timestamped Markdown under `recordings/transcripts/` remains after success. Configure `OPENAI_API_KEY` for the default transcription provider, and install FFmpeg/FFprobe.

The assignment flow is deliberately separate from the Pi agent:

```bash
pku-study assignment export --course-id <course-id> --assignment-id <assignment-id>
pku-study assignment approve --course-id <course-id> --assignment-id <assignment-id>
pku-study assignment submit --course-id <course-id> --assignment-id <assignment-id> --approval-id <approval-id>
pku-study assignment download --course-id <course-id> --assignment-id <assignment-id>
```

Use `pku-study course announcement` to fetch structured announcement text and attachment names for a synchronized stable announcement ID. Download stores a synchronized assignment's attachments under the fixed `assignments/<id>/original/` directory; the caller cannot choose an output path. Export creates the controlled `answer.pdf` from `draft.md`. Approval binds its SHA-256 hash for 30 minutes; edits, expiry, or a different remote assignment ID block submission. `pandoc` and a LaTeX engine are required for export. Full platform setup, including Linux/WSL, macOS, and Windows notes, is in [docs/INSTALL.md](docs/INSTALL.md).

The restricted `practice-generator` Skill saves named questions and answers as separate Markdown files. Use the course workspace's **自测练习** module to read questions first and reveal answers explicitly, or inspect saved sets from the CLI:

```bash
pku-study practice list --course-id <course-id>
pku-study practice show --course-id <course-id> --name <practice-name>
```

The course workspace's **讲义生成** module lists only indexed files under `materials/text/` and `recordings/transcripts/`. Selecting sources creates an ephemeral `lecture-notes` session that can read only those exact indexed paths and save a note; it has no search, teaching-network, Treehole, assignment, or generic filesystem tools.

Candidate-course reviews follow the same explicit boundary: live Treehole posts and comments remain in the current response only. After reviewing them, save a structured conclusion from the Web form; only scores, confidence, summary, selected positives/negatives, and related PIDs are persisted.

## Treehole Authentication

Open **候选课程** and choose **连接树洞**. The local server performs PKU OAuth and Treehole SSO, then asks for a mobile-token or SMS code only when the service requires it. The form clears credentials after success; the resulting Bearer session stays in the running local server only. Set `PKU_STUDY_TREEHOLE_AUTHORIZATION` only when you intentionally want to supply an existing session, and optionally set `PKU_STUDY_TREEHOLE_BASE_URL` to override the default Treehole host.
