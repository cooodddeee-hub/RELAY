import test from 'node:test';
import assert from 'node:assert/strict';
import { verifyEvidenceQuote } from '../src/services/evidenceVerification.js';

const original = 'Intro\nThe launch is scheduled for 14 June.\nFollow-up';

test('verifies an exact quote and stores the exact text and offsets', () => {
  const quote = 'The launch is scheduled for 14 June.';
  const evidence = verifyEvidenceQuote({ sourceId: 'source-a', sourceName: 'plan.md', sourceText: original, quote });
  const start = original.indexOf(quote);
  assert.equal(evidence.verificationStatus, 'verified');
  assert.equal(evidence.source, 'source-a');
  assert.equal(evidence.sourceName, 'plan.md');
  assert.equal(evidence.matchedText, quote);
  assert.equal(evidence.startOffset, start);
  assert.equal(evidence.endOffset, start + quote.length);
});

test('verifies a quote that omits a Markdown bullet prefix while preserving source offsets', () => {
  const sourceText = 'Overview\r\n- Backend: Node.js with Express\r\nNext step';
  const quote = 'Backend: Node.js with Express';
  const evidence = verifyEvidenceQuote({ sourceId: 'source-a', sourceName: 'stack.md', sourceText, quote });
  const start = sourceText.indexOf(quote);
  assert.equal(evidence.verificationStatus, 'verified');
  assert.equal(evidence.quote, quote);
  assert.equal(evidence.matchedText, quote);
  assert.equal(evidence.startOffset, start);
  assert.equal(evidence.endOffset, start + quote.length);
});

test('verifies whitespace-only formatting differences without changing the quote', () => {
  const sourceText = 'Deployment:\r\n    run  npm   run build';
  const quote = 'Deployment: run npm run build';
  const evidence = verifyEvidenceQuote({ sourceId: 'source-a', sourceName: 'runbook.md', sourceText, quote });
  const start = sourceText.indexOf('Deployment:');
  const end = sourceText.indexOf('build') + 'build'.length;
  assert.equal(evidence.verificationStatus, 'verified');
  assert.equal(evidence.quote, quote);
  assert.equal(evidence.matchedText, sourceText.slice(start, end));
  assert.equal(evidence.startOffset, start);
  assert.equal(evidence.endOffset, end);
});

test('does not verify a paraphrase or alter the model quote', () => {
  const quote = 'The launch will happen in mid-June.';
  const evidence = verifyEvidenceQuote({ sourceId: 'source-a', sourceName: 'plan.md', sourceText: original, quote });
  assert.equal(evidence.verificationStatus, 'unverified');
  assert.equal(evidence.quote, quote);
  assert.equal('matchedText' in evidence, false);
  assert.equal('startOffset' in evidence, false);
});

test('does not verify a non-existent quotation', () => {
  const quote = 'The team will launch in July.';
  const evidence = verifyEvidenceQuote({ sourceId: 'source-a', sourceName: 'plan.md', sourceText: original, quote });
  assert.equal(evidence.verificationStatus, 'unverified');
  assert.equal(evidence.quote, quote);
  assert.equal('matchedText' in evidence, false);
});

test('does not verify a missing quote and preserves its source association', () => {
  const evidence = verifyEvidenceQuote({ sourceId: 'source-b', sourceName: 'other.txt', sourceText: original, quote: '' });
  assert.equal(evidence.verificationStatus, 'unverified');
  assert.equal(evidence.source, 'source-b');
  assert.equal(evidence.sourceName, 'other.txt');
  assert.equal(evidence.quote, '');
});
