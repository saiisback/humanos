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
const config = (body: unknown) => ({
  apiKey: "secret",
  retries: 0,
  fetch: vi.fn(async () => new Response(JSON.stringify(body))),
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
it("rejects invented Jev candidates", async () => {
  await expect(
    createWorkflowSelector(config(answer("shell.exec"))).select(input),
  ).rejects.toThrow("Model integration unavailable");
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
    .mockResolvedValueOnce(new Response(JSON.stringify(answer())))
    .mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          model: "jev-1.13",
          answers: { p0: choice("o1", ["o0", "o1"]) },
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
    .mockResolvedValueOnce(new Response(JSON.stringify(answer())))
    .mockResolvedValueOnce(new Response(JSON.stringify({ model: "jev-1.13", answers: { p0: choice("o0", ["o0", "o1"]) } })));
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
    .mockResolvedValueOnce(new Response(JSON.stringify(answer())))
    .mockResolvedValueOnce(new Response(JSON.stringify({ model: "jev-1.13", answers: { p0: choice("o0", ["o0", "o1"]) } })));
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
    .mockResolvedValueOnce(new Response(JSON.stringify(answer())))
    .mockResolvedValueOnce(
      new Response(
        JSON.stringify({ model: "jev-1.13", answers: { p0: choice("o99") } }),
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
