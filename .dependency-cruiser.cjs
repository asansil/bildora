/**
 * Package dependency direction.
 * `tsPreCompilationDeps` makes type-only imports count too.
 */
const ui = '^(electron|react|react-dom)$|node_modules/.*/(electron|react|react-dom)/';

module.exports = {
  forbidden: [
    {
      name: 'packages-not-to-apps',
      comment: 'Apps depend on packages; a package never depends on an app.',
      severity: 'error',
      from: { path: '^packages/' },
      to: { path: '^apps/' },
    },
    {
      name: 'apps-not-to-other-apps',
      comment: 'Clients are independent; shared logic belongs in a package.',
      severity: 'error',
      from: { path: '^apps/([^/]+)/' },
      to: { path: '^apps/', pathNot: '^apps/$1/' },
    },
    {
      name: 'core-stays-headless',
      comment: 'Core must run without Electron or a UI.',
      severity: 'error',
      from: { path: '^packages/core/' },
      to: { path: ui },
    },
    {
      name: 'protocol-stands-alone',
      comment: 'Every consumer agrees on protocol, so it depends on nothing internal.',
      severity: 'error',
      from: { path: '^packages/protocol/' },
      to: { path: '^packages/', pathNot: '^packages/protocol/' },
    },
    {
      name: 'renderer-stays-unprivileged',
      comment: 'The renderer reaches the OS only through the preload bridge.',
      severity: 'error',
      from: { path: '^apps/desktop/src/renderer/' },
      to: { path: '^packages/core/|^electron$|node_modules/.*/electron/' },
    },
    {
      name: 'no-reaching-into-source',
      comment: 'Another package is reached through its exports, never through its files.',
      severity: 'error',
      from: { path: '^(apps|packages)/([^/]+)/' },
      to: { path: '^packages/[^/]+/src/', pathNot: '^$1/$2/' },
    },
    {
      name: 'not-to-unresolvable',
      comment: 'An import that cannot be resolved would escape the rules above.',
      severity: 'error',
      from: {},
      to: { couldNotResolve: true },
    },
  ],
  options: {
    doNotFollow: { path: 'node_modules' },
    tsPreCompilationDeps: true,
    enhancedResolveOptions: {
      conditionNames: ['types', 'import', 'default'],
      extensions: ['.ts', '.tsx', '.js', '.json'],
      exportsFields: ['exports'],
    },
  },
};
