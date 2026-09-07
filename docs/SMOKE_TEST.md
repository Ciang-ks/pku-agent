# Manual Smoke Tests

Run these checks only on a local machine with your own PKU account and after
`pku-study doctor` reports the required tools. Do not place passwords, OTP
codes, Bearer tokens, or Treehole text in issue trackers or test logs.

## Preparation

```bash
pnpm --filter @pku-study/cli start -- doctor
pku3b --config ~/.config/pku-study/pku3b/config.toml init
pnpm --filter @pku-study/cli start -- serve
```

Open the local Web app, set the API token from `pku-study token`, and create a
test course mapped to a stable Blackboard course ID. Use a course that has no
submission deadline at risk.

## Teaching Network

1. Sync the course overview and confirm announcements, assignments, recordings,
   and grades only belong to the mapped course.
2. Open one announcement and confirm the title, body, date, and attachment
   names match Blackboard.
3. Sync the resource tree and import one non-sensitive resource. Confirm it is
   stored only under that course's `materials/original/` directory.
4. Download one assignment attachment. Confirm the files are under
   `assignments/<stable-id>/original/`, not an arbitrary caller-selected path.
5. If pku3b requests an OTP, submit it through the local UI and confirm the job
   resumes. Inspect neither the job detail nor course files for the OTP.

The current pku3b `announcement show` command exposes attachment names but not
a stable attachment-download command. PKU Study intentionally does not infer a
download URL from display text; announcement attachment download remains an
upstream-contract dependency.

## Treehole

1. Open **候选课程**, choose **连接树洞**, and complete PKU OAuth/SSO.
2. If prompted, enter the mobile-token or SMS verification code in the same
   form and then collect evidence for a disposable candidate.
3. Save a short review and verify only the rating, summary, and PIDs appear in
   the candidate record. The post/comment text must not appear in SQLite,
   course files, or a named Agent session.
4. Stop and restart the local server. Confirm the Treehole session is gone and
   credentials must be supplied again unless an intentional environment-provided
   `PKU_STUDY_TREEHOLE_AUTHORIZATION` is in use.

## Recording And PDF

1. Transcribe one short recording. Confirm only a timestamped Markdown file
   remains under `recordings/transcripts/`; video, audio chunks, and the target
   pku3b video cache are removed while `ua.json` remains.
2. Export a non-sensitive assignment draft to PDF, approve it, edit the draft,
   and verify submission is blocked until export and approval are repeated.
3. Never include a real graded submission in automated testing. The final
   submission action must be performed and confirmed manually.
