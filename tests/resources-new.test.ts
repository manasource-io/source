import { describe, expect, test } from "bun:test";
import { mintResourceId } from "../scripts/resources-new.ts";

describe("resources:new", () => {
  test("reproduces a published ID from its slug", () => {
    expect(mintResourceId("nutrition/supplements", "creatine")).toBe("DT4BVB7V");
  });

  test("re-hashes a taken ID", () => {
    const first = mintResourceId("nutrition/supplements", "creatine");
    expect(mintResourceId("nutrition/supplements", "creatine", new Set([first]))).not.toBe(first);
  });

  test("refuses a section with no prefix", () => {
    expect(() => mintResourceId("unknown", "thing")).toThrow("No ID prefix");
  });
});
