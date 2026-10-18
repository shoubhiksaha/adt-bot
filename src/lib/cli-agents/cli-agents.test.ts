import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import type { Message } from "../types";
import { Transcript, type CliEvent } from "./client";
import { buildCliPrompt, cliAgentOf, planTurn } from "./provider";
import { delegateRisk } from "./tool";

const require = createRequire(import.meta.url);
const cli = require("../../../electron/features/50-cli-agents.cjs")._test;

const fixture = (name: string) => readFileSync(join(__dirname, "__fixtures__", name), "utf8");

/** Feeds a recorded stream through the agent's parser, like the run loop does. */
function parse(agent: string, text: string): CliEvent[] {
  const parser = cli.createParser(agent);
  return [...text.split("\n").flatMap((line: string) => parser.line(line)), ...parser.finish()];
}

const textOf = (events: CliEvent[]) => events.flatMap((e) => (e.type === "text" ? [e.text] : [])).join("");

describe("stream parsers", () => {
  it("Claude Code stream-json: session, deltas without duplicates, tools, result", () => {
    const events = parse("claude", fixture("claude-stream.jsonl"));
    expect(events[0]).toEqual({ type: "session", sessionId: "5f0c7d0e-2b1a-4c1e-9d55-3c2b1e0a9f11", model: "claude-sonnet-4-5-20250929" });
    // Text arrived as deltas; the repeated full assistant messages must not double it.
    expect(textOf(events)).toBe("I'll list the files first.There is one file: notes.txt.");
    const tools = events.filter((e) => e.type === "tool");
    expect(tools).toEqual([
      { type: "tool", phase: "start", id: "toolu_01X", name: "Bash", summary: "ls -la" },
      expect.objectContaining({ type: "tool", phase: "end", id: "toolu_01X", name: "Bash", isError: false }),
    ]);
    expect((tools[1] as { output: string }).output).toContain("notes.txt");
    const result = events.find((e) => e.type === "result");
    expect(result).toEqual({
      type: "result",
      text: "There is one file: notes.txt.",
      sessionId: "5f0c7d0e-2b1a-4c1e-9d55-3c2b1e0a9f11",
      isError: false,
      costUsd: 0.01234,
      durationMs: 5321,
      turns: 2,
    });
  });

  it("Claude Code without partial messages still yields the text once", () => {
    const lines = fixture("claude-stream.jsonl")
      .split("\n")
      .filter((l) => !l.includes('"stream_event"'))
      .join("\n");
    expect(textOf(parse("claude", lines))).toBe("I'll list the files first.There is one file: notes.txt.");
  });

  it("Claude Code errors: API error messages and failed results", () => {
    const events = parse(
      "claude",
      [
        JSON.stringify({ type: "assistant", is_api_error_message: true, message: { id: "m", content: [{ type: "text", text: "Invalid API key · Please run /login" }] } }),
        JSON.stringify({ type: "result", subtype: "error_max_turns", is_error: true, result: "", session_id: "s1" }),
      ].join("\n"),
    );
    expect(events[0]).toEqual({ type: "error", message: "Invalid API key · Please run /login" });
    expect(events[1]).toMatchObject({ type: "result", isError: true, text: "Claude Code stopped (error_max_turns)" });
  });

  it("Codex exec --json: thread id, reasoning, command, file change, final message", () => {
    const events = parse("codex", fixture("codex-exec.jsonl"));
    expect(events[0]).toEqual({ type: "session", sessionId: "0199a213-81c0-7800-8aa1-bbab2a035a53" });
    expect(events).toContainEqual({ type: "reasoning", text: "**Listing files** I should run ls.\n" });
    expect(events).toContainEqual({ type: "tool", phase: "start", id: "item_1", name: "shell", summary: "bash -lc ls" });
    expect(events).toContainEqual({ type: "tool", phase: "end", id: "item_1", name: "shell", summary: "bash -lc ls", output: "README.md\nsrc\n", isError: false });
    expect(events).toContainEqual({ type: "tool", phase: "end", id: "item_2", name: "edit", summary: "add src/hello.ts", isError: false });
    expect(textOf(events)).toBe("Added src/hello.ts.\n");
    expect(events.filter((e) => e.type === "result")).toEqual([{ type: "result", text: "Added src/hello.ts." }]);
  });

  it("Codex failures and the older msg envelope", () => {
    expect(parse("codex", '{"type":"turn.failed","error":{"message":"stream disconnected"}}')).toContainEqual({ type: "error", message: "stream disconnected" });
    const old = parse(
      "codex",
      ['{"id":"0","msg":{"type":"session_configured","session_id":"abc","model":"gpt-5-codex"}}', '{"id":"1","msg":{"type":"task_complete","last_agent_message":"Done."}}'].join("\n"),
    );
    expect(old).toEqual([
      { type: "session", sessionId: "abc", model: "gpt-5-codex" },
      { type: "result", text: "Done." },
    ]);
  });

  it("Gemini CLI stream-json", () => {
    const events = parse("gemini", fixture("gemini-stream.jsonl"));
    expect(events[0]).toEqual({ type: "session", sessionId: "c3a1e2f0-1111-2222-3333-444455556666", model: "gemini-2.5-pro" });
    expect(textOf(events)).toBe("There are two files."); // the echoed user message is skipped
    expect(events).toContainEqual({ type: "tool", phase: "start", id: "list_directory-1", name: "list_directory", summary: "." });
    expect(events).toContainEqual({ type: "tool", phase: "end", id: "list_directory-1", name: "list_directory", output: "Listed 2 item(s).", isError: false });
    expect(events.find((e) => e.type === "result")).toEqual({ type: "result", text: "There are two files.", isError: false });
  });

  it("Gemini CLI plain-text output (older builds) becomes text", () => {
    expect(textOf(parse("gemini", "Hello\nworld"))).toBe("Hello\nworld\n");
  });

  it("OpenCode run --format json", () => {
    const events = parse("opencode", fixture("opencode-run.jsonl"));
    expect(events[0]).toEqual({ type: "session", sessionId: "ses_6a1b2c3d4e5fABCDEF" });
    expect(events).toContainEqual({ type: "tool", phase: "end", id: "call_1", name: "bash", summary: "ls", output: "README.md\n", isError: false });
    expect(textOf(events)).toBe("The folder has a README.");
    expect(events[events.length - 1]).toEqual({ type: "result", text: "The folder has a README.", sessionId: "ses_6a1b2c3d4e5fABCDEF", costUsd: 0.0021 });
    expect(parse("opencode", '{"type":"error","error":{"name":"ProviderAuthError","data":{"message":"No API key"}}}')).toContainEqual({ type: "error", message: "No API key" });
  });

  it("Aider: plain text, JSON-looking lines included", () => {
    const events = parse("aider", 'Applied edit to app.py\n{"not":"an event"}');
    expect(textOf(events)).toBe('Applied edit to app.py\n{"not":"an event"}\n');
    expect(events[events.length - 1]).toEqual({ type: "result", text: 'Applied edit to app.py\n{"not":"an event"}' });
  });

  it("non-JSON noise from JSON CLIs is a log line, never text", () => {
    expect(parse("claude", "Warning: something")).toEqual([{ type: "log", text: "Warning: something" }]);
    expect(parse("claude", "{broken json")).toEqual([{ type: "log", text: "{broken json" }]);
  });
});

describe("argument building", () => {
  const nasty = '"; rm -rf ~; echo $(whoami) `id` && --dangerously-skip-permissions';

  it("Claude: prompt goes over stdin, never into argv", () => {
    const { args, stdin } = cli.buildInvocation({ agent: "claude", prompt: nasty });
    expect(args).toEqual(["-p", "--output-format", "stream-json", "--verbose", "--include-partial-messages"]);
    expect(stdin).toBe(nasty);
    expect(args.join(" ")).not.toContain("rm -rf");
  });

  it("Claude: resume, model, permission modes and system prompt", () => {
    const { args } = cli.buildInvocation({
      agent: "claude",
      prompt: "x",
      resumeSession: "5f0c7d0e-2b1a-4c1e-9d55-3c2b1e0a9f11",
      model: "opus",
      permission: "edit",
      system: "-- be brief",
    });
    expect(args).toEqual(expect.arrayContaining(["--resume", "5f0c7d0e-2b1a-4c1e-9d55-3c2b1e0a9f11", "--model", "opus", "--permission-mode", "acceptEdits"]));
    expect(args).toContain("--append-system-prompt=-- be brief");
    expect(cli.buildInvocation({ agent: "claude", prompt: "x", permission: "plan" }).args).toEqual(expect.arrayContaining(["--permission-mode", "plan"]));
    expect(cli.buildInvocation({ agent: "claude", prompt: "x", permission: "bypass" }).args).toContain("--dangerously-skip-permissions");
    expect(cli.buildInvocation({ agent: "claude", prompt: "x", model: "default" }).args).not.toContain("--model");
    expect(cli.buildInvocation({ agent: "claude", prompt: "x", light: true }).args).toEqual(expect.arrayContaining(["--tools", "", "--no-session-persistence"]));
  });

  it("Codex reads the prompt from stdin ('-'); resume is a subcommand", () => {
    const fresh = cli.buildInvocation({ agent: "codex", prompt: nasty, permission: "plan" });
    expect(fresh.args).toEqual(["exec", "--json", "--skip-git-repo-check", "--sandbox", "read-only", "-"]);
    expect(fresh.stdin).toBe(nasty);
    const resumed = cli.buildInvocation({ agent: "codex", prompt: "more", resumeSession: "0199a213-81c0-7800-8aa1-bbab2a035a53", permission: "bypass" });
    expect(resumed.args).toEqual(["exec", "--json", "--skip-git-repo-check", "--dangerously-bypass-approvals-and-sandbox", "resume", "0199a213-81c0-7800-8aa1-bbab2a035a53", "-"]);
  });

  it("Gemini, OpenCode, Aider: free text can't become a flag", () => {
    const gemini = cli.buildInvocation({ agent: "gemini", prompt: "--yolo" });
    expect(gemini.args).toEqual(["--output-format", "stream-json", "--prompt=--yolo"]);
    expect(gemini.args).not.toContain("--yolo");
    expect(gemini.stdin).toBeNull();
    const opencode = cli.buildInvocation({ agent: "opencode", prompt: "--help me", resumeSession: "ses_abc" });
    expect(opencode.args).toEqual(["run", "--format", "json", "--session", "ses_abc", " --help me"]);
    const aider = cli.buildInvocation({ agent: "aider", prompt: "-x", permission: "edit" });
    expect(aider.args).toEqual(["--no-pretty", "--no-stream", "--no-check-update", "--yes-always", "--message=-x"]);
  });

  it("rejects unsafe model names / session ids, unknown agents and modes, empty tasks", () => {
    for (const bad of ["--dangerously-skip-permissions", "a b", "x;rm -rf /", "$(id)", "-r"]) {
      expect(() => cli.buildInvocation({ agent: "claude", prompt: "x", resumeSession: bad })).toThrow(/Invalid session id/);
      expect(() => cli.buildInvocation({ agent: "claude", prompt: "x", model: bad })).toThrow(/Invalid model/);
    }
    expect(() => cli.buildInvocation({ agent: "bash", prompt: "x" })).toThrow(/Unknown coding agent/);
    expect(() => cli.buildInvocation({ agent: "claude", prompt: "x", permission: "yolo" })).toThrow(/permission/);
    expect(() => cli.buildInvocation({ agent: "claude", prompt: "   " })).toThrow(/empty/);
  });
});

describe("detection helpers", () => {
  const dir = mkdtempSync(join(tmpdir(), "adt-cli-test-"));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it("parses the login shell's env dump and versions", () => {
    const dump = "Last login: today\nzsh: some rc noise\n\n__adt_env__\nPATH=/opt/homebrew/bin:/usr/bin\nHOME=/Users/me\nSECRET_TOKEN=abc\nNVM_DIR=/Users/me/.nvm\n";
    expect(cli.parseEnvOutput(dump)).toEqual({ PATH: "/opt/homebrew/bin:/usr/bin", NVM_DIR: "/Users/me/.nvm" });
    expect(cli.parseEnvOutput("no path here")).toBeNull();
    expect(cli.parseVersion("2.1.292 (Claude Code)")).toBe("2.1.292");
    expect(cli.parseVersion("codex-cli 0.46.0")).toBe("0.46.0");
    expect(cli.parseVersion("aider 0.86.1")).toBe("0.86.1");
    expect(cli.parseVersion("opencode v1.0.0-beta.3")).toBe("1.0.0-beta.3");
    expect(cli.parseVersion("command not found")).toBeNull();
    expect(cli.mergePaths("/a:/b", "/b:/c", "")).toBe("/a:/b:/c");
  });

  it("finds executables on PATH without a shell", () => {
    const exe = join(dir, "fakeagent");
    writeFileSync(exe, "#!/bin/sh\necho 1.2.3\n");
    chmodSync(exe, 0o755);
    writeFileSync(join(dir, "notexec"), "x");
    expect(cli.which("fakeagent", `/nonexistent:${dir}`)).toBe(exe);
    expect(cli.which("notexec", dir)).toBeNull();
    expect(cli.which("missing-agent", dir)).toBeNull();
  });

  it("splits lines and drops over-long ones", () => {
    const splitter = new cli.LineSplitter();
    expect(splitter.push("a\nb")).toEqual(["a"]);
    expect(splitter.push("c\n")).toEqual(["bc"]);
    splitter.push("x".repeat(1_100_000));
    expect(splitter.push("tail\nnext\n")).toEqual(["next"]);
    expect(splitter.push("end")).toEqual([]);
    expect(splitter.flush()).toEqual(["end"]);
  });

  it("runs a (fake) CLI with the prompt on stdin and streams parsed events", async () => {
    const fake = join(dir, "fake-claude");
    const lines = fixture("claude-stream.jsonl").trim().split("\n");
    // Echo the received prompt to stderr, then replay a recorded stream.
    writeFileSync(
      fake,
      `#!/usr/bin/env node
let input = "";
process.stdin.on("data", (c) => (input += c));
process.stdin.on("end", () => {
  process.stderr.write("got:" + input.trim() + "\\n");
  for (const line of ${JSON.stringify(lines)}) process.stdout.write(line + "\\n");
});
`,
    );
    chmodSync(fake, 0o755);
    const events: CliEvent[] = [];
    const summary = await cli.runAgent({ agent: "claude", prompt: "hi; $(id)", cwd: dir, binary: fake, env: process.env }, (e: CliEvent) => events.push(e));
    expect(summary).toMatchObject({ ok: true, code: 0, sessionId: "5f0c7d0e-2b1a-4c1e-9d55-3c2b1e0a9f11", result: "There is one file: notes.txt.", cwd: dir });
    expect(events).toContainEqual({ type: "log", text: "got:hi; $(id)" });
    expect(textOf(events)).toBe("I'll list the files first.There is one file: notes.txt.");
  });

  it("cancel kills the run; a missing folder fails cleanly", async () => {
    const slow = join(dir, "slow-claude");
    writeFileSync(slow, "#!/bin/sh\nsleep 30 &\nwait\n");
    chmodSync(slow, 0o755);
    const pending = cli.runAgent({ runId: "c1", agent: "claude", prompt: "x", cwd: dir, binary: slow, env: process.env });
    await new Promise((r) => setTimeout(r, 300));
    expect(cli.cancel("c1")).toEqual({ ok: true });
    const summary = await pending;
    expect(summary).toMatchObject({ ok: false, cancelled: true, error: "Cancelled." });
    const missing = await cli.runAgent({ agent: "claude", prompt: "x", cwd: join(dir, "nope"), binary: slow, env: process.env });
    expect(missing.error).toMatch(/Folder not found/);
  });
});

describe("renderer side", () => {
  it("bypass permission makes the tool destructive (always asks)", () => {
    expect(delegateRisk({ agent: "claude", task: "x" })).toBe("external");
    expect(delegateRisk({ agent: "claude", task: "x", permission: "edit" })).toBe("external");
    expect(delegateRisk({ agent: "claude", task: "x", permission: "bypass" })).toBe("destructive");
  });

  it("builds a terminal transcript", () => {
    const t = new Transcript();
    const events = parse("claude", fixture("claude-stream.jsonl"));
    events.forEach((e) => t.push(e));
    const text = t.toString();
    expect(text).toContain("· session 5f0c7d0e");
    expect(text).toContain("I'll list the files first.\n⏺ Bash(ls -la)");
    expect(text).toContain("⎿ total 8");
    expect(text).toContain("· done · 2 turns · 5.3 s · $0.0123");
  });

  const msg = (id: string, role: "user" | "assistant", content: string): Message => ({ id, role, content, createdAt: 1 });

  it("provider: maps cli:<agent>, recaps history, resumes with only the new turn", () => {
    expect(cliAgentOf({ baseUrl: "cli:claude", presetId: "cli-claude" })).toBe("claude");
    expect(cliAgentOf({ baseUrl: "", presetId: "cli-codex" })).toBe("codex");
    expect(() => cliAgentOf({ baseUrl: "cli:bash", presetId: "x" })).toThrow();
    const history = [msg("1", "user", "Hi"), msg("2", "assistant", "Hello!"), msg("3", "user", "Write a haiku")];
    expect(buildCliPrompt([history[0]])).toBe("Hi");
    const prompt = buildCliPrompt(history);
    expect(prompt).toContain("User: Hi\n\nAssistant: Hello!");
    expect(prompt.endsWith("Current message:\nWrite a haiku")).toBe(true);
    expect(planTurn(history, { sessionId: "s1", lastUserId: "1" })).toEqual({ prompt: "Write a haiku", resumeSession: "s1" });
    // Regenerating the same message, or an unknown history, starts fresh with a recap.
    expect(planTurn(history, { sessionId: "s1", lastUserId: "3" }).resumeSession).toBeUndefined();
    expect(planTurn(history, { sessionId: "s1", lastUserId: "zzz" }).resumeSession).toBeUndefined();
  });
});
