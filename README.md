# SI Control Center (starter) - User Guide

A small program that runs your project **one phase at a time**:

```
phase files (your blueprint commands)
        |
        v
  CODER  (OpenCode, model A)  -- works in your project folder
        |
        v
  AUTOMATED CHECKS  (your test/build commands, run by this app, not by the AI)
        |  fail -> back to coder with the error output
        v
  AUDITOR  (OpenCode, model B, read-only agent)
        |
        v
  CONTROLLER AI  (your API model) reads the audit -> PASS or FAIL
        |  FAIL -> coder gets a precise fix task (max 3 attempts)
        v
  YOU review and approve  (a = approve, r = reject with feedback, q = quit)
        |
        v
  git commit + tag "phase-N-approved"  ->  next phase
```

Everything is plain files. No database. If you stop the program, run it again and
it continues: approved phases are skipped.

> **Status of this starter:** I tested the whole loop with a fake `opencode` and a fake
> controller API (happy path, reject-with-feedback, failing checks, retry limit, resume).
> I have **not** run it against the real OpenCode, so do Step 6 (smoke test) first.

---

## Step 1 - Requirements

- **Node.js 20 or newer** (`node --version`)
- **Git**
- **OpenCode** installed and logged in to your model providers (`opencode --version`)
- An **API key** for the controller model (any OpenAI-compatible `/chat/completions`
  endpoint: OpenAI, OpenRouter, a local server, etc.)
- Two **different models** available in OpenCode: one for the coder, one for the auditor

## Step 2 - Install

```bash
cd si-control-center
npm install
```

## Step 3 - Prepare your project (the code the AI will edit)

Your project must be a **git repository with at least one commit**:

```bash
cd /path/to/my-project
git init
git add -A && git commit -m "initial"
```

Put your blueprint where the coder and auditor can read it, for example
`my-project/docs/blueprint.md`. Phase files may refer to it by path.

> Keep the `phases/` folder **outside** your project (the default). Otherwise the
> run logs get committed into your code.

## Step 4 - Configure

**4a. Controller API key.** Copy `.env.example` to `.env` and put your key in it:

```
CONTROLLER_API_KEY=your-key-here
```

**4b. Edit `config.json`:**

| Setting | Meaning |
|---|---|
| `projectDir` | Path to your project (the git repo from Step 3) |
| `phasesDir` | Folder holding `phase-1`, `phase-2`, ... (default `./phases`) |
| `coder.model` | OpenCode model for coding, written `provider/model` |
| `auditor.model` | A **different** model for auditing |
| `auditor.agent` | OpenCode agent for the auditor (default `plan`, meant to be read-only) |
| `controller.baseUrl` / `controller.model` | Your API endpoint and model for the pass/fail verdict |
| `checkCommands` | Commands the **app** runs itself after the coder, e.g. `["npm test", "npm run build"]`. Use whatever your project needs (`pytest`, `go test ./...`, ...) |
| `maxAttempts` | Tries per phase before it stops and asks you (default 3) |
| `timeoutMinutes` | Time limit for each coder, auditor, or check run |
| `autoCommit` | After you approve: `git add -A`, commit, and tag `phase-N-approved` |
| `maxChars` | Size cap for reports and diffs sent to the auditor and controller |

## Step 5 - Write your phase files

For each phase, create a folder `phases/phase-N/` (numbers decide the order) with
**three** files. Examples are included for phase 1 and 2 - replace them with yours.

| File | What goes in it |
|---|---|
| `coder_command.md` | The exact instructions for the coder: what to build, which blueprint sections to read, what NOT to touch |
| `audit_command.md` | What the auditor must check and how |
| `criteria.md` | Measurable pass/fail criteria. The controller AI judges against this file |

Tips for good phase files:
- Make criteria **checkable** ("`npm test` passes", "file X exists") rather than vague ("good quality").
- Say what is **out of scope** so the coder does not run ahead into later phases.
- Put hard requirements in `checkCommands` too - those are verified by real commands, not by AI opinion.

## Step 6 - Smoke test (do this before a real phase)

Check that OpenCode accepts the options this app uses:

```bash
opencode run --help
```

Confirm that `--model`, `--agent` and `--file` exist. Then, inside a scratch repo:

```bash
opencode run "Reply with the single word OK" --model provider/coder-model
```

If that works, make a tiny test phase (for example "create hello.txt") and run it.
Also confirm your auditor agent really is read-only: ask it to create a file and
check that it refuses, or check what the `plan` agent is allowed to do in the
OpenCode docs. If it is not read-only, set a stricter agent in `auditor.agent`.

## Step 7 - Run

```bash
npm start                 # runs all phases in order
npm start -- phase-2      # runs one specific phase
```

What you will see, per attempt:

1. `running coder ...` - the coder works in your project folder.
2. `check: <command>` - your check commands run. If one fails, the coder is sent
   the error output and tries again (the auditor is skipped to save cost).
3. `running auditor ...` - the auditor sees the coder report, the check results and
   the git diff.
4. `asking controller AI ...` - PASS or FAIL.
   - **FAIL:** the controller writes a fix task, the coder retries.
   - **PASS:** you are asked to decide.

## Step 8 - Your approval

At the prompt:

- **a** - approve. The phase is marked approved, committed and tagged, and the next phase starts.
- **r** - reject. Type your feedback; it is given to the coder as the next fix task.
- **q** - quit. Run again later; the phase restarts from a fresh attempt.

**Always look before approving.** Open the files named on screen, and check `git diff`
in your project. The AI verdict is advice; the decision is yours.

## Where things are saved

```
phases/phase-1/
  status.json                      approved? attempts? last verdict
  runs/attempt-1.coder.prompt.md   what the coder was told
  runs/attempt-1.coder.report.md   everything the coder printed (its report)
  runs/attempt-1.checks.txt        results of your check commands
  runs/attempt-1.auditor.prompt.md what the auditor was told
  runs/attempt-1.auditor.report.md the audit
  runs/attempt-1.verdict.json      the controller's verdict
```

## Common tasks

- **Redo an approved phase:** delete `phases/phase-N/status.json`, and remove the
  tag with `git tag -d phase-N-approved` in your project.
- **Phase stopped after max attempts:** read `runs/` to see why, fix the phase files
  (or the code by hand), then run again.
- **Roll back a phase:** in your project, `git reset --hard phase-(N-1)-approved`.
- **Run without auto-commit:** set `"autoCommit": false`.

## Troubleshooting

| Problem | What to try |
|---|---|
| `spawn error ... ENOENT` | `opencode` is not on your PATH. Fix PATH or set the full path in `coder.command` / `auditor.command` |
| `projectDir must be a git repository` | Run `git init` and make a first commit in that folder |
| `Environment variable CONTROLLER_API_KEY is not set` | Create `.env` from `.env.example` (Step 4a) |
| `Controller API error 401/404` | Check `controller.baseUrl` (it must end where `/chat/completions` can be appended, e.g. `.../v1`), the key, and the model name |
| Controller returns no JSON | Use a stronger controller model; the verdict is requested as JSON only |
| Coder or auditor times out | Raise `timeoutMinutes` or split the phase into smaller phases |
| Windows quoting problems | Keep phase prompts in the `.md` files (they are passed as attachments, not typed on the command line) |

## Known limits (v1)

- **Auditor read-only is not enforced by this app.** It relies on the OpenCode agent
  you choose. Verify it (Step 6).
- The controller uses the **OpenAI-compatible** chat format. Using Anthropic's native
  API directly needs a small change in `askController`.
- Approval is a **terminal prompt**. Nothing is committed without your `a`.
- A phase interrupted half-way restarts from attempt 1 (approved phases are never repeated).
- Reports are plain text. The coder is asked to end with a fixed set of headings,
  but the app does not parse them.

## Next steps, when this works

1. A small local **web page** for approval (reports, diff, Approve/Reject buttons).
2. An **adapter** so Cline (or Kilo Code) can be the coder instead of OpenCode.
3. A thin **VS Code panel** that talks to the same app.
