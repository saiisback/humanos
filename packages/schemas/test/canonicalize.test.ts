import { describe, expect, it } from "vitest";
import {
  canonicalize,
  hashCanonical,
  keccakCanonical,
} from "../src/canonicalize.js";
describe("canonical approval payloads", () => {
  it("makes nested object key order irrelevant and preserves array order", () => {
    expect(canonicalize({ z: 1, a: { c: 2, b: 3 } })).toBe(
      '{"a":{"b":3,"c":2},"z":1}',
    );
    expect(hashCanonical({ b: 2, a: 1 })).toBe(hashCanonical({ a: 1, b: 2 }));
    expect(hashCanonical([1, 2])).not.toBe(hashCanonical([2, 1]));
  });
  it("uses documented hash algorithms", () => {
    expect(hashCanonical(null)).toBe(
      "0x74234e98afe7498fb5daf1f36ac2d78acc339464f950703b8c019892f982b90b",
    );
    expect(keccakCanonical(null)).toMatch(/^0x[0-9a-f]{64}$/);
    expect(keccakCanonical(null)).not.toBe(hashCanonical(null));
  });
  it.each([
    undefined,
    NaN,
    Infinity,
    -Infinity,
    1n,
    () => 0,
    Symbol("x"),
    new Date(),
    new Map(),
    [, 1],
    { x: undefined },
    [undefined],
  ])("rejects unsupported input %s", (value) => {
    expect(() => canonicalize(value)).toThrow();
  });
  it("rejects cyclic structures", () => {
    const a: unknown[] = [];
    a.push(a);
    expect(() => canonicalize(a)).toThrow();
  });
  it("rejects accessors and invisible own keys", () => {
    expect(() =>
      canonicalize(
        Object.defineProperty({}, "x", {
          get() {
            return 1;
          },
          enumerable: true,
        }),
      ),
    ).toThrow();
    expect(() => canonicalize({ [Symbol("x")]: 1 })).toThrow();
    expect(() =>
      canonicalize(Object.defineProperty({}, "x", { value: 1 })),
    ).toThrow();
  });
  it("allows shared references and normalizes negative zero", () => {
    const x = { x: 1 };
    expect(canonicalize([x, x, -0])).toBe('[{"x":1},{"x":1},0]');
  });
});
