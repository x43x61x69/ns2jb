'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const {summarize, positiveOutcome, markerHit, failureSummary} = require('../engine/switch2/memory/wave-history.cjs');
// Reduced hardware reports: only measured outcomes, counts and planned roles.
// No console addresses, paths, identities or dumped contents are retained.
const fixtures = require('./fixtures/acquisition-waves.json');
for (const {name, report} of fixtures) {
  test('hardware regression: ' + name, () => {
    const summary = failureSummary(report);
    assert.equal(summary.retainResources, true);
    if (name === 'worker-timeout') {
      assert.equal(summary.kind, 'native-worker-timeout');
      assert.equal(summary.positive.measuredWaves, 1);
      assert.equal(summary.positive.attemptsStarted, 2);
      assert.equal(summary.positive.aborted, 1);
      assert.equal(summary.resources.unjoinedThreads, 13);
      assert.equal(summary.worker.role, 'commit');
      assert.equal(summary.worker.executingStep, null);
      assert.equal(summary.worker.planIsNotExecutionProof, true);
    } else {
      assert.equal(summary.kind, 'canary-placement-miss');
      assert.equal(summary.positive.measuredWaves, 30);
      assert.equal(summary.positive.qualifiedWindows, name === 'last-aborted-miss' ? 26 : 24);
      assert.equal(summary.positive.markerHits, 0);
      assert.equal(summary.inconsistentCleanup, name === 'last-aborted-miss');
    }
  });
}
const miss = fixtures[0].report.cases.find(row => row.triggerAborted === false);
const aborted = {...miss, triggerAborted: true, allPending: false};
test('final aborted wave cannot erase an earlier executed miss', () => {
  for (const rows of [[miss, aborted], [aborted, miss]]) {
    assert.equal(positiveOutcome(summarize(rows)).retainResources, true);
  }
});
test('all aborted waves fail verification without claiming unsafe placement', () => {
  const result = positiveOutcome(summarize([aborted, aborted]));
  assert.deepEqual(result, {verified: false, retainResources: false});
  assert.equal(failureSummary({cases: [aborted]}).kind, 'positive-window-exhausted');
});
test('only the current positive batch decides repeated verification', () => {
  const hit = {...miss, canaryType: 0, changedPaths: ['canary']};
  assert.equal(markerHit(hit), true);
  const first = {profile: 'positive', ...summarize([hit])};
  const second = {profile: 'positive', ...summarize([miss, aborted])};
  const summary = failureSummary({retryBatches: [first, second]});
  assert.equal(summary.positive.markerHits, 0);
  assert.equal(summary.retainResources, true);
});
test('restoration failures and unexpected changes remain unsafe even with a marker', () => {
  const hit = {...miss, canaryType: 0, changedPaths: ['canary']};
  assert.equal(positiveOutcome(summarize([miss, hit])).verified, true);
  for (const invalid of [{...aborted, restored: false}, {...aborted, changedPaths: ['other']},
    {...aborted, triggerAborted: null}]) {
    assert.deepEqual(positiveOutcome(summarize([hit, invalid])), {verified: false, retainResources: true});
  }
});
test('unfinished first positive wave reports zero measured and one started', () => {
  const summary = failureSummary({active: {profile: 'positive'}, workerFailure: {observed: 'not-terminated'}});
  assert.equal(summary.positive.measuredWaves, 0);
  assert.equal(summary.positive.attemptsStarted, 1);
});
test('interrupted running journal recovers measurements without counting the active wave', () => {
  const summary = failureSummary({cases: [miss, aborted], retryBatches: [{profile: 'positive',
    status: 'running', firstCaseIndex: 0, attemptsStarted: 3}],
    active: {profile: 'positive'}, workerFailure: {observed: 'not-terminated'}});
  assert.equal(summary.positive.measuredWaves, 2);
  assert.equal(summary.positive.attemptsStarted, 3);
});
