/** `?raw` markdown imports (Vite/Vitest), for the whole-document test fixture. */
declare module "*.md?raw" {
  const content: string;
  export default content;
}
