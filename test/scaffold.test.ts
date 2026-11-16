import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import * as core from "../src/index";

const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));

describe("scaffold", () => {
  it("exports VERSION matching package.json", () => {
    expect(core.VERSION).toBe(pkg.version);
  });
});
