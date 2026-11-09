/** Stylesheets are imported for their effect, and Vite bundles them. */
declare module '*.css';

/** A file imported as text, which Vite and Vitest provide. */
declare module '*?raw' {
  const content: string;
  export default content;
}
