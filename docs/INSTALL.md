# Installation

PKU Study is a local, single-user application. It does not upload course files, pku3b credentials, Treehole evidence, or API tokens to a PKU Study server.

## Base Runtime

Install Node.js 22 LTS and pnpm 10, then install the workspace dependencies:

```bash
corepack enable
corepack prepare pnpm@10 --activate
pnpm install --frozen-lockfile
pnpm build
```

Start the local server and retrieve its API token in a second terminal:

```bash
pnpm --filter @pku-study/server start
pnpm --filter @pku-study/cli start -- token
```

The server binds to `127.0.0.1:4317` by default. Set `PKU_STUDY_HOST` or `PKU_STUDY_PORT` before starting it only when a local development setup requires a different loopback address or port.

For a repeatable local setup, copy [`.env.example`](../.env.example) to
`.env`, fill in only the integrations you intend to use, and load it in the
shell that starts PKU Study:

```bash
cp .env.example .env
set -a
. ./.env
set +a
```

The example keeps state under `.pku-study/`, which is ignored by Git. For a
normal installation, omit the four `PKU_STUDY_*_DIR` overrides to use the
platform data, config, cache, and course directories described below.

Configuration is split by responsibility:

| Area | Variables or command | Notes |
| --- | --- | --- |
| Local storage | `PKU_STUDY_DATA_DIR`, `PKU_STUDY_CONFIG_DIR`, `PKU_STUDY_CACHE_DIR`, `PKU_STUDY_COURSES_DIR` | SQLite and course files are local; cache can be deleted and rebuilt. |
| API server | `PKU_STUDY_HOST`, `PKU_STUDY_PORT` | Keep the host on loopback for the single-user deployment. |
| Teaching network | `pku3b --config <config path> init` | Credentials and cookies stay owned by pku3b; OTP is supplied per job. |
| Treehole | `PKU_STUDY_TREEHOLE_BASE_URL`, optional `PKU_STUDY_TREEHOLE_AUTHORIZATION` | Prefer the Web login; an injected Bearer session is process-local. |
| OpenAI-compatible APIs | `OPENAI_API_KEY`, `OPENAI_BASE_URL`, `OPENAI_TRANSCRIPTION_MODEL`, `OPENAI_EMBEDDING_MODEL` | The key is never persisted by PKU Study. |
| PDF export | `PKU_STUDY_PDF_ENGINE` | Requires Pandoc plus the selected engine. |
| Media processing | `ffmpeg`, `ffprobe` on `PATH` | Both executables are required for recording transcription. |
| PDF material parsing | MinerU-Skill cloud CLI (`mineru` on `PATH`) | Uses MinerU Agent/Standard cloud APIs; no local model weights are required. |

## Platform Notes

Linux and WSL are the primary development targets. Use a normal terminal with Node.js and the external tools on `PATH`.

On macOS, install Node.js 22 and pnpm with your preferred package manager. For PDF output, make sure Pandoc and a LaTeX engine such as `xelatex` are available.

On Windows, WSL is the recommended path because it keeps the pku3b, FFmpeg, MinerU, and Pandoc commands in one Unix-like environment. Native Windows is supported by the TypeScript paths and CI; ensure all external executables are on `PATH` in the shell that starts PKU Study.

## Optional Integrations

Run the built-in diagnostic after installing tools:

```bash
pnpm --filter @pku-study/cli start -- doctor
```

| Feature | Required executable or configuration |
| --- | --- |
| Teaching-network metadata, resources, videos, assignments | `pku3b` version `>=0.16.0 <0.17.0` |
| Recording transcription | `ffmpeg`, `ffprobe`, and `OPENAI_API_KEY` or an injected `TranscriptionProvider` |
| PDF answer export | `pandoc` and `xelatex`; set `PKU_STUDY_PDF_ENGINE` to override the PDF engine |
| PDF material indexing | MinerU-Skill cloud CLI (`mineru`) |
| Semantic search | `OPENAI_API_KEY`; defaults to `text-embedding-3-small` |
| Treehole evidence | Use the Web **候选课程 → 连接树洞** form; `PKU_STUDY_TREEHOLE_AUTHORIZATION` is optional for an existing session |

`OPENAI_BASE_URL` changes the OpenAI-compatible API base URL. `OPENAI_TRANSCRIPTION_MODEL` defaults to `gpt-transcribe`, and `OPENAI_EMBEDDING_MODEL` defaults to `text-embedding-3-small`.

## Teaching Network

Initialize pku3b using PKU Study's dedicated configuration location. Do not copy passwords, cookies, or OTP values into PKU Study environment files or SQLite.

```bash
pku3b --config ~/.config/pku-study/pku3b/config.toml init
```

Map each local course to a stable Blackboard course ID. Jobs that require an OTP become `waiting_for_auth`; resume them through the Web dialog or `pku-study resume-auth`. The OTP is passed to one pku3b process only and is never stored.

## Common Workflows

```bash
# Synchronize metadata, then transcribe one stable video ID.
pku-study course sync-overview --course-id <course-id>
pku-study course announcement --course-id <course-id> --announcement-id <announcement-id>
pku-study recording transcribe --course-id <course-id> --recording-id <video-id>

# Download a synchronized assignment into its fixed course workspace directory.
pku-study assignment download --course-id <course-id> --assignment-id <assignment-id>

# Generate answer.pdf from a previously saved draft, approve it, then submit.
pku-study assignment export --course-id <course-id> --assignment-id <assignment-id>
pku-study assignment approve --course-id <course-id> --assignment-id <assignment-id>
pku-study assignment submit --course-id <course-id> --assignment-id <assignment-id> --approval-id <approval-id>

# Read a saved practice set. Generation remains in the restricted course assistant.
pku-study practice list --course-id <course-id>
pku-study practice show --course-id <course-id> --name <practice-name>
```

The assignment approval expires after 30 minutes and binds the final `answer.pdf` SHA-256 hash. Editing the file requires exporting and approving it again.

## Treehole

The default provider targets `https://treehole.pku.edu.cn`. Open the candidate-course view and authenticate interactively; when prompted, enter the mobile-token or SMS verification code in the same form. Credentials and the resulting session remain in memory only and are cleared when the local server stops. Use `PKU_STUDY_TREEHOLE_BASE_URL` only for a compatible alternate host, and `PKU_STUDY_TREEHOLE_AUTHORIZATION` only to inject an existing Bearer session.
