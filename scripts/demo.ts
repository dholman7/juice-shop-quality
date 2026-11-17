/**
 * Demo mode: the whole flow from scratch, without touching the committed review.
 *
 *   yarn demo          empty .demo/, then app, scan, tests, triage, report: every failure and finding undecided
 *   yarn demo:review   the review page on the demo state
 *   yarn demo:rerun    run again, keeping the demo decisions, to show what they changed
 */
import { resetDemo } from '../src/review-state';

process.env.DEMO = '1';
const command = process.argv[2];
if (command !== 'review' && command !== 'rerun' && command !== undefined) throw new Error('usage: demo.ts [review|rerun]');
if (!command) resetDemo();
console.log('Demo mode: review state is in .demo/; the committed review is untouched.');
await import(command === 'review' ? '../triage/review-page' : './run-all');
