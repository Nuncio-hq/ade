// Error-pattern list adapted from proofshot (https://github.com/AmElmo/proofshot),
// MIT licensed. Used as a snippet donor, not a dependency.

import type { ProofLogError } from "./types.js";

export interface ErrorPattern {
  readonly id: string;
  readonly re: RegExp;
}

// Pattern identifiers double as the `pattern` field on ProofLogError.
export const ERROR_PATTERNS: readonly ErrorPattern[] = [
  // JavaScript / Node.js
  { id: "js-error", re: /\bError:/ },
  { id: "js-errcode", re: /\bERR[_!]/ },
  { id: "js-syscall", re: /\bEACCES\b|\bENOENT\b|\bEADDRINUSE\b/ },
  { id: "js-stack", re: /\bat\s+.+\(.+:\d+:\d+\)/ },
  { id: "js-unhandled", re: /Unhandled.+rejection/i },
  // Python
  { id: "py-traceback", re: /Traceback \(most recent call last\)/ },
  { id: "py-stack", re: /^\s*File ".+", line \d+/ },
  { id: "py-error", re: /\w+Error:/ },
  { id: "py-exception", re: /\w+Exception:/ },
  // Ruby / Rails
  { id: "rb-error", re: /\w+Error \(.+\)/ },
  { id: "rb-stack", re: /from .+:\d+:in `.+'/ },
  { id: "rb-fatal", re: /FATAL --/ },
  { id: "rb-errno", re: /Errno::\w+/ },
  // Go
  { id: "go-panic", re: /^panic:/ },
  { id: "go-goroutine", re: /^goroutine \d+/ },
  { id: "go-runtime", re: /runtime error:/ },
  // Java / Kotlin
  { id: "java-exception", re: /Exception in thread/ },
  { id: "java-error", re: /\w+Exception:/ },
  { id: "java-stack", re: /\bat\s+[\w.$]+\(.+:\d+\)/ },
  { id: "java-caused", re: /Caused by:/ },
  // Rust
  { id: "rust-panic", re: /thread '.+' panicked at/ },
  { id: "rust-compile", re: /error\[E\d+\]/ },
  // PHP
  { id: "php-error", re: /PHP\s+(Fatal|Parse|Warning)\s+error:/i },
  { id: "php-stack", re: /Stack trace:/ },
  { id: "php-thrown", re: /thrown in .+ on line \d+/ },
  // C# / .NET
  { id: "cs-unhandled", re: /Unhandled exception/ },
  { id: "cs-error", re: /\w+Exception:/ },
  { id: "cs-stack", re: /at .+ in .+:line \d+/ },
  // Elixir / Phoenix
  { id: "ex-exit", re: /\*\* \(\w+\)/ },
  { id: "ex-raised", re: /\(exit\) an exception was raised/ },
  // Generic
  { id: "log-fatal", re: /\bFATAL\b/ },
  { id: "log-critical", re: /\bCRITICAL\b/ },
  { id: "segfault", re: /\bSegmentation fault\b/ },
  { id: "core-dumped", re: /\bcore dumped\b/ },
  { id: "oom", re: /\bout of memory\b/i },
] as const;

// Phrases that look like error counts but are not actual errors.
const FALSE_POSITIVE_RE = /\b(?:0 errors?|no errors?|error[- ]?free|found 0 errors?)\b/i;

export function stripAnsi(s: string): string {
  // eslint-disable-next-line no-control-regex
  const ansiRe =
    /[\u001B\u009B][[\]()#;?]*(?:(?:(?:[a-zA-Z\d]*(?:;[-a-zA-Z\d\/#&.:=?%@~_]*)*)?\u0007)|(?:(?:\d{1,4}(?:;\d{0,4})*)?[\dA-PR-TZcf-ntqry=><~]))/g;
  return s.replace(ansiRe, "");
}

export function scanErrors(
  lines: readonly string[],
  source: "console" | "server",
): readonly ProofLogError[] {
  const out: ProofLogError[] = [];
  let prevMatched = false;
  for (const raw of lines) {
    const line = stripAnsi(raw);
    if (!line.trim()) {
      prevMatched = false;
      continue;
    }
    if (FALSE_POSITIVE_RE.test(line)) {
      prevMatched = false;
      continue;
    }
    const matched = matchPattern(line);
    if (!matched) {
      prevMatched = false;
      continue;
    }
    if (prevMatched) continue; // collapse contiguous stack/multi-line into one error
    out.push({ source, pattern: matched, line });
    prevMatched = true;
  }
  return out;
}

function matchPattern(line: string): string | undefined {
  for (const p of ERROR_PATTERNS) {
    if (p.re.test(line)) return p.id;
  }
  return undefined;
}
