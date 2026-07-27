// FILE: pendingUserInput.ts
// Purpose: Normalize draft answers and progress for pending user input prompts.
// Layer: Web chat state utility
// Exports: Draft answer helpers and progress derivation used by ChatView/composer panels.

import type { ProviderUserInputAnswers, UserInputQuestion } from "@synara/contracts";

export interface PendingUserInputDraftAnswer {
  selectedOptionLabels?: string[];
  customAnswer?: string;
  // Optional per-choice notes keyed by option label (questions with allowNotes).
  choiceNotes?: Record<string, string>;
}

export interface PendingUserInputProgress {
  questionIndex: number;
  activeQuestion: UserInputQuestion | null;
  activeDraft: PendingUserInputDraftAnswer | undefined;
  selectedOptionLabels: string[];
  customAnswer: string;
  resolvedAnswer: string | string[] | null;
  usingCustomAnswer: boolean;
  answeredQuestionCount: number;
  isLastQuestion: boolean;
  isComplete: boolean;
  canAdvance: boolean;
}

function normalizeDraftAnswer(value: string | undefined): string | null {
  if (typeof value !== "string") {
    return null;
  }

  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

// Normalize option selections so UI and submit logic can share one canonical list.
function normalizeSelectedOptionLabels(value: string[] | undefined): string[] {
  if (!Array.isArray(value)) {
    return [];
  }

  const normalized = value
    .filter((entry): entry is string => typeof entry === "string")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);

  return Array.from(new Set(normalized));
}

export function resolvePendingUserInputAnswer(
  question: UserInputQuestion,
  draft: PendingUserInputDraftAnswer | undefined,
): string | string[] | null {
  const customAnswer = normalizeDraftAnswer(draft?.customAnswer);
  if (customAnswer) {
    return customAnswer;
  }

  const selectedOptionLabels = normalizeSelectedOptionLabels(draft?.selectedOptionLabels);
  if (question.multiSelect) {
    return selectedOptionLabels.length > 0 ? selectedOptionLabels : null;
  }

  return selectedOptionLabels[0] ?? null;
}

export function setPendingUserInputCustomAnswer(
  draft: PendingUserInputDraftAnswer | undefined,
  customAnswer: string,
): PendingUserInputDraftAnswer {
  const selectedOptionLabels =
    customAnswer.trim().length > 0
      ? undefined
      : normalizeSelectedOptionLabels(draft?.selectedOptionLabels);

  return {
    customAnswer,
    ...(selectedOptionLabels && selectedOptionLabels.length > 0 ? { selectedOptionLabels } : {}),
    ...(draft?.choiceNotes ? { choiceNotes: draft.choiceNotes } : {}),
  };
}

export function setPendingUserInputChoiceNote(
  draft: PendingUserInputDraftAnswer | undefined,
  optionLabel: string,
  note: string,
): PendingUserInputDraftAnswer {
  const nextNotes = { ...draft?.choiceNotes };
  if (note.trim().length > 0) {
    nextNotes[optionLabel] = note;
  } else {
    delete nextNotes[optionLabel];
  }
  const { choiceNotes: _dropped, ...rest } = draft ?? {};
  return {
    ...rest,
    customAnswer: draft?.customAnswer ?? "",
    ...(Object.keys(nextNotes).length > 0 ? { choiceNotes: nextNotes } : {}),
  };
}

// Notes attached to option labels that are actually selected (stale notes for
// deselected options are dropped at submit time, mirroring the TUI extension).
function selectedChoiceNotes(
  draft: PendingUserInputDraftAnswer | undefined,
  selected: string | string[],
): Record<string, string> | undefined {
  if (!draft?.choiceNotes) return undefined;
  const selectedLabels = new Set(Array.isArray(selected) ? selected : [selected]);
  const entries = Object.entries(draft.choiceNotes).filter(
    ([label, note]) => selectedLabels.has(label) && note.trim().length > 0,
  );
  return entries.length > 0 ? Object.fromEntries(entries) : undefined;
}

// Toggle selections in-place so multi-select prompts can keep the same draft state shape.
export function togglePendingUserInputOptionSelection(
  question: UserInputQuestion,
  draft: PendingUserInputDraftAnswer | undefined,
  optionLabel: string,
): PendingUserInputDraftAnswer {
  const preservedNotes = draft?.choiceNotes ? { choiceNotes: draft.choiceNotes } : {};
  if (question.multiSelect) {
    const selectedOptionLabels = normalizeSelectedOptionLabels(draft?.selectedOptionLabels);
    const nextSelectedOptionLabels = selectedOptionLabels.includes(optionLabel)
      ? selectedOptionLabels.filter((label) => label !== optionLabel)
      : [...selectedOptionLabels, optionLabel];

    return {
      customAnswer: "",
      ...(nextSelectedOptionLabels.length > 0
        ? { selectedOptionLabels: nextSelectedOptionLabels }
        : {}),
      ...preservedNotes,
    };
  }

  return {
    customAnswer: "",
    selectedOptionLabels: [optionLabel],
    ...preservedNotes,
  };
}

export function buildPendingUserInputAnswers(
  questions: ReadonlyArray<UserInputQuestion>,
  draftAnswers: Record<string, PendingUserInputDraftAnswer>,
): ProviderUserInputAnswers | null {
  const answers: Record<string, ProviderUserInputAnswers[string]> = {};

  for (const question of questions) {
    const draft = draftAnswers[question.id];
    const answer = resolvePendingUserInputAnswer(question, draft);
    if (!answer) {
      return null;
    }
    const choiceNotes = question.allowNotes ? selectedChoiceNotes(draft, answer) : undefined;
    answers[question.id] = choiceNotes ? { selected: answer, choiceNotes } : answer;
  }

  return answers;
}

export function hasCompletePendingUserInputAnswers(answers: ProviderUserInputAnswers): boolean {
  const entries = Object.entries(answers);
  if (entries.length === 0) {
    return false;
  }

  const hasValue = (value: string | ReadonlyArray<string>): boolean => {
    if (typeof value === "string") {
      return value.trim().length > 0;
    }
    return value.some((entry) => typeof entry === "string" && entry.trim().length > 0);
  };

  return entries.every(([, answer]) => {
    if (answer === null || answer === undefined) {
      return false;
    }
    if (typeof answer === "string") {
      return hasValue(answer);
    }
    if ("selected" in answer && !Array.isArray(answer)) {
      return hasValue(answer.selected);
    }
    return hasValue(answer as ReadonlyArray<string>);
  });
}

export function omitNullPendingUserInputAnswers(
  answers: ProviderUserInputAnswers,
): ProviderUserInputAnswers {
  return Object.fromEntries(
    Object.entries(answers).filter(([, answer]) => answer !== null && answer !== undefined),
  );
}

export function countAnsweredPendingUserInputQuestions(
  questions: ReadonlyArray<UserInputQuestion>,
  draftAnswers: Record<string, PendingUserInputDraftAnswer>,
): number {
  return questions.reduce((count, question) => {
    return resolvePendingUserInputAnswer(question, draftAnswers[question.id]) ? count + 1 : count;
  }, 0);
}

export function findFirstUnansweredPendingUserInputQuestionIndex(
  questions: ReadonlyArray<UserInputQuestion>,
  draftAnswers: Record<string, PendingUserInputDraftAnswer>,
): number {
  const unansweredIndex = questions.findIndex(
    (question) => !resolvePendingUserInputAnswer(question, draftAnswers[question.id]),
  );

  return unansweredIndex === -1 ? Math.max(questions.length - 1, 0) : unansweredIndex;
}

export function derivePendingUserInputProgress(
  questions: ReadonlyArray<UserInputQuestion>,
  draftAnswers: Record<string, PendingUserInputDraftAnswer>,
  questionIndex: number,
): PendingUserInputProgress {
  const normalizedQuestionIndex =
    questions.length === 0 ? 0 : Math.max(0, Math.min(questionIndex, questions.length - 1));
  const activeQuestion = questions[normalizedQuestionIndex] ?? null;
  const activeDraft = activeQuestion ? draftAnswers[activeQuestion.id] : undefined;
  const resolvedAnswer = activeQuestion
    ? resolvePendingUserInputAnswer(activeQuestion, activeDraft)
    : null;
  const customAnswer = activeDraft?.customAnswer ?? "";
  const answeredQuestionCount = countAnsweredPendingUserInputQuestions(questions, draftAnswers);
  const isLastQuestion =
    questions.length === 0 ? true : normalizedQuestionIndex >= questions.length - 1;

  return {
    questionIndex: normalizedQuestionIndex,
    activeQuestion,
    activeDraft,
    selectedOptionLabels: normalizeSelectedOptionLabels(activeDraft?.selectedOptionLabels),
    customAnswer,
    resolvedAnswer,
    usingCustomAnswer: customAnswer.trim().length > 0,
    answeredQuestionCount,
    isLastQuestion,
    isComplete: buildPendingUserInputAnswers(questions, draftAnswers) !== null,
    canAdvance: Boolean(resolvedAnswer),
  };
}
