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

  'about.title': 'About Bildora',
  'about.body': 'A home for your tools and scripts. Version {version}.',
  'about.close': 'Close',

  'banner.dismiss': 'Dismiss',

  'dialog.pickFiles': 'Choose programs to add',
  'dialog.pickFolder': 'Choose a folder to import',
  'dialog.programs': 'Programs and scripts',
  'dialog.pickLogo': 'Choose a logo',
  'dialog.images': 'Images',

  'close.title': 'Close Bildora',
  'close.message': {
    one: '{count} tool is still running',
    other: '{count} tools are still running',
  },
  'close.detail': 'Left open, they keep running, but Bildora stops tracking them.',
  'close.leaveOpen': 'Leave open',
  'close.endAll': 'End all',
  'close.cancel': 'Cancel',
} as const;

interface PluralMessage {
  readonly one: string;
  readonly other: string;
}

export type Messages = { readonly [Key in keyof typeof en]: string | PluralMessage };
