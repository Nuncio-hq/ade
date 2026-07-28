import { describe, expect, it } from "vitest";
import {
  deriveInlineCommandCall,
  deriveReadableCommandDisplay,
  deriveReadableToolTitle,
  deriveNuncioADEMcpToolTitle,
  extractWebFetchUrl,
  isInspectCommand,
  normalizeCompactToolLabel,
  resolveCommandVisualKind,
  sanitizeNuncioADEMcpToolPreview,
} from "./toolCallLabel";

describe("extractWebFetchUrl", () => {
  it("pulls the url out of a WebFetch argument summary", () => {
    expect(
      extractWebFetchUrl({
        toolName: "WebFetch",
        detail: 'WebFetch: {"url":"https://ui.shadcn.com/docs/components","prompt":"List EVER..."}',
      }),
    ).toBe("https://ui.shadcn.com/docs/components");
  });

  it("recognizes alternate fetch tool names and the uri field", () => {
    expect(
      extractWebFetchUrl({
        toolName: "web_fetch",
        detail: '{"uri":"https://example.com/path"}',
      }),
    ).toBe("https://example.com/path");
  });

  it("falls back to a bare URL token when there is no json field", () => {
    expect(extractWebFetchUrl({ toolName: "fetch", detail: "Fetching https://example.com." })).toBe(
      "https://example.com",
    );
  });

  it("ignores non-fetch tools", () => {
    expect(
      extractWebFetchUrl({ toolName: "Read", detail: '{"url":"https://example.com"}' }),
    ).toBeNull();
  });

  it("ignores non-http(s) and missing urls", () => {
    expect(
      extractWebFetchUrl({ toolName: "WebFetch", detail: '{"url":"ftp://example.com"}' }),
    ).toBeNull();
    expect(extractWebFetchUrl({ toolName: "WebFetch", detail: '{"prompt":"hi"}' })).toBeNull();
    expect(extractWebFetchUrl({ toolName: "WebFetch", detail: undefined })).toBeNull();
  });
});

describe("normalizeCompactToolLabel", () => {
  it("removes trailing completion wording", () => {
    expect(normalizeCompactToolLabel("Tool call completed")).toBe("Tool call");
    expect(normalizeCompactToolLabel("Ran command done")).toBe("Ran command");
    expect(normalizeCompactToolLabel("Ran command started")).toBe("Ran command");
  });
});

describe("deriveNuncioADEMcpToolTitle", () => {
  it("has intentional running and completed copy for every NuncioADE gateway action", () => {
    const cases = [
      ["nuncioade_context", "NuncioADE is checking its context", "NuncioADE checked its context"],
      [
        "nuncioade_capabilities",
        "NuncioADE is checking available agents",
        "NuncioADE checked available agents",
      ],
      ["nuncioade_list_projects", "NuncioADE is listing projects", "NuncioADE listed projects"],
      ["nuncioade_list_threads", "NuncioADE is listing threads", "NuncioADE listed threads"],
      ["nuncioade_read_thread", "NuncioADE is reading a thread", "NuncioADE read a thread"],
      [
        "nuncioade_read_thread_activity",
        "NuncioADE is reading thread activity",
        "NuncioADE read thread activity",
      ],
      [
        "nuncioade_read_thread_events",
        "NuncioADE is reading thread events",
        "NuncioADE read thread events",
      ],
      [
        "nuncioade_read_thread_runtime_events",
        "NuncioADE is reading thread runtime events",
        "NuncioADE read thread runtime events",
      ],
      [
        "nuncioade_diagnose_thread",
        "NuncioADE is diagnosing a thread",
        "NuncioADE diagnosed a thread",
      ],
      ["nuncioade_create_thread", "NuncioADE is creating a thread", "NuncioADE created a thread"],
      ["nuncioade_create_threads", "NuncioADE is creating threads", "NuncioADE created threads"],
      [
        "nuncioade_wait_for_threads",
        "NuncioADE is waiting for threads",
        "NuncioADE finished waiting for threads",
      ],
      ["nuncioade_send_message", "NuncioADE is sending a message", "NuncioADE sent a message"],
      [
        "nuncioade_interrupt_thread",
        "NuncioADE is interrupting a thread",
        "NuncioADE interrupted a thread",
      ],
      [
        "nuncioade_set_thread_title",
        "NuncioADE is renaming a thread",
        "NuncioADE renamed a thread",
      ],
      [
        "nuncioade_set_thread_archived",
        "NuncioADE is updating a thread",
        "NuncioADE updated a thread",
      ],
      [
        "nuncioade_create_automation",
        "NuncioADE is creating an automation",
        "NuncioADE created an automation",
      ],
      [
        "nuncioade_list_automations",
        "NuncioADE is listing automations",
        "NuncioADE listed automations",
      ],
      [
        "nuncioade_cancel_automation",
        "NuncioADE is stopping an automation",
        "NuncioADE stopped an automation",
      ],
      [
        "nuncioade_overview",
        "NuncioADE is gathering an overview",
        "NuncioADE gathered an overview",
      ],
      [
        "nuncioade_list_allowed_projects",
        "NuncioADE is listing allowed projects",
        "NuncioADE listed allowed projects",
      ],
      ["nuncioade_create_task", "NuncioADE is creating a task", "NuncioADE created a task"],
      [
        "nuncioade_wait_for_task",
        "NuncioADE is waiting for a task",
        "NuncioADE finished waiting for a task",
      ],
      ["nuncioade_read_task", "NuncioADE is reading a task", "NuncioADE read a task"],
    ] as const;

    for (const [toolName, running, completed] of cases) {
      expect(deriveNuncioADEMcpToolTitle({ toolName, status: "running" })).toBe(running);
      expect(deriveNuncioADEMcpToolTitle({ toolName, status: "completed" })).toBe(completed);
    }

    expect(
      deriveNuncioADEMcpToolTitle({
        toolName: "nuncioade_create_threads",
        status: "failed",
      }),
    ).toBe("NuncioADE couldn't create threads");
    expect(
      deriveNuncioADEMcpToolTitle({
        toolName: "nuncioade_create_thread",
        status: "cancelled",
      }),
    ).toBe("NuncioADE stopped creating a thread");
  });

  it("turns provider-specific create-thread identifiers into activity sentences", () => {
    expect(
      deriveNuncioADEMcpToolTitle({
        toolName: "NuncioADE__nuncioade_create_thread",
        status: "running",
      }),
    ).toBe("NuncioADE is creating a thread");
    expect(
      deriveNuncioADEMcpToolTitle({
        toolName: "mcp__nuncioade__nuncioade_create_thread",
        status: "completed",
      }),
    ).toBe("NuncioADE created a thread");
  });

  it("recognizes bare and already-humanized NuncioADE tool names", () => {
    expect(
      deriveNuncioADEMcpToolTitle({ toolName: "nuncioade_send_message", status: "running" }),
    ).toBe("NuncioADE is sending a message");
    expect(
      deriveNuncioADEMcpToolTitle({
        title: "NuncioADE: NuncioADE List Threads",
        status: "completed",
      }),
    ).toBe("NuncioADE listed threads");
  });

  it("ignores tools from other MCP servers", () => {
    expect(
      deriveNuncioADEMcpToolTitle({
        toolName: "mcp__codex_apps__github_fetch_pr",
        status: "running",
      }),
    ).toBeNull();
  });

  it("keeps future NuncioADE actions branded without exposing raw identifiers", () => {
    expect(
      deriveNuncioADEMcpToolTitle({
        toolName: "mcp__nuncioade__nuncioade_delete_project",
        status: "running",
      }),
    ).toBe("NuncioADE is handling delete project");
    expect(
      deriveNuncioADEMcpToolTitle({
        toolName: "NuncioADE__nuncioade_delete_project",
        status: "completed",
      }),
    ).toBe("NuncioADE handled delete project");
    expect(
      deriveNuncioADEMcpToolTitle({
        toolName: "nuncioade_is_handling_delete_project",
        status: "completed",
      }),
    ).toBe("NuncioADE handled delete project");
  });

  it("does not reinterpret free text beginning with fallback status copy", () => {
    expect(
      deriveNuncioADEMcpToolTitle({
        title: "NuncioADE is handling delete project after recovery",
        status: "completed",
      }),
    ).toBeNull();
    expect(
      deriveNuncioADEMcpToolTitle({
        title: "NuncioADE handled delete project after recovery",
        status: "running",
      }),
    ).toBeNull();
    expect(
      deriveNuncioADEMcpToolTitle({
        title: "NuncioADE couldn't handle delete project after recovery",
        status: "failed",
      }),
    ).toBeNull();
  });

  it("leaves free-text activity summaries starting with NuncioADE untouched", () => {
    expect(
      deriveNuncioADEMcpToolTitle({
        title: "NuncioADE recovered a stale running state",
        status: "completed",
      }),
    ).toBeNull();
    expect(
      deriveNuncioADEMcpToolTitle({
        fallbackLabel: "NuncioADE restarted the provider session",
        status: "running",
      }),
    ).toBeNull();
  });

  it("removes transport identifiers without hiding meaningful NuncioADE details", () => {
    expect(
      sanitizeNuncioADEMcpToolPreview({
        preview: "NuncioADE__nuncioade_create_threads",
        heading: "NuncioADE created threads",
        status: "completed",
      }),
    ).toBeNull();
    expect(
      sanitizeNuncioADEMcpToolPreview({
        preview: 'Unexpected key "reasoningEffort" for Claude Agent',
        heading: "NuncioADE couldn't create threads",
        status: "failed",
      }),
    ).toBe('Unexpected key "reasoningEffort" for Claude Agent');
  });
});

describe("deriveReadableToolTitle", () => {
  it("humanizes search commands even when wrapped in shell -lc", () => {
    expect(
      deriveReadableToolTitle({
        title: "Ran command",
        fallbackLabel: "Ran command",
        itemType: "command_execution",
        requestKind: "command",
        command: `/bin/zsh -lc 'rg -n "tool call" apps/web/src'`,
      }),
    ).toBe("Searched");
  });

  it("humanizes file read commands", () => {
    expect(
      deriveReadableToolTitle({
        title: "Ran command",
        fallbackLabel: "Ran command",
        itemType: "command_execution",
        command: "sed -n '520,550p' apps/web/src/session-logic.ts",
      }),
    ).toBe("Read");
  });

  it("humanizes git status commands", () => {
    expect(
      deriveReadableToolTitle({
        title: "Ran command",
        fallbackLabel: "Ran command",
        itemType: "command_execution",
        command: "git status --short",
      }),
    ).toBe("Checked");
  });

  it("keeps explicit non-generic titles", () => {
    expect(
      deriveReadableToolTitle({
        title: "Bash",
        fallbackLabel: "Ran command",
        itemType: "command_execution",
        command: "echo hello",
      }),
    ).toBe("Bash");
  });

  it("extracts a descriptor from payload when the title is generic", () => {
    expect(
      deriveReadableToolTitle({
        title: "Tool call",
        fallbackLabel: "Tool call",
        itemType: "dynamic_tool_call",
        payload: {
          data: {
            item: {
              toolName: "mcp__xcodebuildmcp__list_sims",
            },
          },
        },
      }),
    ).toBe("Xcodebuildmcp: List Sims");
  });

  it("treats Cursor placeholder titles as generic", () => {
    expect(
      deriveReadableToolTitle({
        title: "Find",
        fallbackLabel: "Find",
        itemType: "dynamic_tool_call",
        payload: { data: { kind: "search" } },
      }),
    ).toBe("Search");

    expect(
      deriveReadableToolTitle({
        title: "Read File",
        fallbackLabel: "Read File",
        itemType: "dynamic_tool_call",
        payload: { data: { kind: "read" } },
      }),
    ).toBe("Read");
  });

  it("formats MCP identifiers into readable tool names", () => {
    expect(
      deriveReadableToolTitle({
        title: "MCP tool call",
        fallbackLabel: "MCP tool call",
        itemType: "mcp_tool_call",
        payload: {
          data: {
            toolName: "mcp__codex_apps__github_fetch_pr",
          },
        },
      }),
    ).toBe("Codex Apps: Github Fetch Pr");
  });

  it("formats structured MCP server/tool payloads into readable tool names", () => {
    expect(
      deriveReadableToolTitle({
        title: "MCP tool call",
        fallbackLabel: "MCP tool call",
        itemType: "mcp_tool_call",
        payload: {
          data: {
            item: {
              type: "mcpToolCall",
              server: "computer-use",
              tool: "get_app_state",
            },
          },
        },
      }),
    ).toBe("Computer Use: Get App State");
  });
});

describe("deriveReadableCommandDisplay", () => {
  it("extracts search targets without leaking the full shell wrapper inline", () => {
    expect(deriveReadableCommandDisplay(`/bin/zsh -lc 'rg -n "tool call" apps/web/src'`)).toEqual({
      verb: "Searched",
      target: "for tool call in web/src",
      fullCommand: `/bin/zsh -lc 'rg -n "tool call" apps/web/src'`,
    });
  });

  it("compacts file paths for read commands", () => {
    expect(
      deriveReadableCommandDisplay(
        "sed -n '520,550p' apps/web/src/components/chat/MessagesTimeline.tsx",
      ),
    ).toEqual({
      verb: "Read",
      target: "chat/MessagesTimeline.tsx",
      fullCommand: "sed -n '520,550p' apps/web/src/components/chat/MessagesTimeline.tsx",
    });
  });

  it("unwraps zsh shell wrappers around read commands", () => {
    expect(
      deriveReadableCommandDisplay(
        `/bin/zsh -lc "sed -n '240,520p' src/components/provider-card.tsx"`,
      ),
    ).toEqual({
      verb: "Read",
      target: "components/provider-card.tsx",
      fullCommand: `/bin/zsh -lc "sed -n '240,520p' src/components/provider-card.tsx"`,
    });
  });

  it("keeps quoted paths intact when shell wrappers include cd chaining", () => {
    expect(
      deriveReadableCommandDisplay(
        `zsh -lc "cd '/tmp/my app' && sed -n '1,260p' src/pages/overview.tsx"`,
      ),
    ).toEqual({
      verb: "Read",
      target: "pages/overview.tsx",
      fullCommand: `zsh -lc "cd '/tmp/my app' && sed -n '1,260p' src/pages/overview.tsx"`,
    });
  });

  it("does not discard real chained commands after a shell wrapper", () => {
    expect(
      deriveReadableCommandDisplay(
        `/bin/zsh -lc 'rm -f /tmp/test.log && bun run --cwd apps/server test'`,
      ),
    ).toEqual({
      verb: "Removed",
      target: "/tmp/test.log",
      fullCommand: `/bin/zsh -lc 'rm -f /tmp/test.log && bun run --cwd apps/server test'`,
    });
  });

  it("removes env and timeout wrappers from inline command summaries", () => {
    expect(
      deriveReadableCommandDisplay(
        "env -u NUNCIO_AUTH_TOKEN NUNCIO_PORT_OFFSET=3158 timeout 180s bun run dev",
        true,
      ),
    ).toEqual({
      verb: "Running",
      target: "bun run dev",
      fullCommand: "env -u NUNCIO_AUTH_TOKEN NUNCIO_PORT_OFFSET=3158 timeout 180s bun run dev",
    });
  });

  it("summarizes inline script commands without leaking the script body", () => {
    expect(
      deriveReadableCommandDisplay(`node -e "const fs = require('fs'); console.log(fs.cwd)"`, true),
    ).toEqual({
      verb: "Running",
      target: "node script",
      fullCommand: `node -e "const fs = require('fs'); console.log(fs.cwd)"`,
    });

    expect(deriveReadableCommandDisplay("python3 - <<'PY'\nprint('hi')\nPY", true)).toEqual({
      verb: "Running",
      target: "python script",
      fullCommand: "python3 - <<'PY'\nprint('hi')\nPY",
    });
  });

  it("humanizes current-directory searches without leaking placeholder dots", () => {
    expect(deriveReadableCommandDisplay(`rg -n "model(s)?" .`)).toEqual({
      verb: "Searched",
      target: "for model(s)? in current directory",
      fullCommand: `rg -n "model(s)?" .`,
    });
  });

  it("falls back to a directory summary when the search token is only punctuation", () => {
    expect(deriveReadableCommandDisplay(`rg -n . src/lib`)).toEqual({
      verb: "Searched",
      target: "in src/lib",
      fullCommand: `rg -n . src/lib`,
    });
  });
});

describe("deriveInlineCommandCall", () => {
  it("shows the actual command call without the shell wrapper", () => {
    expect(deriveInlineCommandCall(`/bin/zsh -lc 'rg -n "tool call" apps/web/src'`)).toBe(
      `rg -n "tool call" apps/web/src`,
    );
  });
});

describe("isInspectCommand", () => {
  it("detects read-only inspection commands (read/search/find/list)", () => {
    expect(isInspectCommand("cat package.json")).toBe(true);
    expect(isInspectCommand("sed -n 1,40p src/app.ts")).toBe(true);
    expect(isInspectCommand("head -n 20 README.md")).toBe(true);
    expect(isInspectCommand(`rg -n "tool call" apps/web/src`)).toBe(true);
    expect(isInspectCommand("grep -R foo .")).toBe(true);
    expect(isInspectCommand("find . -name '*.ts'")).toBe(true);
    expect(isInspectCommand("ls -la src")).toBe(true);
    expect(isInspectCommand(`/bin/zsh -lc 'rg -n "x" src'`)).toBe(true);
  });

  it("does not treat mutating or executing commands as inspections", () => {
    expect(isInspectCommand("git status")).toBe(false);
    expect(isInspectCommand("node build.js")).toBe(false);
    expect(isInspectCommand("rm -rf dist")).toBe(false);
    expect(isInspectCommand("mkdir foo")).toBe(false);
  });
});

describe("resolveCommandVisualKind", () => {
  it("classifies git commands through shell and global-option wrappers", () => {
    expect(resolveCommandVisualKind("git status --short")).toBe("git");
    expect(resolveCommandVisualKind("git -C apps/web status --short")).toBe("git");
    expect(resolveCommandVisualKind(`/bin/zsh -lc "cd repo && git branch -vv"`)).toBe("git");
  });

  it("classifies GitHub CLI commands through env wrappers", () => {
    expect(resolveCommandVisualKind("gh pr view 274 --repo owner/repo")).toBe("github");
    expect(resolveCommandVisualKind("env -u GH_TOKEN gh pr status")).toBe("github");
    expect(resolveCommandVisualKind("hub pull-request -m test")).toBe("github");
  });

  it("keeps inspections and ordinary commands distinct", () => {
    expect(resolveCommandVisualKind(`rg -n "tool call" apps/web/src`)).toBe("inspect");
    expect(resolveCommandVisualKind("bun run build")).toBe("terminal");
  });
});
