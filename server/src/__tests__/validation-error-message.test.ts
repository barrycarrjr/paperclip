import { describe, expect, it } from "vitest";
import { z } from "zod";
import { validationErrorMessage } from "../errors.js";

function failure(schema: z.ZodTypeAny, value: unknown) {
  const parsed = schema.safeParse(value);
  if (parsed.success) throw new Error("expected the value to be refused");
  return parsed.error;
}

describe("validationErrorMessage", () => {
  it("names the field and the problem in words, not the problem list as JSON", () => {
    const message = validationErrorMessage(failure(z.object({ text: z.string() }), {}));

    expect(message).toBe("Some details are not valid. text: Required.");
  });

  it("names a nested field by its whole path", () => {
    const schema = z.object({ env: z.object({ API_URL: z.object({ value: z.string() }) }) });
    const message = validationErrorMessage(failure(schema, { env: { API_URL: { value: 3 } } }));

    expect(message).toBe("Some details are not valid. env.API_URL.value: Expected string, received number.");
  });

  it("names the first three problems and counts the rest", () => {
    const schema = z.object({ a: z.string(), b: z.string(), c: z.string(), d: z.string(), e: z.string() });
    const message = validationErrorMessage(failure(schema, {}));

    expect(message).toBe("Some details are not valid. a: Required; b: Required; c: Required, and 2 more.");
  });

  it("words a problem with the whole body, which has no field", () => {
    const message = validationErrorMessage(failure(z.string(), 5));

    expect(message).toBe("Some details are not valid. Expected string, received number.");
  });
});
