export interface DefinitionIssue {
  /** Where the problem is, such as `parameters.2.flag`. Empty for the document as a whole. */
  readonly path: string;
  readonly message: string;
}

/** A stored or supplied definition cannot be used. Its message is written for the user. */
export class DefinitionError extends Error {
  readonly issues: readonly DefinitionIssue[];

  constructor(summary: string, issues: readonly DefinitionIssue[] = []) {
    const details = issues.map(({ path, message }) =>
      path === '' ? `- ${message}` : `- ${path}: ${message}`,
    );
    super([summary, ...details].join('\n'));
    this.name = 'DefinitionError';
    this.issues = issues;
  }
}
