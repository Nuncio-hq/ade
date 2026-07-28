// FILE: managedTerminalWrappers.ts
// Purpose: Create Superset-style managed command wrappers so terminal agent identity is canonical
// and survives zsh startup that rewrites PATH.

import fs from "node:fs";
import path from "node:path";

import {
  defaultTerminalTitleForCliKind,
  managedTerminalCommandNameForCliKind,
  NUNCIO_TERMINAL_HOOK_OSC_PREFIX,
  NUNCIO_TERMINAL_CLI_KIND_ENV_KEY,
  type TerminalAgentHookEventType,
  type ManagedTerminalCliKind,
} from "@nuncio/shared/terminalThreads";

import { envPathKeyFor, resolveExecutable } from "../executableLookup.ts";
import {
  ensurePrivateDirectorySync,
  PRIVATE_EXECUTABLE_FILE_MODE,
  PRIVATE_FILE_MODE,
} from "../privatePathPermissions";

export interface ManagedTerminalWrapperState {
  binDir: string | null;
  codexHomeDir: string | null;
  hookScriptPath: string | null;
  claudeSettingsPath: string | null;
  zshDir: string | null;
  targetPathByCliKind: Partial<Record<ManagedTerminalCliKind, string>>;
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\"'\"'`)}'`;
}

function buildHookOscSequence(eventType: TerminalAgentHookEventType): string {
  return `\\033]${NUNCIO_TERMINAL_HOOK_OSC_PREFIX}${eventType}\\007`;
}

function buildNotifyHookScript(): string {
  return `#!/bin/sh
set -eu
if [ "$#" -gt 0 ]; then
  _nuncioade_hook_input="$1"
else
  _nuncioade_hook_input="$(cat)"
fi

_nuncioade_extract_event() {
  printf '%s' "$_nuncioade_hook_input" | sed -n "s/.*\\\"$1\\\"[[:space:]]*:[[:space:]]*\\\"\\([^\\\"]*\\)\\\".*/\\1/p" | head -n 1
}

_nuncioade_event="$(_nuncioade_extract_event hook_event_name)"
if [ -z "$_nuncioade_event" ]; then
  _nuncioade_type="$(_nuncioade_extract_event type)"
  case "$_nuncioade_type" in
    task_started|userPromptSubmitted|user_prompt_submit)
      _nuncioade_event="Start"
      ;;
    task_complete|agent-turn-complete|stop|session_end|sessionEnd)
      _nuncioade_event="Stop"
      ;;
    exec_approval_request|apply_patch_approval_request|request_user_input)
      _nuncioade_event="PermissionRequest"
      ;;
  esac
fi

_nuncioade_emit_osc() {
  _nuncioade_sequence="$1"
  if [ -w /dev/tty ]; then
    printf '%b' "$_nuncioade_sequence" > /dev/tty 2>/dev/null || printf '%b' "$_nuncioade_sequence"
    return
  fi
  printf '%b' "$_nuncioade_sequence"
}

case "$_nuncioade_event" in
  UserPromptSubmit|PostToolUse|PostToolUseFailure|Start)
    _nuncioade_emit_osc '${buildHookOscSequence("Start")}'
    ;;
  Stop)
    _nuncioade_emit_osc '${buildHookOscSequence("Stop")}'
    ;;
  PermissionRequest|PreToolUse|Notification)
    _nuncioade_emit_osc '${buildHookOscSequence("PermissionRequest")}'
    ;;
esac
`;
}

function buildClaudeSettingsJson(notifyHookPath: string): string {
  const command = notifyHookPath;
  return JSON.stringify(
    {
      hooks: {
        UserPromptSubmit: [{ hooks: [{ type: "command", command }] }],
        Stop: [{ hooks: [{ type: "command", command }] }],
        PostToolUse: [{ matcher: "*", hooks: [{ type: "command", command }] }],
        PostToolUseFailure: [{ matcher: "*", hooks: [{ type: "command", command }] }],
        PermissionRequest: [{ matcher: "*", hooks: [{ type: "command", command }] }],
        Notification: [{ matcher: "*", hooks: [{ type: "command", command }] }],
      },
    },
    null,
    2,
  );
}

function buildCodexHooksJson(notifyHookPath: string): string {
  const command = notifyHookPath;
  return JSON.stringify(
    {
      hooks: {
        UserPromptSubmit: [{ hooks: [{ type: "command", command }] }],
        Stop: [{ hooks: [{ type: "command", command }] }],
      },
    },
    null,
    2,
  );
}

function buildCodexWrapperScript(input: {
  codexHomeDir: string;
  notifyHookPath: string;
  targetPath: string;
}): string {
  const { codexHomeDir, notifyHookPath, targetPath } = input;
  return [
    `export CODEX_HOME=${shellQuote(codexHomeDir)}`,
    `if [ -f ${shellQuote(notifyHookPath)} ]; then`,
    "  export CODEX_TUI_RECORD_SESSION=1",
    '  if [ -z "${CODEX_TUI_SESSION_LOG_PATH:-}" ]; then',
    '    _nuncioade_codex_ts="$(date +%s 2>/dev/null || echo "$$")"',
    '    export CODEX_TUI_SESSION_LOG_PATH="${TMPDIR:-/tmp}/nuncioade-codex-session-$$_${_nuncioade_codex_ts}.jsonl"',
    "  fi",
    "  (",
    '    _nuncioade_log="$CODEX_TUI_SESSION_LOG_PATH"',
    `    _nuncioade_notify=${shellQuote(notifyHookPath)}`,
    '    _nuncioade_last_turn_id=""',
    '    _nuncioade_last_approval_id=""',
    '    _nuncioade_last_exec_call_id=""',
    "    _nuncioade_approval_fallback_seq=0",
    "",
    "    _nuncioade_emit_event() {",
    '      _nuncioade_event="$1"',
    `      _nuncioade_payload=$(printf '{"hook_event_name":"%s"}' "$_nuncioade_event")`,
    '      "$_nuncioade_notify" "$_nuncioade_payload" >/dev/null 2>&1 || true',
    "    }",
    "",
    "    _nuncioade_i=0",
    '    while [ ! -f "$_nuncioade_log" ] && [ "$_nuncioade_i" -lt 200 ]; do',
    "      _nuncioade_i=$((_nuncioade_i + 1))",
    "      sleep 0.05",
    "    done",
    '    if [ ! -f "$_nuncioade_log" ]; then',
    "      exit 0",
    "    fi",
    "",
    '    tail -n 0 -F "$_nuncioade_log" 2>/dev/null | while IFS= read -r _nuncioade_line; do',
    '      case "$_nuncioade_line" in',
    `        *'"dir":"to_tui"'*'"kind":"codex_event"'*'"msg":{"type":"task_started"'*)`,
    `          _nuncioade_turn_id=$(printf '%s\n' "$_nuncioade_line" | awk -F'"turn_id":"' 'NF > 1 { sub(/".*/, "", $2); print $2; exit }')`,
    '          [ -n "$_nuncioade_turn_id" ] || _nuncioade_turn_id="task_started"',
    '          if [ "$_nuncioade_turn_id" != "$_nuncioade_last_turn_id" ]; then',
    '            _nuncioade_last_turn_id="$_nuncioade_turn_id"',
    '            _nuncioade_emit_event "Start"',
    "          fi",
    "          ;;",
    `        *'"dir":"to_tui"'*'"kind":"codex_event"'*'"msg":{"type":"'*'_approval_request"'*)`,
    `          _nuncioade_approval_id=$(printf '%s\n' "$_nuncioade_line" | awk -F'"id":"' 'NF > 1 { sub(/".*/, "", $2); print $2; exit }')`,
    `          [ -n "$_nuncioade_approval_id" ] || _nuncioade_approval_id=$(printf '%s\n' "$_nuncioade_line" | awk -F'"approval_id":"' 'NF > 1 { sub(/".*/, "", $2); print $2; exit }')`,
    `          [ -n "$_nuncioade_approval_id" ] || _nuncioade_approval_id=$(printf '%s\n' "$_nuncioade_line" | awk -F'"call_id":"' 'NF > 1 { sub(/".*/, "", $2); print $2; exit }')`,
    '          if [ -z "$_nuncioade_approval_id" ]; then',
    "            _nuncioade_approval_fallback_seq=$((_nuncioade_approval_fallback_seq + 1))",
    '            _nuncioade_approval_id="approval_request_${_nuncioade_approval_fallback_seq}"',
    "          fi",
    '          if [ "$_nuncioade_approval_id" != "$_nuncioade_last_approval_id" ]; then',
    '            _nuncioade_last_approval_id="$_nuncioade_approval_id"',
    '            _nuncioade_emit_event "PermissionRequest"',
    "          fi",
    "          ;;",
    `        *'"dir":"to_tui"'*'"kind":"codex_event"'*'"msg":{"type":"exec_command_begin"'*)`,
    `          _nuncioade_exec_call_id=$(printf '%s\n' "$_nuncioade_line" | awk -F'"call_id":"' 'NF > 1 { sub(/".*/, "", $2); print $2; exit }')`,
    '          if [ -n "$_nuncioade_exec_call_id" ]; then',
    '            if [ "$_nuncioade_exec_call_id" != "$_nuncioade_last_exec_call_id" ]; then',
    '              _nuncioade_last_exec_call_id="$_nuncioade_exec_call_id"',
    '              _nuncioade_emit_event "Start"',
    "            fi",
    "          else",
    '            _nuncioade_emit_event "Start"',
    "          fi",
    "          ;;",
    "      esac",
    "    done",
    "  ) &",
    "  NUNCIO_CODEX_START_WATCHER_PID=$!",
    "fi",
    `${shellQuote(targetPath)} --enable codex_hooks -c ${shellQuote(`notify=["bash",${JSON.stringify(notifyHookPath)}]`)} "$@"`,
    "_nuncioade_status=$?",
    'if [ -n "${NUNCIO_CODEX_START_WATCHER_PID:-}" ]; then',
    '  kill "$NUNCIO_CODEX_START_WATCHER_PID" >/dev/null 2>&1 || true',
    '  wait "$NUNCIO_CODEX_START_WATCHER_PID" 2>/dev/null || true',
    "fi",
    'exit "$_nuncioade_status"',
  ].join("\n");
}

function buildWrapperScript(input: {
  claudeSettingsPath: string;
  cliKind: ManagedTerminalCliKind;
  codexHomeDir: string;
  notifyHookPath: string;
  targetPath: string;
}): string {
  const { claudeSettingsPath, cliKind, codexHomeDir, notifyHookPath, targetPath } = input;
  const commandName = managedTerminalCommandNameForCliKind(cliKind);
  const title = defaultTerminalTitleForCliKind(cliKind);
  const commandBody =
    cliKind === "claude"
      ? `exec ${shellQuote(targetPath)} --settings ${shellQuote(claudeSettingsPath)} "$@"`
      : buildCodexWrapperScript({ codexHomeDir, notifyHookPath, targetPath });
  return [
    "#!/bin/sh",
    `# Managed ${commandName} wrapper injected by nuncioade terminal sessions.`,
    `printf '\\033]0;%s\\007' ${shellQuote(title)}`,
    `export ${NUNCIO_TERMINAL_CLI_KIND_ENV_KEY}=${shellQuote(cliKind)}`,
    commandBody,
    "",
  ].join("\n");
}

function writeFileIfChanged(filePath: string, content: string, mode: number): void {
  const currentContent = fs.existsSync(filePath) ? fs.readFileSync(filePath, "utf8") : null;
  if (currentContent !== content) {
    fs.writeFileSync(filePath, content, { mode });
  }
  try {
    fs.chmodSync(filePath, mode);
  } catch {
    // Best effort.
  }
}

function buildManagedZshRc(quotedZshDir: string): string {
  return `# NuncioADE zsh rc wrapper
_nuncioade_home="\${NUNCIO_ORIGINAL_ZDOTDIR:-$HOME}"
export ZDOTDIR="$_nuncioade_home"
[[ -f "$_nuncioade_home/.zshrc" ]] && source "$_nuncioade_home/.zshrc"
export ZDOTDIR=${quotedZshDir}
if [ -n "\${NUNCIO_MANAGED_BIN_DIR:-}" ] && [ -d "\${NUNCIO_MANAGED_BIN_DIR}" ]; then
  case ":$PATH:" in
    *:\${NUNCIO_MANAGED_BIN_DIR}:*) ;;
    *) export PATH="\${NUNCIO_MANAGED_BIN_DIR}:$PATH" ;;
  esac
  unalias claude 2>/dev/null || true
  claude() {
    if [ -x "\${NUNCIO_MANAGED_BIN_DIR}/claude" ] && [ ! -d "\${NUNCIO_MANAGED_BIN_DIR}/claude" ]; then
      "\${NUNCIO_MANAGED_BIN_DIR}/claude" "$@"
    else
      command claude "$@"
    fi
  }
  unalias codex 2>/dev/null || true
  codex() {
    if [ -x "\${NUNCIO_MANAGED_BIN_DIR}/codex" ] && [ ! -d "\${NUNCIO_MANAGED_BIN_DIR}/codex" ]; then
      "\${NUNCIO_MANAGED_BIN_DIR}/codex" "$@"
    else
      command codex "$@"
    fi
  }
  typeset -ga precmd_functions 2>/dev/null || true
  _nuncioade_ensure_managed_bin() {
    case ":$PATH:" in
      *:\${NUNCIO_MANAGED_BIN_DIR}:*) ;;
      *) PATH="\${NUNCIO_MANAGED_BIN_DIR}:$PATH" ;;
    esac
  }
  {
    precmd_functions=(\${precmd_functions:#_nuncioade_ensure_managed_bin} _nuncioade_ensure_managed_bin)
  } 2>/dev/null || true
fi
`;
}

function ensureManagedZshWrappers(zshDir: string): void {
  ensurePrivateDirectorySync(zshDir);
  const quotedZshDir = shellQuote(zshDir);
  writeFileIfChanged(
    path.join(zshDir, ".zshenv"),
    `# NuncioADE zsh env wrapper
_nuncioade_home="\${NUNCIO_ORIGINAL_ZDOTDIR:-$HOME}"
export ZDOTDIR="$_nuncioade_home"
[[ -f "$_nuncioade_home/.zshenv" ]] && source "$_nuncioade_home/.zshenv"
export ZDOTDIR=${quotedZshDir}
`,
    PRIVATE_FILE_MODE,
  );
  writeFileIfChanged(
    path.join(zshDir, ".zprofile"),
    `# NuncioADE zsh profile wrapper
_nuncioade_home="\${NUNCIO_ORIGINAL_ZDOTDIR:-$HOME}"
export ZDOTDIR="$_nuncioade_home"
[[ -f "$_nuncioade_home/.zprofile" ]] && source "$_nuncioade_home/.zprofile"
export ZDOTDIR=${quotedZshDir}
`,
    PRIVATE_FILE_MODE,
  );
  writeFileIfChanged(
    path.join(zshDir, ".zshrc"),
    buildManagedZshRc(quotedZshDir),
    PRIVATE_FILE_MODE,
  );
}

export function prepareManagedTerminalWrappers(options: {
  baseEnv: NodeJS.ProcessEnv;
  rootDir: string;
  zshRootDir: string;
}): ManagedTerminalWrapperState {
  if (process.platform === "win32") {
    return {
      binDir: null,
      codexHomeDir: null,
      hookScriptPath: null,
      claudeSettingsPath: null,
      zshDir: null,
      targetPathByCliKind: {},
    };
  }

  const targetPathByCliKind: Partial<Record<ManagedTerminalCliKind, string>> = {};
  for (const cliKind of ["codex", "claude"] as const) {
    const commandName = managedTerminalCommandNameForCliKind(cliKind);
    const targetPath = resolveExecutable(commandName, { env: options.baseEnv });
    if (!targetPath) {
      continue;
    }
    targetPathByCliKind[cliKind] = targetPath;
  }

  if (Object.keys(targetPathByCliKind).length === 0) {
    return {
      binDir: null,
      codexHomeDir: null,
      hookScriptPath: null,
      claudeSettingsPath: null,
      zshDir: null,
      targetPathByCliKind,
    };
  }

  ensurePrivateDirectorySync(options.rootDir);
  const codexHomeDir = path.join(options.rootDir, "codex-home");
  const hookScriptPath = path.join(options.rootDir, "notify-hook.sh");
  const claudeSettingsPath = path.join(options.rootDir, "claude-settings.json");
  ensurePrivateDirectorySync(codexHomeDir);
  writeFileIfChanged(hookScriptPath, buildNotifyHookScript(), PRIVATE_EXECUTABLE_FILE_MODE);
  writeFileIfChanged(
    claudeSettingsPath,
    buildClaudeSettingsJson(hookScriptPath),
    PRIVATE_FILE_MODE,
  );
  writeFileIfChanged(
    path.join(codexHomeDir, "hooks.json"),
    buildCodexHooksJson(hookScriptPath),
    PRIVATE_FILE_MODE,
  );
  for (const [cliKind, targetPath] of Object.entries(targetPathByCliKind) as Array<
    [ManagedTerminalCliKind, string]
  >) {
    const wrapperPath = path.join(options.rootDir, managedTerminalCommandNameForCliKind(cliKind));
    writeFileIfChanged(
      wrapperPath,
      buildWrapperScript({
        claudeSettingsPath,
        cliKind,
        codexHomeDir,
        notifyHookPath: hookScriptPath,
        targetPath,
      }),
      PRIVATE_EXECUTABLE_FILE_MODE,
    );
  }
  ensureManagedZshWrappers(options.zshRootDir);

  return {
    binDir: options.rootDir,
    codexHomeDir,
    hookScriptPath,
    claudeSettingsPath,
    zshDir: options.zshRootDir,
    targetPathByCliKind,
  };
}

function applyManagedTerminalWrapperEnvState(
  env: NodeJS.ProcessEnv,
  wrapperState: {
    binDir: string | null;
    zshDir: string | null;
  },
): NodeJS.ProcessEnv {
  if (!wrapperState.binDir) {
    return env;
  }

  const envPathKey = envPathKeyFor(env);
  const currentPath = env[envPathKey]?.trim() ?? "";
  const currentEntries = currentPath
    .split(path.delimiter)
    .map((entry) => entry.trim())
    .filter(Boolean);

  if (!currentEntries.includes(wrapperState.binDir)) {
    currentEntries.unshift(wrapperState.binDir);
  }

  return {
    ...env,
    NUNCIO_MANAGED_BIN_DIR: wrapperState.binDir,
    NUNCIO_ORIGINAL_ZDOTDIR: env.ZDOTDIR ?? env.HOME ?? "",
    ...(wrapperState.zshDir ? { ZDOTDIR: wrapperState.zshDir } : {}),
    [envPathKey]: currentEntries.join(path.delimiter),
  };
}

export function applyManagedTerminalAgentWrapperEnv(
  env: NodeJS.ProcessEnv,
  wrapperState: {
    binDir: string | null;
    zshDir: string | null;
  },
): NodeJS.ProcessEnv {
  return applyManagedTerminalWrapperEnvState(env, wrapperState);
}

export function prepareManagedTerminalAgentWrappers(options: {
  baseEnv: NodeJS.ProcessEnv;
  targetDir: string;
  zshDir: string;
}): ManagedTerminalWrapperState {
  return prepareManagedTerminalWrappers({
    baseEnv: options.baseEnv,
    rootDir: options.targetDir,
    zshRootDir: options.zshDir,
  });
}
