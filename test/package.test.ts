import { execSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { beforeAll, describe, expect, it } from "vitest";

const read = (p: string) => readFileSync(p, "utf8");
const importsReact = (code: string) => /from\s*["']react(-dom)?(\/[^"']*)?["']|import\s*["']react["']|require\(["']react/.test(code);

beforeAll(() => {
  execSync("npm run build", { stdio: "pipe" });
}, 180_000);

describe("built package", () => {
  it("emits every entry point, its types and the stylesheet", () => {
    for (const f of ["dist/index.js", "dist/index.d.ts", "dist/react/index.js", "dist/react/index.d.ts", "dist/testing/index.js", "dist/testing/index.d.ts", "dist/styles.css"]) {
      expect(existsSync(f), f).toBe(true);
    }
  });

  it("every path in package.json exports exists in dist", () => {
    const pkg = JSON.parse(read("package.json"));
    const paths: string[] = [];
    const walk = (v: unknown) => (typeof v === "string" ? paths.push(v) : Object.values(v as object).forEach(walk));
    walk(pkg.exports);
    expect(paths.length).toBeGreaterThanOrEqual(7);
    for (const p of paths) expect(existsSync(p), p).toBe(true);
  });

  it("the core entry does not import react, the react entry does", () => {
    expect(importsReact(read("dist/index.js"))).toBe(false);
    for (const f of readdirSync("dist").filter((n) => n.endsWith(".js"))) expect(importsReact(read(`dist/${f}`)), f).toBe(false);
    expect(importsReact(read("dist/react/index.js"))).toBe(true);
  });

  it("npm pack contains dist, README and LICENSE only", () => {
    const out = JSON.parse(execSync("npm pack --dry-run --json", { stdio: ["ignore", "pipe", "ignore"] }).toString());
    const paths: string[] = out[0].files.map((f: { path: string }) => f.path);
    expect(paths).toContain("dist/index.js");
    expect(paths).toContain("README.md");
    for (const p of paths) {
      expect(p.startsWith("src/") || p.startsWith("test/") || p.startsWith("specs/") || p.startsWith("plans/"), p).toBe(false);
    }
  });
});
