// FILE: extension-ui-context.ts
// Purpose: Bridge OMP's ExtensionUIContext — select/confirm/input/notify/status,
//          the engine's native rich ask dialog, and the harness-only
//          askUserQuestions extra — onto NuncioADE's user-input request flow.
// Layer: Sidecar engine (OMP)
// Exports: makeOmpExtensionUiContext, OmpExtensionUiBridge, OmpExtensionUiContext
//
// The native `ask` tool is the primary way OMP asks the user something: it is
// only constructed when the session reports `hasUI`, and it calls
// `uiContext.askDialog`. Implementing askDialog here is therefore what turns
// "agent wants to ask a question" into a NuncioADE dialog. `askUserQuestions` is a
// separate, non-standard entry point that pi-era extensions feature-detect; it
// is kept for compatibility, not as the main path.

import type {
  ExtensionAskDialogOption,
  ExtensionAskDialogQuestion,
  ExtensionAskDialogResult,
  ExtensionAskDialogResultItem,
  ExtensionUIContext,
  ExtensionUIDialogOptions,
  ExtensionUISelectItem,
} from "@oh-my-pi/pi-coding-agent";
import type { ProviderUserInputAnswers, UserInputQuestion } from "@nuncio/contracts";

export interface OmpUserInputRequest {
  readonly method: string;
  readonly questions: ReadonlyArray<UserInputQuestion>;
  readonly opts?: ExtensionUIDialogOptions | undefined;
  readonly rawPayload?: Record<string, unknown>;
}

export interface OmpUserInputOutcome {
  readonly answers: ProviderUserInputAnswers;
  /**
   * True when the dialog's own deadline expired instead of the user answering.
   * The ask tool distinguishes the two: a timeout keeps the turn going with the
   * recommended option, an empty answer cancels it.
   */
  readonly timedOut: boolean;
}

export interface OmpExtensionUiBridge {
  /** Opens a NuncioADE dialog and resolves once the user answers (or it is aborted). */
  readonly requestUserInput: (input: OmpUserInputRequest) => Promise<OmpUserInputOutcome>;
  /** Reports a TUI-only API that NuncioADE deliberately does not implement. */
  readonly warnUnsupported: (method: string) => void;
  /** Surfaces extension chatter (status/working message/title) as tool progress. */
  readonly emitProgress: (summary: string) => void;
  /** Surfaces an extension notification at its own severity. */
  readonly notify: (message: string, level: "info" | "warning" | "error") => void;
}

/** The context plus the non-standard extra pi-era extensions feature-detect. */
export type OmpExtensionUiContext = ExtensionUIContext & {
  readonly askUserQuestions: (
    questions: ReadonlyArray<{
      readonly header: string;
      readonly question: string;
      readonly multiSelect?: boolean;
      readonly options: ReadonlyArray<{ readonly label: string; readonly description?: string }>;
    }>,
    opts?: ExtensionUIDialogOptions,
  ) => Promise<ProviderUserInputAnswers>;
};

interface UserInputOptionMapping {
  /** The value the engine expects back (the original, untrimmed option). */
  readonly value: string;
  readonly option: UserInputQuestion["options"][number];
}

/** Matches the suffix OMP appends in its own selector (tools/ask.ts). */
const RECOMMENDED_SUFFIX = " (Recommended)";

function trimToUndefined(value: string | null | undefined): string | undefined {
  const trimmed = typeof value === "string" ? value.trim() : "";
  return trimmed.length > 0 ? trimmed : undefined;
}

/** Either surface's option shape; only the ask dialog carries `preview`. */
type OmpUiOption = ExtensionUISelectItem | ExtensionAskDialogOption;

function selectItemLabel(item: OmpUiOption): string {
  return typeof item === "string" ? item : item.label;
}

function selectItemDescription(item: OmpUiOption): string | undefined {
  if (typeof item === "string") return undefined;
  // `preview` is the ask dialog's rich body. NuncioADE has one description slot,
  // so both are kept rather than silently dropping the richer half.
  const preview = "preview" in item ? item.preview : undefined;
  const parts = [trimToUndefined(item.description), trimToUndefined(preview)].filter(
    (part): part is string => part !== undefined,
  );
  return parts.length > 0 ? parts.join("\n\n") : undefined;
}

/**
 * NuncioADE matches answers back by label, so duplicate labels have to be made
 * unique before they reach the dialog while still mapping to the original
 * value. `recommendedIndex` carries the engine's default the only way the
 * generic contract allows — the same "(Recommended)" suffix OMP's own selector
 * renders (tools/ask.ts).
 */
function makeUserInputOptions(
  items: ReadonlyArray<OmpUiOption>,
  recommendedIndex?: number,
): ReadonlyArray<UserInputOptionMapping> {
  const labelCounts = new Map<string, number>();
  return items.map((item, index) => {
    const rawLabel = selectItemLabel(item);
    const baseLabel = trimToUndefined(rawLabel) ?? `Option ${String(index + 1)}`;
    const count = (labelCounts.get(baseLabel) ?? 0) + 1;
    labelCounts.set(baseLabel, count);
    const uniqueLabel = count === 1 ? baseLabel : `${baseLabel} (${String(count)})`;
    const displayLabel =
      index === recommendedIndex && !uniqueLabel.endsWith(RECOMMENDED_SUFFIX)
        ? `${uniqueLabel}${RECOMMENDED_SUFFIX}`
        : uniqueLabel;
    return {
      value: rawLabel,
      option: { label: displayLabel, description: selectItemDescription(item) ?? baseLabel },
    };
  });
}

function answerSelections(answers: ProviderUserInputAnswers, questionId: string): string[] {
  const answer = answers[questionId];
  if (typeof answer === "string") {
    const trimmed = trimToUndefined(answer);
    return trimmed ? [trimmed] : [];
  }
  if (Array.isArray(answer)) {
    return answer.flatMap((entry) => {
      const trimmed = trimToUndefined(entry);
      return trimmed ? [trimmed] : [];
    });
  }
  if (answer && typeof answer === "object" && "selected" in answer) {
    const selected = answer.selected;
    if (typeof selected === "string") {
      const trimmed = trimToUndefined(selected);
      return trimmed ? [trimmed] : [];
    }
    return selected.flatMap((entry) => {
      const trimmed = trimToUndefined(entry);
      return trimmed ? [trimmed] : [];
    });
  }
  return [];
}

function answerNote(answers: ProviderUserInputAnswers, questionId: string): string | undefined {
  const answer = answers[questionId];
  if (!answer || typeof answer !== "object" || Array.isArray(answer)) return undefined;
  if (!("choiceNotes" in answer) || !answer.choiceNotes) return undefined;
  const notes = Object.values(answer.choiceNotes)
    .map((note) => trimToUndefined(note))
    .filter((note): note is string => note !== undefined);
  return notes.length > 0 ? notes.join("\n") : undefined;
}

function firstAnswer(answers: ProviderUserInputAnswers, questionId: string): string | undefined {
  return answerSelections(answers, questionId)[0];
}

/**
 * NuncioADE renders markdown, not ANSI, so every styling helper is identity. The
 * cast is deliberate: `Theme` is a TUI type whose full surface has no meaning
 * outside a terminal, and extensions only ever call these text helpers.
 */
const PLAIN_OMP_EXTENSION_THEME = {
  fg(_color: string, text: string) {
    return text;
  },
  bg(_color: string, text: string) {
    return text;
  },
  bold(text: string) {
    return text;
  },
  italic(text: string) {
    return text;
  },
  underline(text: string) {
    return text;
  },
  inverse(text: string) {
    return text;
  },
  strikethrough(text: string) {
    return text;
  },
  getFgAnsi() {
    return "";
  },
  getBgAnsi() {
    return "";
  },
  getColorMode() {
    return "truecolor";
  },
  getThinkingBorderColor() {
    return (text: string) => text;
  },
  getBashModeBorderColor() {
    return (text: string) => text;
  },
} as unknown as ExtensionUIContext["theme"];

export function makeOmpExtensionUiContext(bridge: OmpExtensionUiBridge): OmpExtensionUiContext {
  const statusTexts = new Map<string, string>();
  let workingMessage: string | undefined;

  const askDialog = async (
    questions: ExtensionAskDialogQuestion[],
    dialogOptions?: ExtensionUIDialogOptions,
  ): Promise<ExtensionAskDialogResult | undefined> => {
    const projected = questions.map((question, index) => {
      const header = trimToUndefined(question.header) ?? `Question ${String(index + 1)}`;
      const id = trimToUndefined(question.id) ?? header;
      return {
        id,
        mappings: makeUserInputOptions(question.options, question.recommended),
        recommended: question.recommended,
        multi: question.multi === true,
        question: trimToUndefined(question.question) ?? header,
        header,
      };
    });
    const { answers, timedOut } = await bridge.requestUserInput({
      method: "extension/ui/askDialog",
      opts: dialogOptions,
      rawPayload: { questions },
      questions: projected.map((entry) => ({
        id: entry.id,
        header: entry.header,
        question: entry.question,
        multiSelect: entry.multi,
        // The native ask dialog always allows a free-form answer and a note;
        // mirroring that keeps the NuncioADE dialog as expressive as the TUI one.
        allowCustomAnswer: true,
        allowNotes: true,
        options: entry.mappings.map((mapping) => mapping.option),
      })),
    });

    const results: ExtensionAskDialogResultItem[] = projected.map((entry) => {
      const selections = answerSelections(answers, entry.id);
      const selectedOptions: string[] = [];
      const custom: string[] = [];
      for (const selection of selections) {
        const mapping = entry.mappings.find((candidate) => candidate.option.label === selection);
        if (mapping) selectedOptions.push(mapping.value);
        else custom.push(selection);
      }
      // A deadline the user never answered resolves to the recommended option,
      // which is what the timeout is for; the engine reads `timedOut` to tell
      // that apart from a real choice.
      const recommended =
        timedOut && selectedOptions.length === 0 && custom.length === 0
          ? entry.mappings[entry.recommended ?? -1]
          : undefined;
      if (recommended) selectedOptions.push(recommended.value);
      const note = answerNote(answers, entry.id);
      const customInput = custom.length > 0 ? custom.join("\n") : undefined;
      return {
        id: entry.id,
        question: entry.question,
        options: entry.mappings.map((mapping) => mapping.value),
        multi: entry.multi,
        selectedOptions,
        ...(customInput !== undefined ? { customInput } : {}),
        ...(note !== undefined ? { note } : {}),
        ...(timedOut ? { timedOut: true } : {}),
      };
    });

    // Every question answered with nothing means the dialog was dismissed;
    // `undefined` is the engine's cancel signal. A timeout is not a dismissal.
    return !timedOut &&
      results.every((result) => result.selectedOptions.length === 0 && !result.customInput)
      ? undefined
      : { kind: "submit", results };
  };

  const askUserQuestions: OmpExtensionUiContext["askUserQuestions"] = async (
    rawQuestions,
    opts,
  ) => {
    const questions: UserInputQuestion[] = rawQuestions.map((question, index) => {
      const header = trimToUndefined(question.header) ?? `Question ${String(index + 1)}`;
      return {
        id: header,
        header,
        question: trimToUndefined(question.question) ?? header,
        multiSelect: question.multiSelect === true,
        allowCustomAnswer: true,
        allowNotes: true,
        options: question.options.map((option, optionIndex) => {
          const label = trimToUndefined(option.label) ?? `Option ${String(optionIndex + 1)}`;
          return { label, description: trimToUndefined(option.description) ?? label };
        }),
      };
    });
    const { answers } = await bridge.requestUserInput({
      method: "extension/ui/askUserQuestion",
      opts,
      questions,
      rawPayload: { questions: rawQuestions },
    });
    return answers;
  };

  const uiContext: ExtensionUIContext = {
    askDialog,
    async select(title, options, dialogOptions) {
      const questionId = "selection";
      const mappings = makeUserInputOptions(options);
      const { answers } = await bridge.requestUserInput({
        method: "extension/ui/select",
        opts: dialogOptions,
        rawPayload: { title, options },
        questions: [
          {
            id: questionId,
            header: trimToUndefined(title) ?? "OMP extension",
            question: trimToUndefined(title) ?? "Choose an option.",
            options: mappings.map((mapping) => mapping.option),
          },
        ],
      });
      const answer = firstAnswer(answers, questionId);
      return mappings.find((mapping) => mapping.option.label === answer)?.value;
    },
    async confirm(title, message, dialogOptions) {
      const questionId = "confirmation";
      const { answers } = await bridge.requestUserInput({
        method: "extension/ui/confirm",
        opts: dialogOptions,
        rawPayload: { title, message },
        questions: [
          {
            id: questionId,
            header: trimToUndefined(title) ?? "OMP extension",
            question: trimToUndefined(message) ?? trimToUndefined(title) ?? "Confirm this action?",
            options: [
              { label: "Yes", description: "Yes" },
              { label: "No", description: "No" },
            ],
          },
        ],
      });
      return firstAnswer(answers, questionId) === "Yes";
    },
    async input(title, placeholder, dialogOptions) {
      const questionId = "input";
      const { answers } = await bridge.requestUserInput({
        method: "extension/ui/input",
        opts: dialogOptions,
        rawPayload: { title, placeholder },
        questions: [
          {
            id: questionId,
            header: trimToUndefined(title) ?? "OMP extension",
            question: trimToUndefined(placeholder) ?? trimToUndefined(title) ?? "Type a response.",
            allowCustomAnswer: true,
            options: [],
          },
        ],
      });
      return firstAnswer(answers, questionId);
    },
    notify(message, type) {
      const normalized = trimToUndefined(message);
      if (!normalized) return;
      bridge.notify(normalized, type ?? "info");
    },
    onTerminalInput() {
      bridge.warnUnsupported("onTerminalInput");
      return () => undefined;
    },
    setStatus(key, text) {
      const normalizedKey = trimToUndefined(key) ?? "status";
      const normalizedText = trimToUndefined(text);
      if (!normalizedText) {
        statusTexts.delete(normalizedKey);
        return;
      }
      if (statusTexts.get(normalizedKey) === normalizedText) return;
      statusTexts.set(normalizedKey, normalizedText);
      bridge.emitProgress(`${normalizedKey}: ${normalizedText}`);
    },
    setWorkingMessage(message) {
      const normalized = trimToUndefined(message);
      if (!normalized || normalized === workingMessage) return;
      workingMessage = normalized;
      bridge.emitProgress(normalized);
    },
    setWidget() {
      bridge.warnUnsupported("setWidget");
    },
    setFooter() {
      bridge.warnUnsupported("setFooter");
    },
    setHeader() {
      bridge.warnUnsupported("setHeader");
    },
    setTitle(title) {
      const normalized = trimToUndefined(title);
      if (normalized) bridge.emitProgress(normalized);
    },
    async custom() {
      bridge.warnUnsupported("custom");
      return undefined as never;
    },
    setEditorText() {
      bridge.warnUnsupported("setEditorText");
    },
    pasteToEditor() {
      bridge.warnUnsupported("pasteToEditor");
    },
    getEditorText() {
      return "";
    },
    editor(title, prefill, dialogOptions) {
      return uiContext.input(title, prefill, dialogOptions);
    },
    addAutocompleteProvider() {
      bridge.warnUnsupported("addAutocompleteProvider");
    },
    setEditorComponent() {
      bridge.warnUnsupported("setEditorComponent");
    },
    theme: PLAIN_OMP_EXTENSION_THEME,
    async getAllThemes() {
      return [];
    },
    async getTheme() {
      return undefined;
    },
    async setTheme() {
      return { success: false, error: "NuncioADE does not expose OMP themes." };
    },
    getToolsExpanded() {
      return false;
    },
    setToolsExpanded() {},
  };

  return Object.assign(uiContext, { askUserQuestions });
}
