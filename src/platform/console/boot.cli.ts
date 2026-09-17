import { relative, resolve } from 'node:path';
import {
  type GeneratedFile,
  generateAction,
  generateEvent,
  generateFeature,
  generateJob,
  generateListener,
  generateMigration,
  generateWorkflow,
} from './generate.js';

const ROOT = resolve(import.meta.dirname, '..', '..', '..');

const USAGE = `
Scaffold, so the shape is never hand-rolled.

  pnpm boot:feature   <name>
  pnpm boot:action    <feature> <Name> [--http]
  pnpm boot:workflow  <feature> <Name>
  pnpm boot:job       <feature> <Name>
  pnpm boot:event     <feature> <Name>
  pnpm boot:listener  <feature> <Name> --event=<feature>/<Event>
  pnpm boot:migration <feature> <name>

Stubs live in stubs/. Change the stub, never the generated file.
`.trim();

function main(): void {
  const [kind, ...args] = process.argv.slice(2);
  const flags = args.filter((arg) => arg.startsWith('--'));
  const positional = args.filter((arg) => !arg.startsWith('--'));
  const flag = (name: string) => flags.find((f) => f.startsWith(`--${name}`));

  const need = (count: number, usage: string): string[] => {
    if (positional.length < count) {
      console.error(`Not enough arguments.\n\n  ${usage}\n`);
      process.exit(1);
    }
    return positional;
  };

  let files: GeneratedFile[];

  switch (kind) {
    case 'feature':
      files = generateFeature(need(1, 'pnpm boot:feature <name>')[0]!);
      break;

    case 'action': {
      const [feature, name] = need(2, 'pnpm boot:action <feature> <Name> [--http]');
      files = generateAction(feature!, name!, { http: flag('http') !== undefined });
      break;
    }

    case 'workflow': {
      const [feature, name] = need(2, 'pnpm boot:workflow <feature> <Name>');
      files = generateWorkflow(feature!, name!);
      break;
    }

    case 'job': {
      const [feature, name] = need(2, 'pnpm boot:job <feature> <Name>');
      files = generateJob(feature!, name!);
      break;
    }

    case 'event': {
      const [feature, name] = need(2, 'pnpm boot:event <feature> <Name>');
      files = generateEvent(feature!, name!);
      break;
    }

    case 'listener': {
      const [feature, name] = need(
        2,
        'pnpm boot:listener <feature> <Name> --event=<feature>/<Event>',
      );
      const event = flag('event')?.split('=')[1];
      if (!event) {
        console.error('Missing --event=<feature>/<Event>.\n');
        process.exit(1);
      }
      files = generateListener(feature!, name!, event);
      break;
    }

    case 'migration': {
      const [feature, name] = need(2, 'pnpm boot:migration <feature> <name>');
      files = generateMigration(feature!, name!, new Date());
      break;
    }

    default:
      console.log(USAGE);
      process.exit(kind ? 1 : 0);
  }

  for (const file of files) {
    const marker = file.status === 'created' ? '+' : '=';
    // '=' means it already existed and was left alone: a generator that
    // overwrites is a generator that eats work.
    console.log(`  ${marker} ${relative(ROOT, file.path)}`);
  }

  if (kind === 'feature') {
    console.log(
      '\nAdd the module to src/app.module.ts, then:\n  pnpm boot:action <feature> <Name>',
    );
  } else if (kind === 'action') {
    console.log('\nThe generated test fails on purpose. Make it pass, then `pnpm verify`.');
  }
}

try {
  main();
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
