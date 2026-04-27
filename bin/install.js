#!/usr/bin/env node
'use strict';

const { execSync } = require('child_process');
const args = process.argv.slice(2);

const REPO = 'dhan-oss/dhanhq-skills';
const SKILL = 'dhanhq';

if (args.includes('--help') || args.includes('-h')) {
  console.log(`
@dhan-oss/dhanhq-skill — DhanHQ agent skill installer

Usage:
  npx @dhan-oss/dhanhq-skill              Install for current agent
  npx @dhan-oss/dhanhq-skill -- -a codex  Install for Codex
  npx @dhan-oss/dhanhq-skill -- -a claude Install for Claude Code
  npx @dhan-oss/dhanhq-skill --help       Show this help

Internally runs:
  npx skills add ${REPO} --skill ${SKILL} [extra args]
`);
  process.exit(0);
}

const extra = args.length ? ' ' + args.join(' ') : '';
const cmd = `npx skills add ${REPO} --skill ${SKILL}${extra}`;

console.log(`\nInstalling DhanHQ skill...\n  ${cmd}\n`);

try {
  execSync(cmd, { stdio: 'inherit' });
} catch (err) {
  process.exit(err.status || 1);
}
