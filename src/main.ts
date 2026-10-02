import { readFileSync } from 'node:fs';
import { gatePullRequest } from './gate.ts';
import { GitHub } from './github.ts';
import type { Config } from './model.ts';
import { targets, type Event } from './targets.ts';

const input = (name: string) => (process.env[`INPUT_${name.toUpperCase()}`] ?? '').trim();
const list = (value: string) => value.split(/[\s,]+/).filter(Boolean);

async function main(): Promise<void> {
  const token = input('token');
  if (!token) {
    console.log('::warning title=merge-gate::Aucun jeton (secret GATE_TOKEN absent, ou run Dependabot) : rien n’est fait.');
    return;
  }
  const firstReview = input('first-review') || 'gate';
  if (firstReview !== 'gate' && firstReview !== 'ruleset') throw new Error(`first-review: « ${firstReview} » — gate ou ruleset`);
  const cfg: Config = {
    firstReview,
    requiredChecks: list(input('required-checks')),
    ignoreChecks: list(input('ignore-checks')),
    ownWorkflow: process.env['GITHUB_WORKFLOW'] ?? '',
  };
  const [owner = '', repo = ''] = (process.env['GITHUB_REPOSITORY'] ?? '').split('/');
  const gh = new GitHub(token, owner, repo, process.env['GITHUB_API_URL']);
  const runUrl = `${process.env['GITHUB_SERVER_URL'] ?? 'https://github.com'}/${owner}/${repo}/actions/runs/${process.env['GITHUB_RUN_ID'] ?? ''}`;
  const event = JSON.parse(readFileSync(process.env['GITHUB_EVENT_PATH'] ?? '', 'utf8')) as Event;

  const numbers = await targets(gh, process.env['GITHUB_EVENT_NAME'] ?? '', event);
  if (numbers.length === 0) console.log('Aucune pull request à examiner.');
  let failed = false;
  for (const n of numbers) {
    try {
      console.log(await gatePullRequest(gh, n, cfg, runUrl));
    } catch (err) {
      failed = true;
      console.log(`::error title=merge-gate #${n}::${err instanceof Error ? err.message : String(err)}`);
    }
  }
  if (failed) process.exitCode = 1;
}

await main().catch((err: unknown) => {
  console.log(`::error title=merge-gate::${err instanceof Error ? err.message : String(err)}`);
  process.exitCode = 1;
});
