#!/usr/bin/env node
// Preserve the pre-M02/M04/M05 experiment without overlaying the current service.
import { execFileSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const snapshot = '65e61c7e5dd50f0e8c99097e6ce79eb947b85e56';
const git = (...args) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8' }).trim();
const commit = git('rev-parse', `${snapshot}^{commit}`);
const corpus = JSON.parse(git('show', `${commit}:eval/project-memory/gold-add-memory/dataset/corpus.json`));
const questions = JSON.parse(git('show', `${commit}:eval/project-memory/gold-add-memory/dataset/questions.json`));
if (corpus.datasetVersion !== 2 || corpus.traces.length !== 35 || questions.questions.filter(q => !q.excluded).length !== 23) {
  throw new Error('Legacy snapshot no longer matches the recorded v2 experiment');
}
if (process.argv[2] === '--create' && process.argv.length === 4) {
  const target = resolve(process.argv[3]);
  execFileSync('git', ['-C', root, 'worktree', 'add', '--detach', target, commit], { stdio: 'inherit' });
  console.log(JSON.stringify({ commit, target, datasetVersion: 2, next: 'Install dependencies in the worktree; see its metrics R-20261106-01. No model calls were made.' }, null, 2));
} else if (process.argv[2] === '--check' && process.argv.length === 3) {
  console.log(JSON.stringify({ commit, datasetVersion: 2, traces: 35, scoredQuestions: 23, modelsCalled: false }, null, 2));
} else {
  console.error('Usage: node eval/project-memory/session-as-topic/prepare-legacy.mjs --check | --create <new-worktree-path>');
  process.exitCode = 2;
}
