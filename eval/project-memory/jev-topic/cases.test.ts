import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { assertJevTopicCases, buildJevTopicCases, loadTopicDataset } from './cases.js';

for (const [dir, version, traces, questions] of [['dataset', 2.1, 113, 31], ['history/v2', 2, 35, 23]] as const) {
  test(`topic-choice harness covers dataset v${version} and rejects missing/duplicate cases`, () => {
    const dataset = loadTopicDataset(fileURLToPath(new URL(`../gold-add-memory/${dir}/`, import.meta.url)));
    const cases = buildJevTopicCases(dataset);
    assert.equal(dataset.corpus.datasetVersion, version);
    assert.equal(cases.add.length + cases.skipped.length, traces);
    assert.equal(cases.search.length, questions);
    assert.ok(!cases.search.some(item => item.id === 'q21'));
    assert.doesNotThrow(() => assertJevTopicCases(cases, dataset));
    const missing = structuredClone(cases);
    missing.add.pop();
    assert.throws(() => assertJevTopicCases(missing, dataset), /add case coverage/);
    const duplicated = structuredClone(cases);
    duplicated.search[0] = duplicated.search[1]!;
    assert.throws(() => assertJevTopicCases(duplicated, dataset), /search case coverage/);
    const invalidTarget = structuredClone(cases);
    invalidTarget.search[0]!.expectedTopics = ['nonexistent_topic'];
    assert.throws(() => assertJevTopicCases(invalidTarget, dataset), /before that topic exists/);
  });
}
