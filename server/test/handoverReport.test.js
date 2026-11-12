import test from 'node:test';
import assert from 'node:assert/strict';
import PDFDocument from 'pdfkit';
import { canEditProject, canReadProject } from '../src/services/projectPermissions.js';
import {
  acquireHandoverLock,
  createHandoverSnapshot,
  nextHandoverVersion,
  renderHandoverPdf,
} from '../src/services/handoverReport.js';

const project = { _id: 'project-1', name: 'Relay Test', description: 'A test handover.', owner: 'owner-1' };
const approvedFinding = {
  _id: 'finding-1', status: 'approved', category: 'Decision', title: 'Use OIDC', description: 'Campus sign-in uses OIDC.',
  evidence: [{
    source: { _id: 'source-1', originalName: 'identity.md' }, sourceName: 'identity.md',
    quote: 'Campus users sign in with OIDC.', verificationStatus: 'verified', matchedText: 'Campus users sign in with OIDC.',
    startOffset: 4, endOffset: 36,
  }],
};

function pdfPageCount(pdfBuffer) {
  return (pdfBuffer.toString('latin1').match(/\/Type \/Page(?:\s|$)/g) || []).length;
}

function extractPdfPageTexts(pdfBuffer) {
  const pdf = pdfBuffer.toString('latin1');
  const objects = [...pdf.matchAll(/(\d+) 0 obj\r?\n([\s\S]*?)\r?\nendobj/g)];
  const byId = new Map(objects.map((match) => [match[1], match[2]]));
  return objects.filter((match) => /\/Type \/Page(?:\s|$)/.test(match[2])).map((page) => {
    const contentId = page[2].match(/\/Contents\s+(\d+)\s+0\s+R/)?.[1];
    const stream = contentId ? byId.get(contentId)?.match(/stream\r?\n([\s\S]*?)\r?\nendstream/)?.[1] : '';
    return [...(stream || '').matchAll(/<([0-9a-f]+)>/gi)].map((text) => Buffer.from(text[1], 'hex').toString('utf8')).join('');
  });
}

function extractPdfTextPlacements(pdfBuffer) {
  const pdf = pdfBuffer.toString('latin1');
  const objects = [...pdf.matchAll(/(\d+) 0 obj\r?\n([\s\S]*?)\r?\nendobj/g)];
  const byId = new Map(objects.map((match) => [match[1], match[2]]));
  return objects.filter((match) => /\/Type \/Page(?:\s|$)/.test(match[2])).map((page) => {
    const contentId = page[2].match(/\/Contents\s+(\d+)\s+0\s+R/)?.[1];
    const stream = contentId ? byId.get(contentId)?.match(/stream\r?\n([\s\S]*?)\r?\nendstream/)?.[1] : '';
    return [...(stream || '').matchAll(/\bBT\b([\s\S]*?)\bET\b/g)].map((block) => {
      const matrix = block[1].match(/1 0 0 1\s+([\d.-]+)\s+([\d.-]+)\s+Tm/);
      const font = block[1].match(/\/(F\d+)\s+([\d.]+)\s+Tf/);
      const text = [...block[1].matchAll(/<([0-9a-f]+)>/gi)]
        .map((part) => Buffer.from(part[1], 'hex').toString('latin1')).join('');
      if (!matrix || !font || !text) return null;
      return {
        x: Number(matrix[1]),
        y: Number(matrix[2]),
        fontSize: Number(font[2]),
        fontName: font[1] === 'F2' ? 'Helvetica-Bold' : 'Helvetica',
        text,
      };
    }).filter(Boolean);
  });
}

function measuredTextWidth(text, fontSize, fontName = 'Helvetica') {
  const document = new PDFDocument({ size: 'A4' });
  document.font(fontName).fontSize(fontSize);
  return document.widthOfString(text);
}

test('creates a snapshot from approved findings only and retains references and evidence metadata', () => {
  const report = createHandoverSnapshot({
    project,
    approvedFindings: [approvedFinding, { ...approvedFinding, _id: 'pending-1', status: 'pending', title: 'Must not appear' }],
    version: 1,
    generatedBy: { _id: 'user-1', name: 'Reviewer' },
  });
  assert.equal(report.approvedFindingCount, 1);
  assert.equal(report.sections['Key Decisions'][0].findingId, 'finding-1');
  assert.deepEqual(report.sections['Key Decisions'][0].evidence[0], {
    sourceId: 'source-1', sourceName: 'identity.md', quote: 'Campus users sign in with OIDC.', verificationStatus: 'verified',
    matchedText: 'Campus users sign in with OIDC.', startOffset: 4, endOffset: 36,
  });
  assert.ok(!JSON.stringify(report).includes('Must not appear'));
  assert.equal(report.generatedBy.name, 'Reviewer');
  assert.equal(report.sections['Pending Tasks'].length, 0);
});

test('unverified and legacy evidence stay unverified in snapshots', () => {
  const report = createHandoverSnapshot({
    project,
    approvedFindings: [{ ...approvedFinding, evidence: [{ sourceName: 'old.txt', quote: 'Paraphrase only' }] }],
    version: 2,
  });
  assert.deepEqual(report.sections['Key Decisions'][0].evidence[0], {
    sourceId: null, sourceName: 'old.txt', quote: 'Paraphrase only', verificationStatus: 'unverified',
    matchedText: null, startOffset: null, endOffset: null,
  });
});

test('new snapshots retain category and approval status and provide an honest missing overview', async () => {
  const report = createHandoverSnapshot({
    project: { ...project, description: '' },
    approvedFindings: [
      approvedFinding,
      { ...approvedFinding, _id: 'pending-1', status: 'pending', title: 'Pending item' },
    ],
    version: 5,
  });
  assert.equal(report.sections['Key Decisions'][0].category, 'Decision');
  assert.equal(report.sections['Key Decisions'][0].approvalStatus, 'approved');
  assert.equal(report.sections['Project Overview'][0].description, 'Project description has not been provided.');

  const pdf = await renderHandoverPdf(report);
  const text = extractPdfPageTexts(pdf).join('\n');
  assert.match(text, /Project description has not been provided\./);
  assert.doesNotMatch(text, /Pending item/);
});

test('PDF renders sections in requested order and supports old snapshot section names', async () => {
  const report = {
    version: 6,
    generatedAt: '2026-01-01T00:00:00.000Z',
    project: { name: 'Legacy report', description: '' },
    sections: {
      'Project Overview': [{ description: 'No project description is available.' }],
      Decision: [{ title: 'Decision entry', description: 'Decision details.' }],
      'Completed Work': [{ title: 'Completed entry', description: 'Completed details.' }],
      'Pending Tasks': [],
      Responsibilities: [{ title: 'Responsibility entry', description: 'Owner detail.' }],
      Blockers: [], Dependencies: [], Risks: [], 'Next Actions': [], 'Unresolved Questions': [],
    },
  };
  const pdf = await renderHandoverPdf(report);
  const text = extractPdfPageTexts(pdf).join('\n');
  const orderedLabels = [
    'Project Overview', 'Decision entry', 'Completed entry', 'Pending Tasks',
    'Responsibility entry', 'Blockers', 'Dependencies', 'Risks', 'Next Actions',
    'Unresolved Questions', 'Evidence and Source References',
  ];
  let previousIndex = -1;
  for (const label of orderedLabels) {
    const index = text.indexOf(label);
    assert.ok(index > previousIndex, `${label} should follow the previous report section`);
    previousIndex = index;
  }
  assert.match(text, /Project description has not been provided\./);
  assert.match(text, /Category: Decision\s+\|\s+Approval: Approved at snapshot time/);
});

test('15-finding two-source PDF keeps populated headings with findings and groups readable source references', async () => {
  const categories = [
    'Decision', 'Completed Work', 'Pending Tasks', 'Responsibilities', 'Blockers',
    'Dependencies', 'Risks', 'Next Actions', 'Unresolved Questions',
  ];
  const findings = Array.from({ length: 15 }, (_, index) => ({
    ...approvedFinding,
    _id: `finding-${index + 1}`,
    category: categories[index % categories.length],
    title: `Approved handover item ${index + 1}`,
    description: `Reviewer-confirmed project context for item ${index + 1}. This detail should remain readable in the generated handover report.`,
    evidence: [{
      source: { _id: index % 2 ? 'source-b' : 'source-a', originalName: index % 2 ? 'architecture.md' : 'project-notes.md' },
      sourceId: index % 2 ? 'source-b' : 'source-a',
      sourceName: index % 2 ? 'architecture.md' : 'project-notes.md',
      quote: `Evidence excerpt for approved item ${index + 1}.`,
      verificationStatus: index % 3 ? 'verified' : 'unverified',
      matchedText: index % 3 ? `Evidence excerpt for approved item ${index + 1}.` : null,
    }],
  }));
  const report = createHandoverSnapshot({ project: { ...project, description: '' }, approvedFindings: findings, version: 4 });
  const pdf = await renderHandoverPdf(report);
  const pages = extractPdfPageTexts(pdf);
  const fullText = pages.join('\n');

  assert.equal(report.approvedFindingCount, 15);
  assert.equal(pages.length, pdfPageCount(pdf));
  for (let index = 0; index < pages.length; index += 1) {
    assert.match(pages[index], new RegExp(`Page ${index + 1} of ${pages.length}`));
    assert.ok(pages[index].replace(/RELAY\s*\/\s*PROJECT HANDOVER|RELAY\s*\|\s*Version \d+\s*\|\s*Page \d+ of \d+/g, '').trim().length > 0,
      `page ${index + 1} should contain report content`);
  }
  for (let index = 1; index <= 15; index += 1) assert.match(fullText, new RegExp(`Approved handover item ${index}`));
  for (const [section, title] of [
    ['Key Decisions', 'Approved handover item 1'],
    ['Completed Work', 'Approved handover item 2'],
    ['Pending Tasks', 'Approved handover item 3'],
    ['Team Responsibilities', 'Approved handover item 4'],
    ['Blockers', 'Approved handover item 5'],
    ['Dependencies', 'Approved handover item 6'],
    ['Risks', 'Approved handover item 7'],
    ['Next Actions', 'Approved handover item 8'],
    ['Unresolved Questions', 'Approved handover item 9'],
  ]) {
    const page = pages.find((text) => text.includes(section));
    assert.ok(page?.includes(title), `${section} and its first finding should share a page`);
  }
  assert.match(fullText, /project-notes\.md/);
  assert.match(fullText, /architecture\.md/);
  assert.match(fullText, /8 approved findings reference this source/);
  assert.match(fullText, /Finding ID: finding-1/);
  assert.match(fullText, /Verified against source/);
  assert.match(fullText, /APPROVED FINDING - QUOTE NOT VERIFIED AGAINST SOURCE/);
  assert.match(fullText, /Project description has not been provided\./);
});

test('PDF page 1 text uses the report margins and stays inside the printable bounds', async () => {
  const categories = [
    'Decision', 'Completed Work', 'Pending Tasks', 'Responsibilities', 'Blockers',
    'Dependencies', 'Risks', 'Next Actions', 'Unresolved Questions',
  ];
  const findings = Array.from({ length: 15 }, (_, index) => ({
    ...approvedFinding,
    _id: `finding-${index + 1}`,
    category: categories[index % categories.length],
    title: `Approved handover item ${index + 1}`,
    description: `Reviewer-confirmed project context for item ${index + 1}. This detail should remain readable in the generated handover report.`,
    evidence: [{
      source: { _id: index % 2 ? 'source-b' : 'source-a', originalName: index % 2 ? 'architecture.md' : 'project-notes.md' },
      sourceName: index % 2 ? 'architecture.md' : 'project-notes.md',
      quote: `Evidence excerpt for approved item ${index + 1}.`,
      verificationStatus: index % 3 ? 'verified' : 'unverified',
      matchedText: index % 3 ? `Evidence excerpt for approved item ${index + 1}.` : null,
    }],
  }));
  const report = createHandoverSnapshot({ project: { ...project, description: '' }, approvedFindings: findings, version: 5 });
  const placements = extractPdfTextPlacements(await renderHandoverPdf(report));
  const pageOne = placements[0];
  const pageTwo = placements[1];
  const leftMargin = 52;
  const rightBoundary = 595.28 - 52;
  const placement = (page, prefix) => page.find((item) => item.text.startsWith(prefix));
  const bounded = (item, label) => {
    assert.ok(item, `${label} should be present in PDF text operators`);
    assert.ok(item.x >= leftMargin - 0.5, `${label} should begin inside the left content margin`);
    assert.ok(item.x + measuredTextWidth(item.text, item.fontSize, item.fontName) <= rightBoundary + 1,
      `${label} should end inside the right printable margin`);
  };

  const overview = placement(pageOne, 'Project Overview');
  const decisions = placement(pageOne, 'Key Decisions');
  const descriptionOne = placement(pageOne, 'Reviewer-confirmed project context for item 1');
  const evidenceLabel = placement(pageOne, 'APPROVED FINDING - QUOTE NOT VERIFIED AGAINST SOURCE');
  const evidenceQuote = placement(pageOne, 'Evidence excerpt for approved item 1.');
  const descriptionTwo = placement(pageTwo, 'Reviewer-confirmed project context for item 2');

  bounded(overview, 'Project Overview heading');
  bounded(decisions, 'Key Decisions heading');
  bounded(descriptionOne, 'Page 1 finding description');
  bounded(evidenceLabel, 'Page 1 evidence label');
  bounded(evidenceQuote, 'Page 1 evidence quote');
  bounded(descriptionTwo, 'Page 2 finding description');
  assert.ok(Math.abs(overview.x - descriptionOne.x) <= 0.5, 'page 1 body should share the standard report x origin');
  assert.ok(Math.abs(descriptionOne.x - descriptionTwo.x) <= 0.5, 'page 1 should use the same horizontal layout as page 2');

  placements.forEach((page, pageIndex) => page.forEach((item) => {
    const extent = item.x + measuredTextWidth(item.text, item.fontSize, item.fontName);
    assert.ok(item.x >= 0 && extent <= 595.28 + 1,
      `page ${pageIndex + 1} text should remain within the physical page bounds`);
  }));
});

test('PDF distinguishes approved findings from quotations not verified against their source', async () => {
  const report = createHandoverSnapshot({
    project,
    approvedFindings: [
      { ...approvedFinding, evidence: [{ sourceName: 'legacy.txt', quote: 'Human-reviewed content', verificationStatus: 'unverified' }] },
      { ...approvedFinding, _id: 'finding-2', title: 'Verified finding' },
    ],
    version: 3,
  });
  const pdf = await renderHandoverPdf(report);
  const text = extractPdfPageTexts(pdf).join('\n');
  assert.match(text, /APPROVED FINDING - QUOTE NOT VERIFIED AGAINST SOURCE/);
  assert.match(text, /Verified against source/);
  assert.doesNotMatch(text, /UNVERIFIED MODEL QUOTE/);
  assert.equal(report.sections['Key Decisions'][0].evidence[0].verificationStatus, 'unverified');
});

test('PDF page count matches its footers and every page contains report content', async () => {
  const report = createHandoverSnapshot({ project, approvedFindings: [], version: 1 });
  const pdf = await renderHandoverPdf(report);
  const pages = extractPdfPageTexts(pdf);
  assert.equal(pages.length, pdfPageCount(pdf));
  pages.forEach((text, index) => {
    assert.match(text, new RegExp(`Page ${index + 1} of ${pages.length}`));
    assert.ok(text.replace(/RELAY\s*\/\s*PROJECT HANDOVER|RELAY\s*\|\s*Version \d+\s*\|\s*Page \d+ of \d+/g, '').trim().length > 0, `page ${index + 1} must not be blank except for its header/footer`);
  });
});

test('creates useful empty report content when there are no approved findings', () => {
  const report = createHandoverSnapshot({ project, approvedFindings: [{ ...approvedFinding, status: 'rejected' }], version: 1 });
  assert.equal(report.approvedFindingCount, 0);
  assert.match(report.emptyMessage, /No approved findings/);
  assert.ok(Object.values(report.sections).every((items) => items.length === 0 || items.length === 1));
});

test('versions increase sequentially for serialized generations', () => {
  assert.equal(nextHandoverVersion(undefined), 1);
  assert.equal(nextHandoverVersion(1), 2);
  assert.equal(nextHandoverVersion(2), 3);
});

test('project lock admits only one concurrent generation and allows the next after release', async () => {
  const document = { token: null, expiresAt: null };
  const Project = {
    async updateOne(filter, update) {
      const available = !document.expiresAt || document.expiresAt <= filter.$or[1].handoverLockExpiresAt.$lte;
      if (!available) return { modifiedCount: 0 };
      document.token = update.$set.handoverLockToken;
      document.expiresAt = update.$set.handoverLockExpiresAt;
      return { modifiedCount: 1 };
    },
  };
  const now = new Date('2026-01-01T00:00:00Z');
  const results = await Promise.all([
    acquireHandoverLock(Project, 'project-1', 'token-a', now),
    acquireHandoverLock(Project, 'project-1', 'token-b', now),
  ]);
  assert.equal(results.filter(Boolean).length, 1);
  document.expiresAt = new Date(now.getTime() - 1);
  assert.equal(await acquireHandoverLock(Project, 'project-1', 'token-c', now), true);
});

test('PDF includes evidence verification, escapes text and paginates long reports', async () => {
  const report = createHandoverSnapshot({
    project: { ...project, name: 'Relay (handover)' }, approvedFindings: [{
      ...approvedFinding,
      description: Array.from({ length: 1200 }, (_, index) => `Long report line ${index}`).join(' '),
      evidence: [{ sourceName: 'identity.md', quote: 'Original quote', verificationStatus: 'unverified' }],
    }], version: 4,
  });
  const pdfBuffer = await renderHandoverPdf(report);
  const pdf = pdfBuffer.toString('latin1');
  assert.ok(pdf.startsWith('%PDF-'));
  assert.ok(pdf.includes('%%EOF'));
  assert.ok(pdfPageCount(pdfBuffer) >= 2);
  const pages = extractPdfPageTexts(pdfBuffer);
  assert.equal(pages.length, pdfPageCount(pdfBuffer));
  pages.forEach((text, index) => {
    assert.match(text, new RegExp(`Page ${index + 1} of ${pages.length}`));
    assert.ok(text.replace(/RELAY\s*\/\s*PROJECT HANDOVER|RELAY\s*\|\s*Version \d+\s*\|\s*Page \d+ of \d+/g, '').trim().length > 0,
      `long report page ${index + 1} must contain report content`);
  });
  const xrefOffset = Number(pdf.split('startxref').pop().trim().split(/\r?\n/)[0]);
  assert.equal(pdf.slice(xrefOffset, xrefOffset + 4), 'xref');
  const xref = pdf.slice(xrefOffset, pdf.lastIndexOf('trailer')).split(/\r?\n/);
  const objectCount = Number(xref[1].split(' ')[1]);
  for (let objectId = 1; objectId < objectCount; objectId += 1) {
    const objectOffset = Number(xref[2 + objectId].slice(0, 10));
    assert.ok(pdf.startsWith(`${objectId} 0 obj`, objectOffset));
  }
});

test('read access includes owners/editors/viewers while only owner/editor can generate', () => {
  const teamProject = { owner: 'owner-1', members: [{ user: 'editor-1', role: 'editor' }, { user: 'viewer-1', role: 'viewer' }] };
  for (const member of ['owner-1', 'editor-1', 'viewer-1']) assert.equal(canReadProject(teamProject, member), true);
  assert.equal(canReadProject(teamProject, 'stranger'), false);
  assert.equal(canEditProject(teamProject, 'owner-1'), true);
  assert.equal(canEditProject(teamProject, 'editor-1'), true);
  assert.equal(canEditProject(teamProject, 'viewer-1'), false);
  assert.equal(canEditProject(teamProject, 'stranger'), false);
});
