import { expect, it } from "vitest";
import * as v from "valibot";
import { AuthSessionResponseSchema } from "../src/api.js";

it("accepts anonymous and logged-out authentication session responses", () => {
  expect(
    v.parse(AuthSessionResponseSchema, {
      account: null,
      root: null,
      jawConfigured: true,
    }),
  ).toEqual({ account: null, root: null, jawConfigured: true });
  expect(
    v.parse(AuthSessionResponseSchema, {
      account: null,
      root: null,
      jawConfigured: false,
    }),
  ).toEqual({ account: null, root: null, jawConfigured: false });
});
