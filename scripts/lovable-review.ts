// The Lovable review of a real pull request, run by hand — to measure it, or to compare it with the
// review Copilot left there. Posts nothing unless --post: the review it would post is printed instead.
//   GH_TOKEN=… LOVABLE_RELAY_URL=… LOVABLE_RELAY_TOKEN=… node scripts/lovable-review.ts owner/repo 76 [--post]
import { GitHub, type Response } from '../src/github.ts';
import { LovableRelay } from '../src/relay.ts';
import { reviewWithLovable } from '../src/review.ts';

const [slug = '', number = '', flag] = process.argv.slice(2);
const [owner = '', repo = ''] = slug.split('/');
const env = (name: string) => process.env[name] ?? '';
if (!owner || !repo || !(Number(number) > 0) || !env('GH_TOKEN') || !env('LOVABLE_RELAY_URL') || !env('LOVABLE_RELAY_TOKEN')) {
  console.error('usage: GH_TOKEN=… LOVABLE_RELAY_URL=… LOVABLE_RELAY_TOKEN=… node scripts/lovable-review.ts owner/repo <pr> [--post]');
  process.exit(2);
}

/** The real client, except that a dry run prints the review instead of posting it. */
class DryRun extends GitHub {
  override async rest<T = unknown>(method: string, path: string, body?: unknown): Promise<Response<T>> {
    if (flag !== '--post' && method === 'POST' && path.endsWith('/reviews')) {
      const review = body as { body: string; comments: { path: string; line: number; body: string }[] };
      console.log(`\n===== REVIEW (not posted) =====\n${review.body}\n`);
      for (const c of review.comments) console.log(`----- ${c.path}:${c.line}\n${c.body}\n`);
      return { status: 200, data: null as T };
    }
    return super.rest<T>(method, path, body);
  }
}

const gh = new DryRun(env('GH_TOKEN'), owner, repo);
const pr = await gh.rest<{ head: { sha: string } }>('GET', gh.repoPath(`/pulls/${number}`));
const relay = new LovableRelay(env('LOVABLE_RELAY_URL'), env('LOVABLE_RELAY_TOKEN'), `merge-gate:${repo}:manual`);
const outcome = await reviewWithLovable(gh, relay, { number: Number(number), head: pr.data.head.sha, why: 'essai à la main' }, { log: (line) => console.log(line) });
console.log(`\n${JSON.stringify(outcome)}`);
