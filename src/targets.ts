import type { Api } from './github.ts';
import { AWAIT_PREFIX, LABEL } from './model.ts';

export interface Event {
  pull_request?: { number: number };
  inputs?: { pr?: string };
  workflow_run?: { head_sha: string; pull_requests?: { number: number }[] };
}

/** The pull requests this event concerns. */
export async function targets(gh: Api, eventName: string, event: Event): Promise<number[]> {
  if (event.pull_request) return [event.pull_request.number];
  if (eventName === 'workflow_run' && event.workflow_run) {
    const listed = (event.workflow_run.pull_requests ?? []).map((p) => p.number);
    if (listed.length > 0) return listed;
    const sha = event.workflow_run.head_sha;
    const { data } = await gh.rest<{ number: number; state: string; head: { sha: string } }[]>(
      'GET',
      gh.repoPath(`/commits/${sha}/pulls`),
    );
    return (Array.isArray(data) ? data : []).filter((p) => p.state === 'open' && p.head.sha === sha).map((p) => p.number);
  }
  if (eventName === 'workflow_dispatch' && Number(event.inputs?.pr) > 0) return [Number(event.inputs?.pr)];
  if (eventName === 'workflow_dispatch') {
    const { data } = await gh.rest<{ number: number; draft: boolean; labels: { name: string }[] }[]>(
      'GET',
      gh.repoPath('/pulls?state=open&per_page=100'),
    );
    return data.filter((p) => !p.draft || p.labels.some((l) => l.name === LABEL)).map((p) => p.number);
  }
  if (eventName === 'schedule') {
    const { data } = await gh.rest<{ variables: { name: string }[] }>('GET', gh.repoPath('/actions/variables?per_page=30'));
    return (data.variables ?? [])
      .filter((v) => v.name.startsWith(AWAIT_PREFIX))
      .map((v) => Number(v.name.slice(AWAIT_PREFIX.length)))
      .filter((n) => n > 0);
  }
  return [];
}
