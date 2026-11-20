import { readFileSync } from 'node:fs';
import { gatePullRequest } from './gate.ts';
import { GitHub } from './github.ts';
import { REVIEW_EFFORTS, type Config, type ReviewEffort } from './model.ts';
import { LovableRelay } from './relay.ts';
import { targets, type Event } from './targets.ts';

const input = (name: string) => (process.env[`INPUT_${name.toUpperCase()}`] ?? '').trim();
const list = (value: string) => value.split(/[\s,]+/).filter(Boolean);
const isEffort = (value: string): value is ReviewEffort => (REVIEW_EFFORTS as readonly string[]).includes(value);

async function main(): Promise<void> {
  const token = input('token');
  if (!token) {
    console.log('::warning title=merge-gate::Aucun jeton (secret GATE_TOKEN absent, ou run Dependabot) : rien n’est fait.');
    return;
  }
  const firstReview = input('first-review') || 'gate';
  if (firstReview !== 'gate' && firstReview !== 'ruleset') throw new Error(`first-review: « ${firstReview} » — gate ou ruleset`);
  const effort = input('copilot-effort').toLowerCase() || 'lite';
  if (!isEffort(effort)) throw new Error(`copilot-effort: « ${effort} » — ${REVIEW_EFFORTS.join(', ')}`);
  const copilotEffort = effort;
  // Both or neither: a repository whose code must not leave it (customers' data) hands over neither secret.
  const relayUrl = input('lovable-relay-url');
  const relayToken = input('lovable-relay-token');
  if (!relayUrl !== !relayToken) console.log('::warning title=merge-gate::Un seul des deux secrets du relais Lovable (LOVABLE_RELAY_URL, LOVABLE_RELAY_TOKEN) : pas de relecture Lovable.');
  const [owner = '', repo = ''] = (process.env['GITHUB_REPOSITORY'] ?? '').split('/');
  const relay = relayUrl && relayToken ? new LovableRelay(relayUrl, relayToken, `merge-gate:${repo}`) : undefined;
  const cfg: Config = {
    firstReview,
    copilotEffort,
    requiredChecks: list(input('required-checks')),
    ignoreChecks: list(input('ignore-checks')),
    ownWorkflow: process.env['GITHUB_WORKFLOW'] ?? '',
    lovable: relay !== undefined,
  };
  const gh = new GitHub(token, owner, repo, process.env['GITHUB_API_URL']);
  const runUrl = `${process.env['GITHUB_SERVER_URL'] ?? 'https://github.com'}/${owner}/${repo}/actions/runs/${process.env['GITHUB_RUN_ID'] ?? ''}`;
  const event = JSON.parse(readFileSync(process.env['GITHUB_EVENT_PATH'] ?? '', 'utf8')) as Event;

  const numbers = await targets(gh, process.env['GITHUB_EVENT_NAME'] ?? '', event);
  if (numbers.length === 0) console.log('Aucune pull request à examiner.');
  let failed = false;
  // A sweep may hold several pull requests the relay should review: one a run, the next run takes the next.
  const relayTurn = { taken: false };
  for (const n of numbers) {
    try {
      console.log(await gatePullRequest(gh, n, cfg, runUrl, { relay, relayTurn, review: { log: (line) => console.log(line) } }));
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
