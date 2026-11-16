// Stands in for the bundler's own typings (Vite's `vite/client`) so the example typechecks without a bundler.
declare module "*.css";
interface ImportMeta {
  readonly env: Record<string, string | undefined>;
}
