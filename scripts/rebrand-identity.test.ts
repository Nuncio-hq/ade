// FILE: rebrand-identity.test.ts
// Purpose: Pins the behavior of the NuncioADE identity codemod before it exists (TDD).

import { describe, expect, it } from "vitest";

import { isExemptPath, transformContent, transformPath } from "./rebrand-identity";

describe("transformContent token map", () => {
  it("renames package scope without mangling it", () => {
    expect(transformContent('import { x } from "@synara/contracts";')).toBe(
      'import { x } from "@nuncio/contracts";',
    );
    expect(transformContent('import { git } from "@synara/shared/git";')).toBe(
      'import { git } from "@nuncio/shared/git";',
    );
  });

  it("renames env vars", () => {
    expect(transformContent("process.env.SYNARA_HOME")).toBe("process.env.NUNCIO_HOME");
    expect(transformContent("SYNARA_ACP_EMIT_TOOL_CALLS")).toBe("NUNCIO_ACP_EMIT_TOOL_CALLS");
  });

  it("renames PascalCase and prose occurrences", () => {
    expect(transformContent("Synara is the best way to code with AI.")).toBe(
      "NuncioADE is the best way to code with AI.",
    );
    expect(transformContent("export function SynaraLogo() {}")).toBe(
      "export function NuncioADELogo() {}",
    );
    expect(transformContent("Synara.app/Contents/MacOS")).toBe("NuncioADE.app/Contents/MacOS");
  });

  it("renames lowercase occurrences including dirs, storage keys and asset names", () => {
    expect(transformContent("--home-dir ./.synara/electron-dev")).toBe(
      "--home-dir ./.nuncioade/electron-dev",
    );
    expect(transformContent('"synara.editor.viewStateByThreadId"')).toBe(
      '"nuncioade.editor.viewStateByThreadId"',
    );
    expect(transformContent('"synara": "dist/index.mjs"')).toBe('"nuncioade": "dist/index.mjs"');
    expect(transformContent('const icon = "synara.png";')).toBe('const icon = "nuncioade.png";');
  });

  it("keeps upstream doc filenames referenced in prose", () => {
    expect(transformContent("see SYNARA-AGENTS.md and SYNARA-CLAUDE.md")).toBe(
      "see SYNARA-AGENTS.md and SYNARA-CLAUDE.md",
    );
  });
});

describe("transformContent protections", () => {
  it("protects upstream repository URLs regardless of casing", () => {
    expect(transformContent("https://github.com/Emanuele-web04/synara/releases")).toBe(
      "https://github.com/Emanuele-web04/synara/releases",
    );
    expect(transformContent("https://github.com/Emanuele-web04/Synara/releases")).toBe(
      "https://github.com/Emanuele-web04/Synara/releases",
    );
    expect(transformContent("git+https://github.com/Emanuele-web04/synara.git")).toBe(
      "git+https://github.com/Emanuele-web04/synara.git",
    );
  });

  it("protects the attribution markdown link including its link text", () => {
    expect(
      transformContent("forked from [Synara](https://github.com/Emanuele-web04/synara) (upstream)"),
    ).toBe("forked from [Synara](https://github.com/Emanuele-web04/synara) (upstream)");
  });

  it("protects the upstream hosted site while still renaming adjacent identifiers", () => {
    expect(transformContent('const SYNARA_DOCS_URL = "https://trysynara.com/docs";')).toBe(
      'const NUNCIO_DOCS_URL = "https://trysynara.com/docs";',
    );
    expect(transformContent('"https://www.trysynara.com/api/feedback"')).toBe(
      '"https://www.trysynara.com/api/feedback"',
    );
    expect(transformContent("// Depends on: The public trysynara feedback endpoint.")).toBe(
      "// Depends on: The public trysynara feedback endpoint.",
    );
  });

  it("skips lines flagged with the exempt marker", () => {
    const input = [
      'const legacyKeyPrefix = "synara."; // rebrand-exempt',
      "const home = process.env.SYNARA_HOME;",
    ].join("\n");
    expect(transformContent(input)).toBe(
      [
        'const legacyKeyPrefix = "synara."; // rebrand-exempt',
        "const home = process.env.NUNCIO_HOME;",
      ].join("\n"),
    );
  });
});

describe("transformContent robustness", () => {
  it("is idempotent over a representative blob", () => {
    const blob = [
      'import { git } from "@synara/shared/git";',
      "process.env.SYNARA_PORT_OFFSET",
      "export function SynaraLogo() { return readFileSync('synara.png'); }",
      "// see https://github.com/Emanuele-web04/synara",
      'const legacy = "synara."; // rebrand-exempt',
    ].join("\n");
    const once = transformContent(blob);
    expect(transformContent(once)).toBe(once);
  });

  it("returns binary-looking content unchanged", () => {
    const binary = "PNG\0synara\0data";
    expect(transformContent(binary)).toBe(binary);
  });
});

describe("isExemptPath", () => {
  it("exempts lineage docs, historical snapshots and the lockfile", () => {
    for (const path of [
      "SYNARA-AGENTS.md",
      "SYNARA-CLAUDE.md",
      "docs/DECISIONS.md",
      "CHANGELOG.md",
      "UPSTREAM-BASE",
      "bun.lock",
      "plans/006-make-synara-the-agent-harness.md",
      ".plans/SYN-47-synara-studio.md",
      "audit/PR357_MERGE_READINESS_AUDIT.md",
      "advisor-plans/README.md",
      "scripts/rebrand-identity.ts",
      "scripts/rebrand-identity.test.ts",
      "scripts/check-brand-identity.test.ts",
      "apps/server/src/persistence/Migrations/074_ExternalMcpIntegrations.ts",
      // Hand-curated lineage docs: the one-time rebrand is done, and their
      // factual "Synara" references must survive future codemod runs.
      "AGENTS.md",
      "docs/STATE.md",
      "docs/UPSTREAM-SYNC.md",
      "docs/REFERENCES.md",
    ]) {
      expect(isExemptPath(path), path).toBe(true);
    }
  });

  it("does not exempt live project files", () => {
    for (const path of [
      "README.md",
      "REMOTE.md",
      "CLAUDE.md",
      "apps/web/src/store.ts",
      "packages/shared/src/synaraHome.ts",
      "scripts/package.json",
    ]) {
      expect(isExemptPath(path), path).toBe(false);
    }
  });
});

describe("transformPath", () => {
  it("renames component, asset and source paths", () => {
    expect(transformPath("apps/web/src/components/SynaraLogo.tsx")).toBe(
      "apps/web/src/components/NuncioADELogo.tsx",
    );
    expect(transformPath("packages/shared/src/synaraHome.ts")).toBe(
      "packages/shared/src/nuncioadeHome.ts",
    );
    expect(transformPath("assets/prod/synara-black-web-favicon.ico")).toBe(
      "assets/prod/nuncioade-black-web-favicon.ico",
    );
    expect(transformPath("apps/web/public/synara-logo.svg")).toBe(
      "apps/web/public/nuncioade-logo.svg",
    );
  });

  it("returns exempt and token-free paths unchanged", () => {
    expect(transformPath("SYNARA-AGENTS.md")).toBe("SYNARA-AGENTS.md");
    expect(transformPath("plans/006-make-synara-the-agent-harness.md")).toBe(
      "plans/006-make-synara-the-agent-harness.md",
    );
    expect(transformPath("apps/server/src/index.ts")).toBe("apps/server/src/index.ts");
  });
});
