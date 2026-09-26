import { describe, expect, it } from "vitest";
import * as v from "valibot";
import { createDefaultCatalog } from "../src/index.js";

describe("block catalog", () => {
  it("registers every initial block once", () => {
    const catalog = createDefaultCatalog();
    expect(catalog.list()).toHaveLength(20);
    expect(new Set(catalog.list().map((block) => block.type)).size).toBe(20);
    expect(() => catalog.register(catalog.get("connector.call"))).toThrow("DUPLICATE_BLOCK");
  });
  it("keeps restaurant availability read-only and cannot report a booking", () => {
    const block = createDefaultCatalog().get("browser.availability");
    expect(block.effect).toBe("read");
    expect(block.capability).toBe("web.search");
    expect(block.requiresConfirmation).toBe(false);
    expect(v.safeParse(block.output, { text: "Available, not booked", booked: false }).success).toBe(true);
    expect(v.safeParse(block.output, { text: "Booked", booked: true }).success).toBe(false);
  });
  it("uses strict per-block inputs and outputs", () => {
    const catalog = createDefaultCatalog();
    expect(v.safeParse(catalog.get("content.generate").input, { brief: { instruction: "write", context: {}, outputSchema: "text", maxCharacters: 100 }, shell: "run" }).success).toBe(false);
    expect(v.safeParse(catalog.get("content.generate").output, { outputSchema: "text", text: "hello", shell: "run" }).success).toBe(false);
  });
});
