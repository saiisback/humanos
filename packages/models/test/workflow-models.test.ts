import { expect, it, vi } from "vitest";
import { hashCanonical } from "@humanos/schemas";
import {
  createContentGenerator,
  createWorkflowSelector,
} from "../src/index.js";

const choice = (id: string, keys = [id]) => ({
  type: "choice",
  choice: id,
  confidence: 0.99,
  probabilities: Object.fromEntries(keys.map((k) => [k, k === id ? 1 : 0])),
});
const answer = (selected = "c0") => ({
  model: "jev-1.13",
  answers: {
    selection: choice(selected),
    alignment: { type: "noul", noul: 0.99 },
    risk: { type: "noul", noul: 0.01 },
    injection: { type: "noul", noul: 0.01 },
    review: { type: "noul", noul: 0.01 },
  },
});
const input = {
  goal: "Write a draft",
  stateHash: hashCanonical({}),
  turn: 0,
  candidates: [
    {
      id: "candidate_1",
      type: "content.generate" as const,
      description: "Generate draft content",
      parameterOptions: {},
    },
  ],
};
const evaluation = () => { const { selection, ...scores } = answer().answers; return scores; };
const selection = (selected = "c0") => ({ model: "jev-1.13", answers: { selection: choice(selected) } });
const config = (body: unknown) => ({
  apiKey: "secret",
  retries: 0,
  fetch: vi.fn(async (_url: unknown, init?: RequestInit) => {
    const request = JSON.parse(String(init?.body ?? "{}"));
    if (request.questions && body && typeof body === "object" && "answers" in body) {
      const raw = body as ReturnType<typeof answer>;
      return new Response(JSON.stringify({ ...raw, answers: Object.fromEntries(Object.entries(raw.answers).filter(([key]) => key in request.questions)) }));
    }
    return new Response(JSON.stringify(body));
  }),
});
it("evaluates the chosen candidate only after selection exists", async () => {
  const settings = config(answer());
  await createWorkflowSelector(settings).select(input);
  expect(settings.fetch).toHaveBeenCalledTimes(2);
  const first = JSON.parse(String(settings.fetch.mock.calls[0]![1]!.body));
  const second = JSON.parse(String(settings.fetch.mock.calls[1]![1]!.body));
  expect(Object.keys(first.questions)).toEqual(["selection"]);
  expect(second.state.candidate).toEqual({ id: "c0", type: "content.generate" });
  expect(second.questions.injection.criteria.false).toContain("ordinary user request");
});
it("parses SystemOne answers for an offered opaque candidate", async () => {
  const settings = config(answer());
  expect(await createWorkflowSelector(settings).select(input)).toMatchObject({
    selectedCandidateId: "candidate_1",
    parameters: {},
    alignment: 0.99,
  });
  const call = settings.fetch.mock.calls[0] as unknown as [string, RequestInit];
  const body = JSON.parse(String(call[1].body));
  expect(body.questions.selection.criteria).toEqual({
    c0: "Generate content",
  });
  expect(body.state.candidates).toEqual([{ id: "c0", type: "content.generate", parameters: [] }]);
  expect(body.model).toBe("jev-1.13");
});
it("describes risk as unsafe draft assembly rather than a future gated effect", async () => {
  const settings = config(answer());
  await createWorkflowSelector(settings).select({ ...input, history: ["human.confirm"], candidates: [{
    id: "candidate_email", type: "connector.call", description: "Send a reviewed email", parameterOptions: {},
  }] });
  const call = settings.fetch.mock.calls[0] as unknown as [string, RequestInit];
  const body = JSON.parse(String(call[1].body));
  const evaluation = JSON.parse(String(settings.fetch.mock.calls[1]![1]!.body));
  expect(evaluation.questions.risk.instructions).toContain("adding this block to the proposed graph");
  expect(evaluation.questions.risk.instructions).toContain("does not execute");
  expect(evaluation.questions.risk.instructions).toContain("gated future external effect");
  expect(evaluation.questions.review.instructions).toContain("missing user choice");
  expect(body.questions.selection.instructions).toContain("plan contains all necessary steps");
  expect(body.state.history).toEqual(["human.confirm"]);
});
it("defines complete as ending graph assembly for user review, with uncertain coverage flagged", async () => {
  const raw = answer("c1");
  raw.answers.selection = choice("c1", ["c0", "c1"]);
  raw.answers.review.noul = 0.9;
  const settings = config(raw);
  const result = await createWorkflowSelector(settings).select({ ...input, candidates: [input.candidates[0]!, {
    id: "candidate_complete", type: "complete", description: "Finish", parameterOptions: {},
  }] });
  expect(result).toMatchObject({ selectedCandidateId: "candidate_complete", needsReview: true });
  const call = settings.fetch.mock.calls[0] as unknown as [string, RequestInit];
  const body = JSON.parse(String(call[1].body));
  expect(body.questions.selection.criteria.c1).toContain("proposed workflow graph");
  expect(body.questions.selection.criteria.c1).toContain("No steps have run");
});
it("rejects invented Jev candidates", async () => {
  await expect(
    createWorkflowSelector(config(answer("shell.exec"))).select(input),
  ).rejects.toThrow("Model integration unavailable");
});
it("rejects an over-complete first response rather than accepting unsolicited scores", async () => {
  const fetcher = vi.fn().mockResolvedValueOnce(new Response(JSON.stringify(answer())));
  await expect(createWorkflowSelector({ apiKey: "secret", retries: 0, fetch: fetcher }).select(input)).rejects.toThrow("Model integration unavailable");
  expect(fetcher).toHaveBeenCalledTimes(1);
});
it("rejects two candidates of the same catalog type before a provider request", async () => {
  const settings = config(answer());
  await expect(createWorkflowSelector(settings).select({
    ...input,
    candidates: [
      input.candidates[0]!,
      {
        ...input.candidates[0]!,
        id: "candidate_2",
        description: "Generate different content",
      },
    ],
  })).rejects.toThrow("Model integration unavailable");
  expect(settings.fetch).not.toHaveBeenCalled();
});
it("rejects non-enumerated parameter options before a provider call", async () => {
  const settings = config(answer());
  await expect(
    createWorkflowSelector(settings).select({
      ...input,
      candidates: [
        {
          ...input.candidates[0]!,
          parameterOptions: { code: "run arbitrary code" },
        },
      ],
    }),
  ).rejects.toThrow();
  expect(settings.fetch).not.toHaveBeenCalled();
});
it("selects only offered parameter values using opaque option IDs", async () => {
  const fetcher = vi
    .fn()
    .mockResolvedValueOnce(new Response(JSON.stringify(selection())))
    .mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          model: "jev-1.13",
          answers: { ...evaluation(), p0: choice("o1", ["o0", "o1"]) },
        }),
      ),
    );
  const selected = await createWorkflowSelector({
    apiKey: "secret",
    fetch: fetcher,
  }).select({
    ...input,
    candidates: [
      { ...input.candidates[0]!, parameterOptions: { length: [100, 200] } },
    ],
  });
  expect(selected.parameters).toEqual({ length: 200 });
});
it("projects bounded block history into both Jev requests and accepts safe dotted parameter paths", async () => {
  const fetcher = vi.fn()
    .mockResolvedValueOnce(new Response(JSON.stringify(selection())))
    .mockResolvedValueOnce(new Response(JSON.stringify({ model: "jev-1.13", answers: { ...evaluation(), p0: choice("o0", ["o0", "o1"]) } })));
  const result = await createWorkflowSelector({ apiKey: "secret", fetch: fetcher }).select({
    ...input,
    history: ["research.web"],
    candidates: [{ ...input.candidates[0]!, parameterOptions: { "brief.outputSchema": ["text", "email"] } }],
  });
  expect(result.parameters).toEqual({ "brief.outputSchema": "text" });
  for (const call of fetcher.mock.calls) {
    const body = JSON.parse(String((call[1] as RequestInit).body));
    expect(body.state.history).toEqual(["research.web"]);
  }
});
it("rejects prototype parameter paths before sending to Jev", async () => {
  const settings = config(answer());
  await expect(createWorkflowSelector(settings).select({
    ...input,
    candidates: [{ ...input.candidates[0]!, parameterOptions: { "brief.__proto__": ["text"] } }],
  })).rejects.toThrow("Model integration unavailable");
  expect(settings.fetch).not.toHaveBeenCalled();
});
it("keeps descriptions, IDs, and arbitrary option strings out of both Jev requests", async () => {
  const fetcher = vi
    .fn()
    .mockResolvedValueOnce(new Response(JSON.stringify(selection())))
    .mockResolvedValueOnce(new Response(JSON.stringify({ model: "jev-1.13", answers: { ...evaluation(), p0: choice("o0", ["o0", "o1"]) } })));
  const sensitive = "CREDENTIAL_MARKER_DO_NOT_TRANSMIT";
  const selected = await createWorkflowSelector({ apiKey: "secret", fetch: fetcher }).select({
    ...input,
    candidates: [{
      ...input.candidates[0]!,
      id: `candidate_${sensitive}`,
      description: `Copied page body ${sensitive}`,
      parameterOptions: { CREDENTIAL_MARKER_DO_NOT_TRANSMIT: [100, 200] },
    }],
  });
  expect(selected.selectedCandidateId).toBe(`candidate_${sensitive}`);
  expect(selected.parameters).toEqual({ CREDENTIAL_MARKER_DO_NOT_TRANSMIT: 100 });
  for (const call of fetcher.mock.calls) {
    const body = String((call[1] as RequestInit).body);
    expect(body).not.toContain(sensitive);
    expect(body).not.toContain("Copied page body");
    expect(body).not.toContain("candidate_");
  }
  const secondBody = JSON.parse(String((fetcher.mock.calls[1]![1] as RequestInit).body));
  expect(secondBody.state.candidate).toEqual({ id: "c0", type: "content.generate" });
});
it("rejects arbitrary string options before sending any Jev request", async () => {
  const settings = config(answer());
  await expect(createWorkflowSelector(settings).select({
    ...input,
    candidates: [{ ...input.candidates[0]!, parameterOptions: { password: ["CREDENTIAL_MARKER_DO_NOT_TRANSMIT"] } }],
  })).rejects.toThrow("Model integration unavailable");
  expect(settings.fetch).not.toHaveBeenCalled();
});
const brief = {
  instruction: "Write a greeting",
  context: {},
  outputSchema: "text" as const,
  maxCharacters: 20,
};
const completion = (value: unknown) => ({
  model: "deepseek-v4.1-flash",
  choices: [
    { finish_reason: "stop", message: { content: JSON.stringify(value) } },
  ],
});
it("generates content only", async () => {
  expect(
    await createContentGenerator(
      config(completion({ outputSchema: "text", text: "Hello" })),
    ).generate(brief),
  ).toEqual({ outputSchema: "text", text: "Hello" });
});
it.each([
  { outputSchema: "text", text: "Hi", execute: true },
  { outputSchema: "email", subject: "Hi", body: "Hello" },
  { outputSchema: "text", text: "x".repeat(21) },
])(
  "rejects content authority, mismatched schema, or excess length",
  async (value) => {
    await expect(
      createContentGenerator(config(completion(value))).generate(brief),
    ).rejects.toThrow("Model integration unavailable");
  },
);
it("rejects insecure endpoint overrides", () => {
  expect(() =>
    createContentGenerator({ ...config({}), endpoint: "http://example.com" }),
  ).toThrow();
  expect(() =>
    createWorkflowSelector({ ...config({}), endpoint: "http://example.com" }),
  ).toThrow();
});
it("rejects an invented parameter choice", async () => {
  const fetcher = vi
    .fn()
    .mockResolvedValueOnce(new Response(JSON.stringify(selection())))
    .mockResolvedValueOnce(
      new Response(
        JSON.stringify({ model: "jev-1.13", answers: { ...evaluation(), p0: choice("o99") } }),
      ),
    );
  await expect(
    createWorkflowSelector({ apiKey: "secret", fetch: fetcher }).select({
      ...input,
      candidates: [
        { ...input.candidates[0]!, parameterOptions: { length: [100, 200] } },
      ],
    }),
  ).rejects.toThrow("Model integration unavailable");
});
it("rejects inconsistent choice probabilities", async () => {
  const raw = answer();
  raw.answers.selection.probabilities.candidate_1 = 0.5;
  await expect(
    createWorkflowSelector(config(raw)).select(input),
  ).rejects.toThrow("Model integration unavailable");
});
it("logs only model IDs and hashes rather than prompts or keys", async () => {
  const log = vi.fn();
  await createContentGenerator({
    ...config(completion({ outputSchema: "text", text: "Hello" })),
    log,
  }).generate(brief);
  const serialized = JSON.stringify(log.mock.calls);
  expect(serialized).not.toContain("secret");
  expect(serialized).not.toContain(brief.instruction);
  expect(log).toHaveBeenCalledWith(
    expect.objectContaining({
      modelVersion: "deepseek-v4.1-flash",
      inputHash: expect.stringMatching(/^0x[0-9a-f]{64}$/),
    }),
  );
});
