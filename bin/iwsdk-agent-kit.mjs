#!/usr/bin/env node
import { resolve } from 'node:path';
import { install } from '../src/install.mjs';
import { inspectProject } from '../src/doctor.mjs';
import { main as orchestrate } from '../src/orchestrator.mjs';
const [command, ...args] = process.argv.slice(2);
const index = args.indexOf('--target');
const target = index < 0 ? process.cwd() : resolve(args[index + 1]);
const flags = index < 0 ? args : args.filter((_, i) => i !== index && i !== index + 1);
try {
  if (command === 'init') {
    const result = install(target, { dryRun: flags.includes('--dry-run') });
    console.log(JSON.stringify(result, null, 2));
    if (result.some(item => item.action === 'conflict')) process.exitCode = 2;
  } else if (command === 'doctor') console.log(JSON.stringify(inspectProject(target), null, 2));
  else if (command === 'batch') await orchestrate(flags, target);
  else if (!command || command === '--help' || command === '-h') console.log('iwsdk-agent-kit init [--dry-run] | doctor | batch plan|start|status|collect|integrate|publish|cleanup');
  else throw Error('Unknown command: ' + command);
} catch (error) { console.error(error.message); process.exitCode = 1; }
