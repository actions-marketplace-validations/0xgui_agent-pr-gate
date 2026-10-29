import { execFileSync } from 'node:child_process';
import * as github from '@actions/github';
import { cli } from './cli';

function originUrl(): string | null {
  try {
    return execFileSync('git', ['remote', 'get-url', 'origin'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim() || null;
  } catch {
    return null;
  }
}

void cli(process.argv.slice(2), {
  env: process.env,
  octokit: (token) => github.getOctokit(token),
  originUrl,
  stdout: (t) => process.stdout.write(t),
  stderr: (t) => process.stderr.write(t),
}).then((code) => {
  process.exitCode = code;
});
