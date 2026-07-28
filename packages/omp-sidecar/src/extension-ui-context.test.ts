// FILE: ompExtensionUiContext.test.ts
// Purpose: Pins the OMP extension/ask UI bridge — question projection, answer
//          mapping back to engine values, cancel semantics, and the TUI-only
//          surface that Synara deliberately does not implement.
// Layer: @nuncio/omp-sidecar tests

import type { ProviderUserInputAnswers, UserInputQuestion } from "@synara/contracts";
import { describe, expect, it } from "vitest";

import { makeOmpExtensionUiContext, type OmpUserInputRequest } from "./extension-ui-context";

interface Recorded {
  readonly requests: OmpUserInputRequest[];
  readonly unsupported: string[];
  readonly progress: string[];
  readonly notifications: Array<{ message: string; level: string }>;
}

/** Answers the dialog with `answer(questions)`; records everything it saw. */
function makeContext(
  answer: (questions: ReadonlyArray<UserInputQuestion>) => ProviderUserInputAnswers,
  options?: { readonly timedOut?: boolean },
) {
  const recorded: Recorded = { requests: [], unsupported: [], progress: [], notifications: [] };
  const context = makeOmpExtensionUiContext({
    requestUserInput: (input) => {
      recorded.requests.push(input);
      return Promise.resolve({
        answers: answer(input.questions),
        timedOut: options?.timedOut ?? false,
      });
    },
    warnUnsupported: (method) => recorded.unsupported.push(method),
    emitProgress: (summary) => recorded.progress.push(summary),
    notify: (message, level) => recorded.notifications.push({ message, level }),
  });
  return { context, recorded };
}

describe("makeOmpExtensionUiContext", () => {
  it("returns the selected label, which is what the engine's select contract expects", async () => {
    const { context, recorded } = makeContext(() => ({ selection: "Deploy" }));

    const chosen = await context.select("Pick an action", [
      { label: "Deploy", description: "Ship it" },
      "Rollback",
    ]);

    expect(chosen).toBe("Deploy");
    expect(recorded.requests[0]?.method).toBe("extension/ui/select");
    expect(recorded.requests[0]?.questions[0]?.options?.map((option) => option.label)).toEqual([
      "Deploy",
      "Rollback",
    ]);
  });

  it("disambiguates duplicate labels so each answer still resolves one option", async () => {
    const { context, recorded } = makeContext(() => ({ selection: "Retry (2)" }));

    const chosen = await context.select("Pick an action", [
      { label: "Retry", description: "first" },
      { label: "Retry", description: "second" },
    ]);

    // The dialog shows a suffixed label, but the engine gets its own label back.
    expect(recorded.requests[0]?.questions[0]?.options?.map((option) => option.label)).toEqual([
      "Retry",
      "Retry (2)",
    ]);
    expect(chosen).toBe("Retry");
  });

  it("treats an unanswered select as a dismissal", async () => {
    const { context } = makeContext(() => ({}));

    await expect(context.select("Pick an action", ["Deploy"])).resolves.toBeUndefined();
  });

  it("confirms only on the affirmative option", async () => {
    const yes = makeContext(() => ({ confirmation: "Yes" }));
    const no = makeContext(() => ({ confirmation: "No" }));

    await expect(yes.context.confirm("Delete", "Really delete?")).resolves.toBe(true);
    await expect(no.context.confirm("Delete", "Really delete?")).resolves.toBe(false);
  });

  it("projects the native ask dialog and carries selections, custom input, and notes back", async () => {
    const { context, recorded } = makeContext(() => ({
      scope: {
        selected: ["Server", "Everything else"],
        choiceNotes: { Server: "start here" },
      },
    }));

    const askDialog = context.askDialog;
    expect(askDialog).toBeTypeOf("function");
    const result = await askDialog?.([
      {
        id: "scope",
        question: "Where should the fix land?",
        header: "Scope",
        multi: true,
        options: [{ label: "Server" }, { label: "Web" }],
      },
    ]);

    // The dialog must advertise the same freedom the TUI one has.
    const question = recorded.requests[0]?.questions[0];
    expect(recorded.requests[0]?.method).toBe("extension/ui/askDialog");
    expect(question?.multiSelect).toBe(true);
    expect(question?.allowCustomAnswer).toBe(true);
    expect(question?.allowNotes).toBe(true);

    expect(result).toEqual({
      kind: "submit",
      results: [
        {
          id: "scope",
          question: "Where should the fix land?",
          options: ["Server", "Web"],
          multi: true,
          selectedOptions: ["Server"],
          customInput: "Everything else",
          note: "start here",
        },
      ],
    });
  });

  it("returns the engine's cancel signal when every ask question comes back empty", async () => {
    const { context } = makeContext(() => ({ scope: [] }));

    const result = await context.askDialog?.([
      { id: "scope", question: "Where?", header: "Scope", options: [{ label: "Server" }] },
    ]);

    expect(result).toBeUndefined();
  });

  it("marks the engine's recommended option and keeps its preview text", async () => {
    const { context, recorded } = makeContext(() => ({ scope: "Web (Recommended)" }));

    const result = await context.askDialog?.([
      {
        id: "scope",
        question: "Where?",
        header: "Scope",
        recommended: 1,
        options: [
          { label: "Server" },
          { label: "Web", description: "the app", preview: "apps/web/src/**" },
        ],
      },
    ]);

    // The suffix is the only way the generic contract can carry `recommended`,
    // and the preview must not be dropped just because Synara has one slot.
    expect(recorded.requests[0]?.questions[0]?.options).toEqual([
      { label: "Server", description: "Server" },
      { label: "Web (Recommended)", description: "the app\n\napps/web/src/**" },
    ]);
    // The engine still gets its own untouched label back.
    expect(result?.kind === "submit" && result.results[0]?.selectedOptions).toEqual(["Web"]);
  });

  it("resolves a timed-out ask to the recommended option instead of cancelling", async () => {
    const { context } = makeContext(() => ({}), { timedOut: true });

    const result = await context.askDialog?.([
      {
        id: "scope",
        question: "Where?",
        header: "Scope",
        recommended: 0,
        options: [{ label: "Server" }, { label: "Web" }],
      },
    ]);

    expect(result).toEqual({
      kind: "submit",
      results: [
        {
          id: "scope",
          question: "Where?",
          options: ["Server", "Web"],
          multi: false,
          selectedOptions: ["Server"],
          timedOut: true,
        },
      ],
    });
  });

  it("reports a timeout with no recommendation as timed out, not as a dismissal", async () => {
    const { context } = makeContext(() => ({}), { timedOut: true });

    const result = await context.askDialog?.([
      { id: "scope", question: "Where?", header: "Scope", options: [{ label: "Server" }] },
    ]);

    expect(result?.kind).toBe("submit");
    expect(result?.kind === "submit" && result.results[0]?.timedOut).toBe(true);
    expect(result?.kind === "submit" && result.results[0]?.selectedOptions).toEqual([]);
  });

  it("keeps the harness askUserQuestions extra answering in Synara's own shape", async () => {
    const { context, recorded } = makeContext(() => ({ Scope: "Server" }));

    const answers = await context.askUserQuestions([
      { header: "Scope", question: "Where?", options: [{ label: "Server" }] },
    ]);

    expect(answers).toEqual({ Scope: "Server" });
    expect(recorded.requests[0]?.method).toBe("extension/ui/askUserQuestion");
  });

  it("reports TUI-only surfaces as unsupported instead of throwing", () => {
    const { context, recorded } = makeContext(() => ({}));

    context.setWidget("id", undefined);
    context.setHeader(undefined);
    context.setFooter(undefined);
    context.setEditorText("text");
    context.addAutocompleteProvider(() => undefined as never);

    expect(recorded.unsupported).toEqual([
      "setWidget",
      "setHeader",
      "setFooter",
      "setEditorText",
      "addAutocompleteProvider",
    ]);
  });

  it("emits status chatter once per distinct value", () => {
    const { context, recorded } = makeContext(() => ({}));

    context.setStatus("build", "compiling");
    context.setStatus("build", "compiling");
    context.setStatus("build", "linking");
    context.setWorkingMessage("thinking");
    context.setWorkingMessage("thinking");

    expect(recorded.progress).toEqual(["build: compiling", "build: linking", "thinking"]);
  });

  it("passes notifications through at their own severity", () => {
    const { context, recorded } = makeContext(() => ({}));

    context.notify("  ", "error");
    context.notify("disk is full", "error");
    context.notify("done");

    expect(recorded.notifications).toEqual([
      { message: "disk is full", level: "error" },
      { message: "done", level: "info" },
    ]);
  });
});
