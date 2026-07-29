import { describe, expect, it } from "vitest";
import {
  decideSessionStopGate,
  initialSessionProofGateState,
  isSuccessfulGitCommitCommand,
  noteCommitWithUiFiles,
  noteShotRan,
  noteUiFilePaths,
  parseGitNameOnly,
  UI_FILE_RE,
} from "../../../../harness/extensions/ade-proof/logic.js";

describe("ade-proof extension gate logic", () => {
  it("detects UI file paths", () => {
    expect(UI_FILE_RE.test("src/components/Login.tsx")).toBe(true);
    expect(UI_FILE_RE.test("pages/index.jsx")).toBe(true);
    expect(UI_FILE_RE.test("app.css")).toBe(true);
    expect(UI_FILE_RE.test("lib/server.ts")).toBe(false);
  });

  it("parses git --name-only output", () => {
    const out = "src/App.tsx\napp.css\n\n";
    expect(parseGitNameOnly(out)).toEqual(["src/App.tsx", "app.css"]);
  });

  it("recognizes successful git commit commands", () => {
    expect(isSuccessfulGitCommitCommand("git commit -m 'feat: ui'")).toBe(true);
    expect(isSuccessfulGitCommitCommand("  git commit")).toBe(true);
    expect(isSuccessfulGitCommitCommand("git commit --amend")).toBe(true);
    expect(isSuccessfulGitCommitCommand("git status")).toBe(false);
    expect(isSuccessfulGitCommitCommand("git checkout main")).toBe(false);
  });

  it("requests continuation when UI files changed and no shot ran", () => {
    let state = initialSessionProofGateState();
    state = noteUiFilePaths(state, ["src/App.tsx"]);
    const { result, nextState } = decideSessionStopGate(state);

    expect(result.continue).toBe(true);
    expect(result.reason).toMatch(/edited UI files/);
    expect(nextState.continuationRequested).toBe(true);
  });

  it("requests continuation when commit contained UI files and no shot ran", () => {
    let state = initialSessionProofGateState();
    state = noteCommitWithUiFiles(state, ["app.css", "src/Button.tsx"]);
    const { result, nextState } = decideSessionStopGate(state);

    expect(result.continue).toBe(true);
    expect(result.reason).toMatch(/committed UI files/);
    expect(nextState.continuationRequested).toBe(true);
  });

  it("does not request continuation when shot ran", () => {
    let state = initialSessionProofGateState();
    state = noteUiFilePaths(state, ["src/App.tsx"]);
    state = noteShotRan(state);
    const { result, nextState } = decideSessionStopGate(state);

    expect(result.continue).toBeFalsy();
    expect(nextState.continuationRequested).toBe(false);
  });

  it("requests continuation at most once", () => {
    let state = initialSessionProofGateState();
    state = noteUiFilePaths(state, ["src/App.tsx"]);
    const first = decideSessionStopGate(state);
    expect(first.result.continue).toBe(true);

    const second = decideSessionStopGate(first.nextState);
    expect(second.result.continue).toBeFalsy();
    expect(second.nextState.continuationRequested).toBe(true);
  });

  it("does not request continuation when no UI files changed", () => {
    const state = initialSessionProofGateState();
    const { result } = decideSessionStopGate(state);
    expect(result.continue).toBeFalsy();
  });
});
