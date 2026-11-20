import { createHash } from 'node:crypto';
import ContradictionCandidate from '../models/ContradictionCandidate.js';
import Finding from '../models/Finding.js';
import Source from '../models/Source.js';
import SourceRevision from '../models/SourceRevision.js';
import { verifyEvidenceQuote } from './evidenceVerification.js';

const polarityWords = /\b(no|not|never|cannot|can't|won't|isn't|aren't|doesn't|didn't|without)\b/i;

function normalizeTopic(value) {
  return String(value || '').normalize('NFKC').toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, ' ').replace(/\s+/g, ' ').trim();
}

function numericFacts(value) {
  return [...String(value || '').matchAll(/\b\d+(?:\.\d+)?(?:%|\s*(?:days?|weeks?|months?|years?))?\b/gi)]
    .map(([fact]) => fact.toLowerCase().replace(/\s+/g, ' ').trim());
}

/**
 * A deliberately conservative local detector. It only proposes a candidate
 * when same-category findings have the same normalized title and their
 * evidence-backed descriptions contain conflicting numbers or polarity.
 * It never determines truth or confirms a contradiction.
 */
export function findContradictionPairs(findings) {
  const prepared = (findings || []).map((finding) => ({
    finding,
    topic: normalizeTopic(finding.title),
    facts: numericFacts(finding.description),
    negative: polarityWords.test(finding.description || ''),
  })).filter((item) => item.topic && item.finding.category);
  const pairs = [];
  for (let left = 0; left < prepared.length; left += 1) {
    for (let right = left + 1; right < prepared.length; right += 1) {
      const a = prepared[left];
      const b = prepared[right];
      if (a.topic !== b.topic || a.finding.category !== b.finding.category || a.negative === b.negative && !a.facts.length && !b.facts.length) continue;
      const differentFacts = a.facts.length > 0 && b.facts.length > 0
        && JSON.stringify([...new Set(a.facts)].sort()) !== JSON.stringify([...new Set(b.facts)].sort());
      const oppositePolarity = a.negative !== b.negative;
      if (!differentFacts && !oppositePolarity) continue;
      const evidenceA = (a.finding.evidence || []).filter((item) => item.verificationStatus === 'verified' && item.sourceRevision && item.quote);
      const evidenceB = (b.finding.evidence || []).filter((item) => item.verificationStatus === 'verified' && item.sourceRevision && item.quote);
      for (const firstEvidence of evidenceA) {
        for (const secondEvidence of evidenceB) {
          if (String(firstEvidence.sourceRevision) === String(secondEvidence.sourceRevision)) continue;
          pairs.push({ left: a.finding, right: b.finding, firstEvidence, secondEvidence, differentFacts, oppositePolarity });
        }
      }
    }
  }
  return pairs;
}

function candidateIdentity(projectId, pair) {
  const evidenceKeys = [
    `${pair.firstEvidence.source}:${pair.firstEvidence.sourceRevision}:${pair.left._id}`,
    `${pair.secondEvidence.source}:${pair.secondEvidence.sourceRevision}:${pair.right._id}`,
  ].sort();
  return createHash('sha256').update(`${projectId}:${evidenceKeys.join('|')}`).digest('hex');
}

function verifiedRevisionEvidence(item, revision) {
  if (String(item.sourceRevision) !== String(revision._id)) return null;
  const checked = verifyEvidenceQuote({
    sourceId: item.source,
    sourceName: item.sourceName || 'Source',
    sourceText: revision.textSnapshot,
    sourceRevision: revision._id,
    locator: item.locator,
    quote: item.quote,
  });
  if (checked.verificationStatus !== 'verified') return null;
  return {
    source: item.source,
    sourceRevision: revision._id,
    quote: item.quote,
    matchedText: checked.matchedText,
    startOffset: checked.startOffset,
    endOffset: checked.endOffset,
    locator: item.locator,
    sourceUpdatedAt: revision.providerUpdatedAt || revision.capturedAt,
  };
}

export async function detectContradictionCandidates({ projectId, actorId, session, now = new Date(), FindingModel = Finding, SourceModel = Source, RevisionModel = SourceRevision, CandidateModel = ContradictionCandidate, audit }) {
  const findings = await FindingModel.find({ project: projectId, status: 'approved' }).session(session || null).lean();
  const pairs = findContradictionPairs(findings);
  const created = [];
  for (const pair of pairs) {
    const first = pair.firstEvidence;
    const second = pair.secondEvidence;
    const sourceIds = [...new Set([String(first.source), String(second.source)])];
    const [sources, revisions] = await Promise.all([
      SourceModel.find({ _id: { $in: sourceIds }, project: projectId }).session(session || null).lean(),
      RevisionModel.find({ _id: { $in: [first.sourceRevision, second.sourceRevision] } }).session(session || null).lean(),
    ]);
    if (sources.length !== sourceIds.length || revisions.length !== 2) continue;
    const revisionById = new Map(revisions.map((item) => [String(item._id), item]));
    if (revisions.some((revision) => !sources.some((source) => String(source._id) === String(revision.source)))) continue;
    const evidence = [
      verifiedRevisionEvidence(first, revisionById.get(String(first.sourceRevision))),
      verifiedRevisionEvidence(second, revisionById.get(String(second.sourceRevision))),
    ];
    if (evidence.some((item) => !item)) continue;
    const candidateKey = candidateIdentity(projectId, pair);
    const claims = [pair.left, pair.right].map((finding) => ({
      finding: finding._id,
      category: finding.category,
      summary: `${finding.title}: ${finding.description}`.slice(0, 2000),
      effectiveAt: finding.updatedAt || finding.createdAt,
    }));
    const valuesDiffer = pair.differentFacts ? 'different numeric or duration details' : 'opposite wording polarity';
    const candidate = {
      project: projectId,
      candidateKey,
      claims,
      evidence,
      relationship: 'possible_conflict',
      cautiousLabel: 'needs_human_check',
      confidenceBand: 'low',
      confidence: 0.4,
      explanation: `The same category and claim title have evidence with ${valuesDiffer}. This is an unconfirmed review suggestion; source timing and context may explain the difference.`,
      status: 'candidate',
      createdAt: now,
      updatedAt: now,
    };
    const alreadyExists = await CandidateModel.findOne({ project: projectId, candidateKey }).session(session || null).lean();
    if (alreadyExists) continue;
    try {
      const [saved] = await CandidateModel.create([candidate], session ? { session } : {});
      if (audit) await audit(saved, session);
      created.push(saved);
    } catch (error) {
      if (error?.code !== 11000) throw error;
      throw error;
    }
  }
  return { detectedPairs: pairs.length, created };
}

export function transitionContradiction(candidate, status, actorId, reason, now = new Date()) {
  const allowed = {
    candidate: new Set(['in_review', 'confirmed_conflict', 'stale_information', 'resolved', 'dismissed']),
    in_review: new Set(['confirmed_conflict', 'stale_information', 'resolved', 'dismissed']),
    confirmed_conflict: new Set(['resolved']),
    stale_information: new Set(['resolved']),
    resolved: new Set(),
    dismissed: new Set(),
  };
  if (!allowed[candidate.status]?.has(status)) {
    const error = new Error('This contradiction candidate cannot make that status transition.');
    error.status = 409;
    throw error;
  }
  candidate.status = status;
  candidate.reviewedBy = actorId;
  candidate.reviewedAt = now;
  candidate.reviewReason = reason;
  return candidate;
}
