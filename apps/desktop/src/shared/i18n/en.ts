/** Every string the app shows. A translation is one more file with these same keys. */
export const en = {
  'app.name': 'Bildora',

  'menu.file': 'File',
  'menu.edit': 'Edit',
  'menu.view': 'View',
  'menu.tools': 'Tools',
  'menu.help': 'Help',
  'menu.addTool': 'Add a tool…',
  'menu.importFolder': 'Import from folder…',
  'menu.exit': 'Exit',
  'menu.undo': 'Undo',
  'menu.redo': 'Redo',
  'menu.cut': 'Cut',
  'menu.copy': 'Copy',
  'menu.paste': 'Paste',
  'menu.selectAll': 'Select all',
  'menu.findTool': 'Find a tool or action…',
  'menu.settings': 'Settings',
  'menu.about': 'About Bildora',

  'search.placeholder': 'Find a tool or action',
  'search.shortcut': 'Ctrl+K',

  'nav.categories': 'Categories',
  'nav.tools': 'Tools',
  'nav.uncategorized': 'Uncategorized',
  'nav.problems': 'Problems',
  'nav.settings': 'Settings',
  'nav.history': 'Run history',
  'nav.recent': 'Recent',

  'category.changeLogo': 'Change logo…',
  'category.removeLogo': 'Remove logo',

  'state.idle': 'Idle',
  'state.running': 'Running',
  'state.completed': 'Completed',
  'state.failed': 'Failed',
  'state.cancelled': 'Cancelled',

  'status.ready': 'Ready',
  'status.tasksRunning': { one: '{count} task running', other: '{count} tasks running' },
  'status.version': 'v{version}',

  'welcome.title': 'Add your first tool',
  'welcome.body':
    'Bildora keeps your programs and scripts in one place. Point it at a file or import a whole folder. Nothing runs until you launch it.',
  'welcome.add': 'Add a tool',
  'welcome.import': 'Import from folder',
  'welcome.drop': 'You can also drop files anywhere in this window.',

  'tool.launch': 'Launch',
  'tool.stop': 'Stop',
  'tool.edit': 'Edit details',
  'tool.remove': 'Remove',
  'tool.category': 'Category',
  'tool.interpreter': 'Interpreter',
  'tool.none': 'None',
  'tool.lastResult': 'Last result',
  'tool.neverRun': 'Not run yet',
  'tool.exitCode': 'Exit code {code}',
  'tool.instances': { one: '{count} running', other: '{count} running' },
  'tool.laterVersion':
    'This tool needs a later version of Bildora, which will show its form or panel here.',

  'runner.run': 'Run',
  'runner.history': 'History',
  'runner.console': 'Console',
  'runner.progress': 'Progress',
  'runner.percent': '{percent}%',
  'runner.browse': 'Browse…',
  'runner.noParameters': 'This tool takes no parameters.',
  'runner.required': 'This field is required.',
  'runner.requiredMark': '(required)',
  'runner.notWholeNumber': 'Enter a whole number.',
  'runner.notNumber': 'Enter a number.',
  'runner.noChoice': 'Not set',
  'runner.secretSaved': 'Saved in the credential store',
  'runner.forgetSecret': 'Forget saved value',
  'runner.secretArgument':
    'This tool receives the value as an argument, which other programs you run can read while it runs.',

  'profile.label': 'Profile',
  'profile.none': 'No profile',
  'profile.save': 'Save',
  'profile.saveAs': 'Save as…',
  'profile.saveAsTitle': 'Save as a profile',
  'profile.secretsHint':
    'Secrets you typed go to the Windows credential store, never to the profile file.',
  'profile.remove': 'Delete',
  'profile.removeTitle': 'Delete {name}?',
  'profile.removeBody': 'The profile and the secrets saved with it are deleted.',

  'history.title': 'Run history',
  'history.tool': 'Tool',
  'history.allTools': 'All tools',
  'history.empty': 'No runs recorded yet.',
  'history.pick': 'Choose a run to see its details.',
  'history.started': 'Started',
  'history.duration': 'Duration',
  'history.exitCode': 'Exit code',
  'history.failure': 'Problem',
  'history.parameters': 'Parameters',
  'history.output': 'Output',
  'history.noOutput': 'This run wrote nothing.',
  'history.notSet': 'Not set',
  'history.secretHidden': 'Secret, not recorded',
  'history.truncated': 'This output was long, so only its end was kept.',
  'history.interrupted': 'Bildora closed before this run ended, so its result is unknown.',
  'history.noDuration': '—',
  'history.seconds': '{value} s',
  'history.minutes': '{minutes} min {seconds} s',
  'history.hours': '{hours} h {minutes} min',
  'history.unavailable': 'Run history is unavailable, so runs will not be kept: {detail}',

  'runtime.interpreterTitle': '{interpreter} is not installed',
  'runtime.interpreterBody':
    'This tool needs {interpreter}. Install it, make sure it is on PATH, then check again.',
  'runtime.programTitle': 'The program is no longer there',
  'runtime.programBody':
    'Bildora expected it at {program}. Move it back, or remove this tool and add it again.',
  'runtime.checkAgain': 'Check again',

  'failure.exitCode': 'The tool exited with code {code}.',
  'failure.powershell':
    'The tool exited with code {code}. Windows may be blocking PowerShell scripts on this PC, which its execution policy controls.',
  'failure.programNotFound': 'The program could not be found.',
  'failure.interpreterNotFound': 'The interpreter this tool needs could not be found.',
  'failure.other': 'The tool could not be started: {message}',

  'form.addTitle': 'Add a tool',
  'form.editTitle': 'Edit details',
  'form.name': 'Name',
  'form.category': 'Category',
  'form.categoryHint': 'Leave empty to keep it under Uncategorized.',
  'form.description': 'Description',
  'form.interpreter': 'Interpreter',
  'form.interpreterHint':
    'The program that runs this file, such as python. Empty for .exe and .bat.',
  'form.program': 'Program',
  'form.save': 'Save',
  'form.add': 'Add tool',
  'form.cancel': 'Cancel',

  'remove.title': 'Remove {name}?',
  'remove.body':
    'Bildora forgets this tool. The program stays where it is, and nothing is deleted from your files.',
  'remove.confirm': 'Remove tool',

  'import.title': 'Review what to import',
  'import.declared': 'Declared tools',
  'import.declaredHint':
    'These read their form from a tool.yaml. Their program stays where it is, and it will run with your permissions.',
  'import.permissions': 'Declares: {list}',
  'import.noPermissions': 'Declares no permissions',
  'import.replaces': 'Replaces the installed tool',
  'import.refused': '{path}: {reason}',
  'import.summary': {
    one: '{count} program found. Nothing has been run.',
    other: '{count} programs found. Nothing has been run.',
  },
  'import.empty':
    'No programs were found here. Bildora looks for .exe, .bat, .py and similar files.',
  'import.truncated':
    'Only the first {limit} were listed. Import a smaller folder to see the rest.',
  'import.skipped': {
    one: '{count} item was skipped because Bildora cannot run it.',
    other: '{count} items were skipped because Bildora cannot run them.',
  },
  'import.include': 'Import {name}',
  'import.already': 'Already added',
  'import.confirm': { one: 'Import {count} tool', other: 'Import {count} tools' },
  'import.dropHint': 'Drop to import',
  'import.failures': {
    one: '{count} tool could not be added: {detail}',
    other: '{count} tools could not be added. First problem: {detail}',
  },

  'palette.label': 'Find a tool or action',
  'palette.empty': 'Nothing matches that search.',
  'palette.hint': 'Enter runs the selected item. Esc closes.',
  'palette.action': 'Action',
  'palette.theme': 'Theme: {theme}',

  'problems.title': 'Tools that cannot be read',
  'problems.body':
    'These folders are in the Bildora data folder, but their tool definition is damaged or unreadable. The rest of your tools are not affected.',

  'settings.title': 'Settings',
  'settings.theme': 'Theme',
  'settings.themeSystem': 'Follow Windows',
  'settings.themeLight': 'Light',
  'settings.themeDark': 'Dark',
  'settings.historyLimit': 'Runs kept per tool',
  'settings.historyLimitHint':
    'Older runs are deleted once a tool passes this number. Each run keeps up to 1 MiB of output.',
  'settings.clearHistory': 'Clear run history',
  'settings.clearHistoryTitle': 'Clear run history?',
  'settings.clearHistoryBody': 'Every finished run is deleted. This cannot be undone.',

  'about.title': 'About Bildora',
  'about.body': 'A home for your tools and scripts. Version {version}.',
  'about.close': 'Close',

  'banner.dismiss': 'Dismiss',

  'dialog.pickFiles': 'Choose programs to add',
  'dialog.pickFolder': 'Choose a folder to import',
  'dialog.programs': 'Programs and scripts',
  'dialog.pickPath': 'Choose a file',
  'dialog.pickLogo': 'Choose a logo',
  'dialog.images': 'Images',

  'close.title': 'Close Bildora',
  'close.message': {
    one: '{count} tool is still running',
    other: '{count} tools are still running',
  },
  'close.detail': 'Left open, they keep running, but Bildora stops tracking them.',
  'close.detailConsoles':
    'Tools with a window of their own can stay open, but Bildora stops tracking them. Tools running in a Bildora console always end.',
  'close.leaveOpen': 'Leave open',
  'close.endAll': 'End all',
  'close.cancel': 'Cancel',
} as const;

interface PluralMessage {
  readonly one: string;
  readonly other: string;
}

export type Messages = { readonly [Key in keyof typeof en]: string | PluralMessage };
