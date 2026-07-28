import assert from "node:assert/strict";
import path from "node:path";
import { describe, it } from "vitest";

import {
  resolveActiveCodexHomeWritePath,
  resolveBaseCodexHomePath,
  resolveCodexHomeAllowlistCandidates,
  resolveNuncioADECodexHomeOverlayPath,
} from "./codexHomePaths.ts";

describe("Codex home paths", () => {
  it("resolves the source home using explicit, environment, then default precedence", () => {
    assert.equal(
      resolveBaseCodexHomePath({ CODEX_HOME: "/env/codex" }, "/explicit/codex"),
      "/explicit/codex",
    );
    assert.equal(resolveBaseCodexHomePath({ CODEX_HOME: "/env/codex" }), "/env/codex");
    assert.ok(resolveBaseCodexHomePath({}).endsWith(`${path.sep}.codex`));
  });

  it("anchors the overlay under NUNCIO_HOME", () => {
    assert.equal(
      resolveNuncioADECodexHomeOverlayPath(
        { NUNCIO_HOME: "/nuncioade/runtime" },
        "/users/me/.codex",
      ),
      path.join("/nuncioade/runtime", "codex-home-overlay"),
    );
  });

  it("derives a default overlay beside the source home", () => {
    assert.equal(
      resolveNuncioADECodexHomeOverlayPath({}, "/users/me/.codex"),
      path.join("/users/me", ".nuncioade", "runtime", "codex-home-overlay"),
    );
  });

  it("uses the isolated overlay as Codex's write home", () => {
    assert.equal(
      resolveActiveCodexHomeWritePath({
        env: { NUNCIO_HOME: "/nuncioade/runtime" },
        homePath: "/users/me/.codex",
      }),
      path.join("/nuncioade/runtime", "codex-home-overlay"),
    );
  });

  it("allowlists source and overlay homes when distinct", () => {
    assert.deepEqual(
      resolveCodexHomeAllowlistCandidates({
        env: { NUNCIO_HOME: "/nuncioade/runtime" },
        homePath: "/users/me/.codex",
      }),
      ["/users/me/.codex", path.join("/nuncioade/runtime", "codex-home-overlay")],
    );
  });
});
