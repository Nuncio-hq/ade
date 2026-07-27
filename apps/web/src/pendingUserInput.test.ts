import { describe, expect, it } from "vitest";

import {
  buildPendingUserInputAnswers,
  countAnsweredPendingUserInputQuestions,
  derivePendingUserInputProgress,
  findFirstUnansweredPendingUserInputQuestionIndex,
  hasCompletePendingUserInputAnswers,
  resolvePendingUserInputAnswer,
  setPendingUserInputChoiceNote,
  setPendingUserInputCustomAnswer,
  togglePendingUserInputOptionSelection,
} from "./pendingUserInput";

describe("resolvePendingUserInputAnswer", () => {
  it("prefers a custom answer over a selected option", () => {
    expect(
      resolvePendingUserInputAnswer(
        {
          id: "compat",
          header: "Compat",
          question: "How strict should compatibility be?",
          options: [],
        },
        {
          selectedOptionLabels: ["Keep current envelope"],
          customAnswer: "Keep the existing envelope for one release",
        },
      ),
    ).toBe("Keep the existing envelope for one release");
  });

  it("falls back to the selected option", () => {
    expect(
      resolvePendingUserInputAnswer(
        {
          id: "scope",
          header: "Scope",
          question: "What should the plan target first?",
          options: [],
        },
        {
          selectedOptionLabels: ["Scaffold only"],
        },
      ),
    ).toBe("Scaffold only");
  });

  it("clears the preset selection when a custom answer is entered", () => {
    expect(
      setPendingUserInputCustomAnswer(
        {
          selectedOptionLabels: ["Preserve existing tags"],
        },
        "doesn't matter",
      ),
    ).toEqual({
      customAnswer: "doesn't matter",
    });
  });

  it("returns all selected options for multi-select questions", () => {
    expect(
      resolvePendingUserInputAnswer(
        {
          id: "targets",
          header: "Targets",
          question: "Which outputs should we ship?",
          multiSelect: true,
          options: [],
        },
        {
          selectedOptionLabels: ["CLI", "Desktop"],
        },
      ),
    ).toEqual(["CLI", "Desktop"]);
  });
});

describe("togglePendingUserInputOptionSelection", () => {
  it("toggles options for multi-select questions", () => {
    const question = {
      id: "targets",
      header: "Targets",
      question: "Which outputs should we ship?",
      multiSelect: true,
      options: [],
    } as const;

    expect(
      togglePendingUserInputOptionSelection(question, { selectedOptionLabels: ["CLI"] }, "Desktop"),
    ).toEqual({
      customAnswer: "",
      selectedOptionLabels: ["CLI", "Desktop"],
    });

    expect(
      togglePendingUserInputOptionSelection(
        question,
        { selectedOptionLabels: ["CLI", "Desktop"] },
        "CLI",
      ),
    ).toEqual({
      customAnswer: "",
      selectedOptionLabels: ["Desktop"],
    });
  });
});

describe("buildPendingUserInputAnswers", () => {
  it("returns a canonical answer map for complete prompts", () => {
    expect(
      buildPendingUserInputAnswers(
        [
          {
            id: "scope",
            header: "Scope",
            question: "What should the plan target first?",
            options: [
              {
                label: "Orchestration-first",
                description: "Focus on orchestration first",
              },
            ],
          },
          {
            id: "compat",
            header: "Compat",
            question: "How strict should compatibility be?",
            options: [
              {
                label: "Keep current envelope",
                description: "Preserve current wire format",
              },
            ],
          },
        ],
        {
          scope: {
            selectedOptionLabels: ["Orchestration-first"],
          },
          compat: {
            customAnswer: "Keep the current envelope for one release window",
          },
        },
      ),
    ).toEqual({
      scope: "Orchestration-first",
      compat: "Keep the current envelope for one release window",
    });
  });

  it("returns null when any question is unanswered", () => {
    expect(
      buildPendingUserInputAnswers(
        [
          {
            id: "scope",
            header: "Scope",
            question: "What should the plan target first?",
            options: [
              {
                label: "Orchestration-first",
                description: "Focus on orchestration first",
              },
            ],
          },
        ],
        {},
      ),
    ).toBeNull();
  });
});

describe("hasCompletePendingUserInputAnswers", () => {
  it("accepts non-empty string and array answers", () => {
    expect(
      hasCompletePendingUserInputAnswers({
        language: "TypeScript",
        features: ["Auth", "Testing"],
      }),
    ).toBe(true);
  });

  it("rejects null and empty answers before dispatch", () => {
    expect(
      hasCompletePendingUserInputAnswers({
        language: null,
        features: [],
      }),
    ).toBe(false);
  });
});

describe("pending user input question progress", () => {
  const questions = [
    {
      id: "scope",
      header: "Scope",
      question: "What should the plan target first?",
      options: [
        {
          label: "Orchestration-first",
          description: "Focus on orchestration first",
        },
      ],
    },
    {
      id: "compat",
      header: "Compat",
      question: "How strict should compatibility be?",
      options: [
        {
          label: "Keep current envelope",
          description: "Preserve current wire format",
        },
      ],
    },
  ] as const;

  it("counts only answered questions", () => {
    expect(
      countAnsweredPendingUserInputQuestions(questions, {
        scope: {
          selectedOptionLabels: ["Orchestration-first"],
        },
      }),
    ).toBe(1);
  });

  it("finds the first unanswered question", () => {
    expect(
      findFirstUnansweredPendingUserInputQuestionIndex(questions, {
        scope: {
          selectedOptionLabels: ["Orchestration-first"],
        },
      }),
    ).toBe(1);
  });

  it("returns the last question index when all answers are complete", () => {
    expect(
      findFirstUnansweredPendingUserInputQuestionIndex(questions, {
        scope: {
          selectedOptionLabels: ["Orchestration-first"],
        },
        compat: {
          customAnswer: "Keep it for one release window",
        },
      }),
    ).toBe(1);
  });

  it("derives the active question and advancement state", () => {
    expect(
      derivePendingUserInputProgress(
        questions,
        {
          scope: {
            selectedOptionLabels: ["Orchestration-first"],
          },
        },
        0,
      ),
    ).toMatchObject({
      questionIndex: 0,
      activeQuestion: questions[0],
      selectedOptionLabels: ["Orchestration-first"],
      customAnswer: "",
      resolvedAnswer: "Orchestration-first",
      answeredQuestionCount: 1,
      isLastQuestion: false,
      isComplete: false,
      canAdvance: true,
    });
  });
});

describe("choice notes (allowNotes questions)", () => {
  const notesQuestion = {
    id: "Approval",
    header: "Approval",
    question: "Ship it?",
    allowNotes: true,
    options: [
      { label: "Yes", description: "Ship now" },
      { label: "No", description: "Hold" },
    ],
  };

  it("setPendingUserInputChoiceNote stores and clears notes by option label", () => {
    let draft = setPendingUserInputChoiceNote(undefined, "Yes", "after smoke tests");
    expect(draft.choiceNotes).toEqual({ Yes: "after smoke tests" });
    draft = setPendingUserInputChoiceNote(draft, "Yes", "   ");
    expect(draft.choiceNotes).toBeUndefined();
  });

  it("togglePendingUserInputOptionSelection preserves existing notes", () => {
    const withNote = setPendingUserInputChoiceNote(undefined, "Yes", "with caveats");
    const toggled = togglePendingUserInputOptionSelection(notesQuestion, withNote, "Yes");
    expect(toggled.selectedOptionLabels).toEqual(["Yes"]);
    expect(toggled.choiceNotes).toEqual({ Yes: "with caveats" });
  });

  it("buildPendingUserInputAnswers emits structured answers only for noted selections", () => {
    const draft = togglePendingUserInputOptionSelection(
      notesQuestion,
      setPendingUserInputChoiceNote(undefined, "Yes", "with caveats"),
      "Yes",
    );
    expect(buildPendingUserInputAnswers([notesQuestion], { Approval: draft })).toEqual({
      Approval: { selected: "Yes", choiceNotes: { Yes: "with caveats" } },
    });

    // Note attached to an unselected option is dropped.
    const noteOnUnselected = togglePendingUserInputOptionSelection(
      notesQuestion,
      setPendingUserInputChoiceNote(undefined, "No", "not yet"),
      "Yes",
    );
    expect(buildPendingUserInputAnswers([notesQuestion], { Approval: noteOnUnselected })).toEqual({
      Approval: "Yes",
    });
  });

  it("plain questions keep emitting plain string answers", () => {
    const plainQuestion = { ...notesQuestion, allowNotes: undefined };
    const draft = togglePendingUserInputOptionSelection(
      plainQuestion,
      setPendingUserInputChoiceNote(undefined, "Yes", "ignored"),
      "Yes",
    );
    expect(buildPendingUserInputAnswers([plainQuestion], { Approval: draft })).toEqual({
      Approval: "Yes",
    });
  });

  it("hasCompletePendingUserInputAnswers accepts structured answers", () => {
    expect(
      hasCompletePendingUserInputAnswers({
        Approval: { selected: "Yes", choiceNotes: { Yes: "note" } },
      }),
    ).toBe(true);
    expect(hasCompletePendingUserInputAnswers({ Approval: { selected: "" } })).toBe(false);
  });
});
