import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import { AWAIT_PREFIX } from '../src/model.ts';

/** The job lives once, in the shared workflow; the callers keep only what GitHub requires of them. */
const read = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
const template = read('templates/merge-gate.yml');
const selfCaller = read('.github/workflows/merge-gate.yml');
const shared = read('.github/workflows/gate.yml');
const action = read('action.yml');

/** The `on:` block of a caller, without its comments: what a repository copies and must not let drift. */
const triggers = (workflow: string) => {
  const block = workflow.slice(workflow.indexOf('\non:\n'), workflow.indexOf('\njobs:\n'));
  return block.split('\n').map((line) => line.replace(/\s+#.*$/, '')).filter((line) => !/^\s*(#|$)/.test(line));
};

/** The `with:` block that follows `uses: <ref>` in the shared workflow. */
const withBlock = (ref: string) => {
  const step = shared.slice(shared.indexOf(`uses: ${ref}\n`));
  const lines = step.split('\n').slice(1);
  const end = lines.findIndex((line, i) => i > 0 && !line.startsWith('          '));
  return lines.slice(0, end).join('\n');
};

describe('the callers', () => {
  it('the template and this repository gate pull requests on the same triggers', () => {
    const t = triggers(template);
    assert.ok(t.length > 10, 'the trigger block was found');
    // The one difference: here a pull request runs its own version of the gate.
    assert.deepEqual(triggers(selfCaller), t.map((line) => line.replace(/^  pull_request_target:$/, '  pull_request:')));
  });

  it('the template calls the released shared job and hands it the secret', () => {
    assert.match(template, /^ {4}uses: svassaux\/merge-gate\/\.github\/workflows\/gate\.yml@v1$/m);
    assert.match(template, /^ {4}secrets: inherit$/m);
    assert.match(template, /^ {2}pull_request_target:$/m, 'the gate runs on the default branch, not as a check of the PR');
    assert.doesNotMatch(template, /^ {4}(if|concurrency|runs-on|steps):/m, 'nothing generic is copied into a repository');
  });

  it('this repository calls the shared job of its own checkout, with the action of its own checkout', () => {
    assert.match(selfCaller, /^ {4}uses: \.\/\.github\/workflows\/gate\.yml$/m);
    assert.match(selfCaller, /^ {6}local: true$/m);
  });
});

describe('the shared job', () => {
  it('acts on the pull request events of the template and of this repository', () => {
    assert.ok(shared.includes("github.event_name == 'pull_request_target'"));
    assert.ok(shared.includes("github.event_name == 'pull_request'"));
  });

  it('runs the sweep only while a pull request awaits', () => {
    assert.ok(shared.includes(`contains(toJSON(vars), '${AWAIT_PREFIX}')`));
  });

  it('hands the release and the checkout the same inputs', () => {
    const release = withBlock('svassaux/merge-gate@v1');
    assert.ok(release.includes('token: ${{ secrets.GATE_TOKEN }}'));
    assert.equal(withBlock('./'), release);
  });

  it('exposes every input of the action', () => {
    const actionInputs = [...action.slice(action.indexOf('inputs:'), action.indexOf('\nruns:')).matchAll(/^ {2}([a-z-]+):$/gm)]
      .map((m) => m[1])
      .filter((name) => name !== 'token');
    assert.ok(actionInputs.length >= 3, 'the action inputs were found');
    for (const name of actionInputs) {
      assert.match(shared, new RegExp(`^ {6}${name}:$`, 'm'), `workflow_call input ${name}`);
      assert.ok(shared.includes(`${name}: \${{ inputs.${name} }}`), `${name} forwarded to the action`);
    }
  });
});
