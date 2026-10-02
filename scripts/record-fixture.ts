// Records the gate's one read of a real pull request, as GitHub answers it, for the parsing tests.
//   GH_TOKEN=… node scripts/record-fixture.ts owner/repo 76 > test/fixtures/<name>.json
import { SNAPSHOT_QUERY } from '../src/snapshot.ts';

const [slug = '', number = ''] = process.argv.slice(2);
const [owner, name] = slug.split('/');
const res = await fetch('https://api.github.com/graphql', {
  method: 'POST',
  headers: { authorization: `Bearer ${process.env['GH_TOKEN'] ?? ''}`, 'user-agent': 'merge-gate' },
  body: JSON.stringify({ query: SNAPSHOT_QUERY, variables: { owner, name, number: Number(number) } }),
});
const body = (await res.json()) as { data?: { repository: { pullRequest: unknown } }; errors?: unknown };
if (!body.data) throw new Error(JSON.stringify(body.errors));
console.log(JSON.stringify(body.data.repository.pullRequest, null, 1));
