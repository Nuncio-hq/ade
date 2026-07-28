import { describe, expect, it } from "vitest";

import {
  findBrandIdentityViolations,
  findVisualBrandAssetViolations,
} from "./check-brand-identity";

const characters = (...codes: number[]): string => String.fromCharCode(...codes);
const shortName = characters(116, 51);
const firstName = `${shortName}${characters(99, 111, 100, 101)}`;
const secondName = characters(100, 112, 99, 111, 100, 101);

describe("brand identity guard", () => {
  it("detects retired names in paths and text", () => {
    const violations = findBrandIdentityViolations([
      { path: `docs/${firstName}.md`, contents: "NuncioADE" },
      { path: "source.ts", contents: `const value = "${secondName}:state";` },
    ]);
    expect(violations).toHaveLength(2);
  });

  it("does not match ordinary numeric type names or canonical NuncioADE text", () => {
    expect(
      findBrandIdentityViolations([
        {
          path: "source.ts",
          contents: [
            "const value = new Uint32Array(); // NuncioADE",
            'import { git } from "@nuncio/shared/git";',
            "process.env.NUNCIO_HOME",
            '"nuncioade.editor.viewStateByThreadId"',
          ].join("\n"),
        },
      ]),
    ).toEqual([]);
  });

  it("flags the pre-rebrand identity across scopes, env vars and prose", () => {
    const violations = findBrandIdentityViolations([
      {
        path: "source.ts",
        contents: [
          'import { x } from "@synara/shared";',
          "process.env.SYNARA_HOME",
          "export function SynaraLogo() {}",
          'localStorage.getItem("synara.editor.chatPaneWidth")',
        ].join("\n"),
      },
    ]);
    expect(violations).toHaveLength(4);
  });

  it("honors the codemod protections for upstream references", () => {
    expect(
      findBrandIdentityViolations([
        {
          path: "README.md",
          contents: [
            "forked from [Synara](https://github.com/Emanuele-web04/synara) upstream",
            "https://github.com/Emanuele-web04/synara/releases",
            'const SYNARA_DOCS_URL = "https://trysynara.com/docs";',
          ].join("\n"),
        },
      ]),
    ).toEqual([
      {
        path: "README.md",
        line: 3,
        text: 'const SYNARA_DOCS_URL = "https://trysynara.com/docs";',
      },
    ]);
  });

  it("skips rebrand-exempt lines and codemod-exempt paths", () => {
    expect(
      findBrandIdentityViolations([
        {
          path: "apps/server/src/codexProcessEnv.ts",
          contents: 'const legacy = "# >>> synara managed config >>>"; // rebrand-exempt',
        },
        {
          path: "apps/server/src/persistence/Migrations/074_ExternalMcpIntegrations.ts",
          contents: "audience TEXT NOT NULL CHECK (audience = 'synara.external-mcp')",
        },
        { path: "SYNARA-AGENTS.md", contents: "Synara agent docs" },
        { path: "plans/006-make-synara-the-agent-harness.md", contents: "synara" },
        // Lineage docs are hand-curated: factual upstream references stay.
        { path: "AGENTS.md", contents: "forked from Synara, keeps Synara ground intact" },
        { path: "docs/STATE.md", contents: "inherited from Synara upstream" },
        { path: "docs/UPSTREAM-SYNC.md", contents: "pulling Synara releases into NuncioADE" },
      ]),
    ).toEqual([]);
  });

  it("rejects retired identity in legal notices", () => {
    const notice = `Copyright (c) 2026 ${characters(84, 51)} ${characters(
      84,
      111,
      111,
      108,
      115,
    )} Inc.`;
    expect(findBrandIdentityViolations([{ path: "LICENSE", contents: notice }])).toHaveLength(1);
    expect(
      findBrandIdentityViolations([{ path: "docs/license-copy.md", contents: notice }]),
    ).toHaveLength(1);
  });

  it("requires user-facing raster assets to match a visually approved digest", () => {
    const approvedContents = new TextEncoder().encode("approved NuncioADE screenshot");
    const approvedDigest = "98699c499c2dd7be2b6655295f34e5652ccf483d89e231d465e55d2854f9e5cb";
    const approvedDigests = new Map([["screenshot.jpeg", approvedDigest]]);

    expect(
      findVisualBrandAssetViolations(
        [{ path: "screenshot.jpeg", contents: approvedContents }],
        approvedDigests,
      ),
    ).toEqual([]);
    expect(
      findVisualBrandAssetViolations(
        [{ path: "screenshot.jpeg", contents: new TextEncoder().encode("changed") }],
        approvedDigests,
      ),
    ).toHaveLength(1);
    expect(findVisualBrandAssetViolations([], approvedDigests)).toHaveLength(1);
  });
});
