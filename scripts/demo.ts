/**
 * Demo mode: the review flow on a copy of the committed review with a few decisions undone (demo-seed.ts),
 * kept in .demo/ so the committed review is untouched.
 *
 *   yarn demo          reset .demo/, then app, scan, tests, triage, dashboard: about five items to decide
 *   yarn demo:review   the review page on the demo state
 *   yarn demo:rerun    run again, keeping the demo decisions, to show what they changed
 */
import { existsSync } from 'node:fs';
import { demoDir } from '../src/review-state';
import { seedDemo } from './demo-seed';

process.env.DEMO = '1';
const command = process.argv[2];
if (command !== 'review' && command !== 'rerun' && command !== undefined) throw new Error('usage: demo.ts [review|rerun]');
if (!command || !existsSync(demoDir())) seedDemo();
console.log('Demo mode: review state is in .demo/; the committed review is untouched.');
await import(command === 'review' ? '../triage/review-page' : './run-all');
