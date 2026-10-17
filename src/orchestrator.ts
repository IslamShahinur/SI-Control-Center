// SI Control Center - small phase-by-phase automation loop.
//
// For every phase folder (phases/phase-1, phase-2, ...):
//   coder (OpenCode, model A) -> automated checks -> auditor (OpenCode, model B)
//   -> controller AI (API) verdict -> YOU approve -> git commit/tag -> next phase
//
// Only Node built-ins are used (Node 20+).

import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import readline from "node:readline/promises";

// ---------- types ----------

type Worker = { command: string; model: string; agent?: string };

type Config = {
  projectDir: string;
  phasesDir: string;
  coder: Worker;
  auditor: Worker;
  controller: { baseUrl: string; model: string; apiKeyEnv: string };
  checkCommands: string[];
  maxAttempts: number;
  timeoutMinutes: number;
  autoCommit: boolean;
  maxChars: number;
};

type Verdict = { verdict: "pass" | "fail"; reason: string; fix_task: string };

type Status = { approved: boolean; attempts: number; lastVerdict?: string };

type RunResult = { code: number | null; out: string; timedOut: boolean };

// ---------- small helpers ----------

const APP_DIR = process.cwd();

function loadDotEnv(file: string): void {
  if (!fs.existsSync(file)) return;
  for (const line of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
    if (m && !line.trim().startsWith("#") && process.env[m[1]] === undefined) {
      process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
    }
  }
}

function loadConfig(): Config {
  const file = path.resolve(APP_DIR, "config.json");
  if (!fs.existsSync(file)) die(`config.json not found in ${APP_DIR}`);
  const cfg = JSON.parse(fs.readFileSync(file, "utf8")) as Config;
  cfg.projectDir = path.resolve(APP_DIR, cfg.projectDir);
  cfg.phasesDir = path.resolve(APP_DIR, cfg.phasesDir);
  return cfg;
}

function die(msg: string): never {
  console.error(`\nERROR: ${msg}`);
  process.exit(1);
}

function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  const half = Math.floor(max / 2);
  return `${text.slice(0, half)}\n\n...[truncated ${text.length - max} characters]...\n\n${text.slice(-half)}`;
}

function readText(file: string): string {
  return fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "";
}

function writeText(file: string, text: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text, "utf8");
}

function quoteForWindows(arg: string): string {
  return /[\s"]/.test(arg) ? `"${arg.replace(/"/g, '\\"')}"` : arg;
}

/** Run a program with an argument list (no shell parsing of prompts). */
function runProgram(
  command: string,
  args: string[],
  cwd: string,
  timeoutMs: number,
): Promise<RunResult> {
  return new Promise((resolve) => {
    const isWin = process.platform === "win32";
    const child = spawn(command, isWin ? args.map(quoteForWindows) : args, {
      cwd,
      shell: isWin, // .cmd shims on Windows need a shell
      stdio: ["ignore", "pipe", "pipe"],
    });
    let out = "";
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
    }, timeoutMs);
    child.stdout.on("data", (d) => (out += d.toString()));
    child.stderr.on("data", (d) => (out += d.toString()));
    child.on("error", (e) => {
      clearTimeout(timer);
      resolve({ code: null, out: out + `\n[spawn error] ${e.message}`, timedOut });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code, out, timedOut });
    });
  });
}

/** Run a full shell command line (used for your check commands and git). */
function runShell(commandLine: string, cwd: string, timeoutMs: number): Promise<RunResult> {
  return new Promise((resolve) => {
    const child = spawn(commandLine, { cwd, shell: true, stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
    }, timeoutMs);
    child.stdout.on("data", (d) => (out += d.toString()));
    child.stderr.on("data", (d) => (out += d.toString()));
    child.on("error", (e) => {
      clearTimeout(timer);
      resolve({ code: null, out: out + `\n[spawn error] ${e.message}`, timedOut });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code, out, timedOut });
    });
  });
}

/** Ask a question; if the input stream is closed, behave like "quit". */
async function ask(rl: readline.Interface, prompt: string): Promise<string> {
  try {
    return await rl.question(prompt);
  } catch {
    return "q";
  }
}

// ---------- the pieces of the loop ----------

const REPORT_INSTRUCTIONS = `

---
When you are finished, end your answer with a report using exactly these headings:
## Summary
## Files changed
## Commands run and results
## Known issues or deviations from the instructions above
Be honest: list anything you did not finish or could not verify.`;

/** Write the prompt to a file and hand it to OpenCode as an attachment. */
async function runWorker(
  role: "coder" | "auditor",
  w: Worker,
  prompt: string,
  cfg: Config,
  runDir: string,
  tag: string,
): Promise<RunResult> {
  const promptFile = path.join(runDir, `${tag}.${role}.prompt.md`);
  writeText(promptFile, prompt);
  const args = [
    "run",
    "Follow the instructions in the attached file exactly.",
    "--model",
    w.model,
    ...(w.agent ? ["--agent", w.agent] : []),
    "--file",
    promptFile,
  ];
  console.log(`  -> running ${role} (${w.model}${w.agent ? `, agent ${w.agent}` : ""}) ...`);
  const res = await runProgram(w.command, args, cfg.projectDir, cfg.timeoutMinutes * 60_000);
  writeText(path.join(runDir, `${tag}.${role}.report.md`), res.out);
  return res;
}

async function runChecks(
  cfg: Config,
): Promise<{ allPassed: boolean; text: string }> {
  let allPassed = true;
  let text = "";
  for (const cmd of cfg.checkCommands) {
    console.log(`  -> check: ${cmd}`);
    const r = await runShell(cmd, cfg.projectDir, cfg.timeoutMinutes * 60_000);
    const ok = r.code === 0 && !r.timedOut;
    if (!ok) allPassed = false;
    text += `\n### $ ${cmd}\nexit code: ${r.code}${r.timedOut ? " (TIMED OUT)" : ""}\n${truncate(r.out, 6000)}\n`;
  }
  if (cfg.checkCommands.length === 0) text = "(no automated checks configured)";
  return { allPassed, text };
}

async function gitSnapshot(cfg: Config): Promise<string> {
  const t = 60_000;
  await runShell("git add -N .", cfg.projectDir, t); // make new files show up in the diff
  const status = await runShell("git status --short", cfg.projectDir, t);
  const diff = await runShell("git diff HEAD", cfg.projectDir, t);
  return `git status --short:\n${status.out}\n\ngit diff HEAD:\n${truncate(diff.out, cfg.maxChars)}`;
}

async function askController(
  cfg: Config,
  criteria: string,
  auditReport: string,
  checks: string,
): Promise<Verdict> {
  const key = process.env[cfg.controller.apiKeyEnv];
  if (!key) die(`Environment variable ${cfg.controller.apiKeyEnv} is not set (see .env.example).`);

  const system =
    "You are the controller of a phased software project. Decide whether the current phase PASSES " +
    "its acceptance criteria. Base your decision on the independent audit report and the automated " +
    "check results, not on the coder's own claims. Reply with ONLY a JSON object, no markdown: " +
    '{"verdict":"pass"|"fail","reason":"short explanation","fix_task":"if fail: a precise, ' +
    'actionable task for the coder; if pass: empty string"}';
  const user =
    `## Acceptance criteria\n${truncate(criteria, cfg.maxChars)}\n\n` +
    `## Automated check results\n${truncate(checks, cfg.maxChars)}\n\n` +
    `## Independent audit report\n${truncate(auditReport, cfg.maxChars)}`;

  const res = await fetch(`${cfg.controller.baseUrl.replace(/\/$/, "")}/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
    body: JSON.stringify({
      model: cfg.controller.model,
      temperature: 0,
      messages: [
        { role: "system", content: system },
        { role: "user", content: user },
      ],
    }),
  });
  if (!res.ok) throw new Error(`Controller API error ${res.status}: ${await res.text()}`);
  const data = (await res.json()) as { choices?: { message?: { content?: string } }[] };
  const raw = data.choices?.[0]?.message?.content ?? "";
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start < 0 || end < start) throw new Error(`Controller returned no JSON:\n${raw}`);
  const parsed = JSON.parse(raw.slice(start, end + 1)) as Partial<Verdict>;
  return {
    verdict: parsed.verdict === "pass" ? "pass" : "fail", // anything unclear counts as fail
    reason: String(parsed.reason ?? ""),
    fix_task: String(parsed.fix_task ?? ""),
  };
}

// ---------- phases ----------

function listPhases(cfg: Config): string[] {
  if (!fs.existsSync(cfg.phasesDir)) die(`phases folder not found: ${cfg.phasesDir}`);
  return fs
    .readdirSync(cfg.phasesDir, { withFileTypes: true })
    .filter((d) => d.isDirectory() && /^phase-\d+/i.test(d.name))
    .map((d) => d.name)
    .sort((a, b) => parseInt(a.split("-")[1], 10) - parseInt(b.split("-")[1], 10));
}

function readStatus(dir: string): Status {
  const f = path.join(dir, "status.json");
  return fs.existsSync(f)
    ? (JSON.parse(fs.readFileSync(f, "utf8")) as Status)
    : { approved: false, attempts: 0 };
}

const writeStatus = (dir: string, s: Status) =>
  writeText(path.join(dir, "status.json"), JSON.stringify(s, null, 2));

async function runPhase(name: string, cfg: Config, rl: readline.Interface): Promise<boolean> {
  const dir = path.join(cfg.phasesDir, name);
  const runDir = path.join(dir, "runs");
  const coderCommand = readText(path.join(dir, "coder_command.md"));
  const auditCommand = readText(path.join(dir, "audit_command.md"));
  const criteria = readText(path.join(dir, "criteria.md"));
  if (!coderCommand) die(`${name}/coder_command.md is missing or empty`);
  if (!auditCommand) die(`${name}/audit_command.md is missing or empty`);
  if (!criteria) die(`${name}/criteria.md is missing or empty`);

  const status = readStatus(dir);
  if (status.approved) {
    console.log(`\n[${name}] already approved - skipping.`);
    return true;
  }

  console.log(`\n==================== ${name} ====================`);
  let fixTask = "";

  for (let attempt = 1; attempt <= cfg.maxAttempts; attempt++) {
    const tag = `attempt-${attempt}`;
    status.attempts += 1;
    writeStatus(dir, status);
    console.log(`\n[${name}] attempt ${attempt}/${cfg.maxAttempts}`);

    // 1) coder
    const coderPrompt =
      coderCommand +
      (fixTask ? `\n\n---\n## Fix task from review (attempt ${attempt})\n${fixTask}\n` : "") +
      REPORT_INSTRUCTIONS;
    const coder = await runWorker("coder", cfg.coder, coderPrompt, cfg, runDir, tag);
    if (coder.code !== 0 || coder.timedOut) {
      fixTask =
        `The previous coder run ${coder.timedOut ? "timed out" : `exited with code ${coder.code}`}. ` +
        `Output tail:\n${truncate(coder.out, 4000)}\nContinue the work and finish the phase.`;
      console.log("  coder run failed - will retry.");
      continue;
    }

    // 2) automated checks (run by this app, not by the AI)
    const checks = await runChecks(cfg);
    writeText(path.join(runDir, `${tag}.checks.txt`), checks.text);
    if (!checks.allPassed) {
      fixTask = `Automated checks failed. Fix the problems below, then re-run the checks.\n${checks.text}`;
      console.log("  automated checks FAILED - sending back to coder (auditor skipped).");
      continue;
    }

    // 3) auditor (different model)
    const snapshot = await gitSnapshot(cfg);
    const auditPrompt =
      `${auditCommand}\n\n---\n## Acceptance criteria for this phase\n${criteria}\n\n` +
      `## Coder report\n${truncate(coder.out, cfg.maxChars)}\n\n` +
      `## Automated check results (run by the orchestrator)\n${checks.text}\n\n` +
      `## Repository changes\n${snapshot}\n\n---\n` +
      `You are an independent auditor. Do NOT modify any files. Verify claims yourself by reading the code ` +
      `and running read-only commands. For each acceptance criterion give PASS or FAIL with evidence, ` +
      `then list concrete problems and an overall recommendation.`;
    const audit = await runWorker("auditor", cfg.auditor, auditPrompt, cfg, runDir, tag);
    if (audit.code !== 0 || audit.timedOut) {
      console.log("  auditor run failed - will retry the whole attempt.");
      fixTask = "";
      continue;
    }

    // 4) controller AI decides pass/fail
    console.log("  -> asking controller AI for a verdict ...");
    const verdict = await askController(cfg, criteria, audit.out, checks.text);
    writeText(path.join(runDir, `${tag}.verdict.json`), JSON.stringify(verdict, null, 2));
    status.lastVerdict = verdict.verdict;
    writeStatus(dir, status);

    if (verdict.verdict === "fail") {
      console.log(`  verdict: FAIL - ${verdict.reason}`);
      fixTask = verdict.fix_task || verdict.reason;
      continue;
    }

    // 5) human approval
    console.log(`\n  verdict: PASS - ${verdict.reason}`);
    console.log(`  Reports are in: ${runDir}`);
    console.log(`    ${tag}.coder.report.md / ${tag}.checks.txt / ${tag}.auditor.report.md`);
    for (;;) {
      const ans = (await ask(rl, "\n  [a]pprove, [r]eject with feedback, or [q]uit? ")).trim().toLowerCase();
      if (ans === "a") {
        status.approved = true;
        writeStatus(dir, status);
        if (cfg.autoCommit) {
          await runShell("git add -A", cfg.projectDir, 60_000);
          await runShell(`git commit -m "${name} approved"`, cfg.projectDir, 60_000);
          await runShell(`git tag ${name}-approved`, cfg.projectDir, 60_000);
        }
        console.log(`  ${name} approved.`);
        return true;
      }
      if (ans === "r") {
        const fb = (await ask(rl, "  Your feedback for the coder: ")).trim();
        fixTask = `Human reviewer feedback:\n${fb}`;
        break; // next attempt
      }
      if (ans === "q") {
        console.log("  Stopped by user. Run again to continue.");
        return false;
      }
    }
  }

  console.log(`\n[${name}] not approved after ${cfg.maxAttempts} attempts. Reports are in ${runDir}`);
  console.log("Fix the phase files or the code by hand, then run again.");
  return false;
}

// ---------- main ----------

async function main(): Promise<void> {
  loadDotEnv(path.join(APP_DIR, ".env"));
  const cfg = loadConfig();

  if (!fs.existsSync(path.join(cfg.projectDir, ".git"))) {
    die(`projectDir must be a git repository: ${cfg.projectDir}\n(run "git init" there and make a first commit)`);
  }

  const phases = listPhases(cfg);
  const only = process.argv[2]; // optional: npm start -- phase-2
  const todo = only ? phases.filter((p) => p === only) : phases;
  if (todo.length === 0) die(only ? `No such phase: ${only}` : "No phase-N folders found.");

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    for (const name of todo) {
      const ok = await runPhase(name, cfg, rl);
      if (!ok) return;
    }
    console.log("\nAll phases approved.");
  } finally {
    rl.close();
  }
}

main().catch((e) => die(e instanceof Error ? e.message : String(e)));
