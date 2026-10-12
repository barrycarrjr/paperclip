import { describe, expect, it } from "vitest";
import { canonicalUuid } from "../lib/canonical-uuid.js";

const ID = "c0ffee00-beef-4dad-b0b0-facade123456";
const DIGITS = ID.replace(/-/g, "");

describe("canonicalUuid", () => {
  it("writes every spelling Postgres reads as this uuid the way Postgres writes it back", () => {
    for (const spelling of [
      ID,
      ID.toUpperCase(),
      DIGITS,
      DIGITS.toUpperCase(),
      `{${ID}}`,
      `{${ID.toUpperCase()}}`,
      `{${DIGITS}}`,
      DIGITS.match(/.{4}/g)!.join("-"),
    ]) {
      expect(canonicalUuid(spelling), spelling).toBe(ID);
    }
  });

  it("leaves anything that is not a uuid as it was", () => {
    for (const value of ["", "company-alice-personal", "HQ", "ME2", `${DIGITS}0`, DIGITS.slice(1), ` ${ID}`]) {
      expect(canonicalUuid(value), value).toBe(value);
    }
  });
});
