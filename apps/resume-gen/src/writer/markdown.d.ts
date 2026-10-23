// Bun bundles `import text from './file.md' with { type: 'text' }` as a string, including into
// compiled binaries. This declaration gives that import a type.
declare module '*.md' {
  const text: string;
  export default text;
}
