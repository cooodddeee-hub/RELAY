import PDFDocument from 'pdfkit';

export const HANDOVER_SECTIONS = [
  'Project Overview', 'Key Decisions', 'Completed Work', 'Pending Tasks',
  'Responsibilities', 'Blockers', 'Dependencies', 'Risks', 'Next Actions', 'Unresolved Questions',
];

const PDF_SECTIONS = [
  { title: 'Project Overview', keys: ['Project Overview'], overview: true },
  { title: 'Key Decisions', keys: ['Key Decisions', 'Decision'] },
  { title: 'Completed Work', keys: ['Completed Work'] },
  { title: 'Pending Tasks', keys: ['Pending Tasks'] },
  { title: 'Team Responsibilities', keys: ['Team Responsibilities', 'Responsibilities'] },
  { title: 'Blockers', keys: ['Blockers'] },
  { title: 'Dependencies', keys: ['Dependencies'] },
  { title: 'Risks', keys: ['Risks'] },
  { title: 'Next Actions', keys: ['Next Actions'] },
  { title: 'Unresolved Questions', keys: ['Unresolved Questions'] },
];

export function nextHandoverVersion(latestVersion) {
  return Number.isInteger(latestVersion) && latestVersion > 0 ? latestVersion + 1 : 1;
}

export async function acquireHandoverLock(Project, projectId, token, now = new Date(), lockMs = 120_000) {
  const result = await Project.updateOne(
    { _id: projectId, $or: [{ handoverLockExpiresAt: { $exists: false } }, { handoverLockExpiresAt: { $lte: now } }] },
    { $set: { handoverLockToken: token, handoverLockExpiresAt: new Date(now.getTime() + lockMs) } },
  );
  return result.modifiedCount === 1;
}

const CATEGORY_SECTION = new Map([
  ['Decision', 'Key Decisions'], ['Completed Work', 'Completed Work'], ['Pending Tasks', 'Pending Tasks'],
  ['Responsibilities', 'Responsibilities'], ['Blockers', 'Blockers'], ['Dependencies', 'Dependencies'],
  ['Risks', 'Risks'], ['Next Actions', 'Next Actions'], ['Unresolved Questions', 'Unresolved Questions'],
]);

function sourceId(evidence) {
  const source = evidence?.source;
  return source?._id ? String(source._id) : typeof source === 'string' ? source : null;
}

export function createHandoverSnapshot({ project, approvedFindings, version, generatedAt = new Date(), generatedBy }) {
  const findings = (approvedFindings || []).filter((finding) => finding.status === 'approved');
  const sections = Object.fromEntries(HANDOVER_SECTIONS.map((section) => [section, []]));
  sections['Project Overview'].push({
    description: project.description || 'Project description has not been provided.',
  });

  for (const finding of findings) {
    const section = CATEGORY_SECTION.get(finding.category);
    if (!section) continue;
    sections[section].push({
      findingId: String(finding._id),
      category: finding.category,
      approvalStatus: finding.status,
      title: finding.title,
      description: finding.description,
      evidence: (finding.evidence || []).map((item) => ({
        sourceId: sourceId(item),
        sourceName: item.sourceName || item.source?.originalName || 'Source filename unavailable',
        quote: item.quote || '',
        verificationStatus: item.verificationStatus === 'verified' ? 'verified' : 'unverified',
        matchedText: item.verificationStatus === 'verified' && typeof item.matchedText === 'string' ? item.matchedText : null,
        startOffset: item.verificationStatus === 'verified' && Number.isInteger(item.startOffset) ? item.startOffset : null,
        endOffset: item.verificationStatus === 'verified' && Number.isInteger(item.endOffset) ? item.endOffset : null,
      })),
    });
  }

  return {
    version,
    generatedAt: new Date(generatedAt).toISOString(),
    generatedBy: generatedBy ? { id: String(generatedBy._id || generatedBy.id), name: generatedBy.name || generatedBy.email || 'RELAY user' } : null,
    project: { id: String(project._id), name: project.name, description: project.description || '' },
    approvedFindingCount: findings.length,
    emptyMessage: findings.length ? null : 'No approved findings were available when this report was generated.',
    sections,
  };
}

function printableText(value) {
  return String(value ?? '').replace(/[\u2018\u2019]/g, "'").replace(/[\u201C\u201D]/g, '"')
    .replace(/[\u2013\u2014]/g, '-').replace(/\u2026/g, '...').replace(/\u2022/g, '*')
    .replace(/[^\x20-\x7E\xA0-\xFF]/g, '?');
}

function sectionItems(report, definition) {
  for (const key of definition.keys) {
    const items = report.sections?.[key];
    if (Array.isArray(items) && items.length) return items.filter(isApprovedSnapshotItem);
  }
  if (definition.title === 'Key Decisions') return [...(report.sections?.Decision || [])].filter(isApprovedSnapshotItem);
  return [];
}

function isApprovedSnapshotItem(item) {
  const status = item?.approvalStatus || item?.status;
  return !status || status === 'approved';
}

function overviewText(report, items) {
  const projectDescription = typeof report.project?.description === 'string' ? report.project.description.trim() : '';
  if (projectDescription) return projectDescription;
  const savedDescription = items.map((item) => item?.description).find((value) => typeof value === 'string' && value.trim()
    && !['No project description is available.', 'Project description has not been provided.'].includes(value.trim()));
  return savedDescription || 'Project description has not been provided.';
}

function categoryFromSection(sectionTitle) {
  if (sectionTitle === 'Key Decisions') return 'Decision';
  if (sectionTitle === 'Team Responsibilities') return 'Responsibilities';
  return sectionTitle;
}

function textHeight(document, value, { font = 'Helvetica', size = 10, width, lineGap = 3 } = {}) {
  document.font(font).fontSize(size);
  return document.heightOfString(printableText(value), { width, lineGap });
}

function contentBottom(document) {
  return document.page.height - document.page.margins.bottom;
}

function ensureSpace(document, height) {
  if (document.y + height <= contentBottom(document)) return;
  document.addPage();
}

function findingLayout(document, item, sectionTitle, width) {
  const title = typeof item.title === 'string' ? item.title.trim() : '';
  const description = typeof item.description === 'string' ? item.description.trim() : '';
  const evidence = Array.isArray(item.evidence) ? item.evidence : [];
  const category = item.category || categoryFromSection(sectionTitle);
  const approval = item.approvalStatus || item.status || 'Approved at snapshot time';
  const titleHeight = title ? textHeight(document, title, { font: 'Helvetica-Bold', size: 12, width }) : 0;
  const metadataHeight = textHeight(document, `Category: ${category} | Approval: ${approval}`, { font: 'Helvetica', size: 8.5, width });
  const descriptionHeight = description ? textHeight(document, description, { font: 'Helvetica', size: 10.5, width, lineGap: 4 }) + 8 : 0;
  const evidenceHeightTotal = evidence.reduce((sum, entry) => sum + evidenceHeight(document, entry, width) + 8, 0);
  return {
    titleHeight,
    leadHeight: titleHeight + metadataHeight + 32,
    totalHeight: titleHeight + metadataHeight + descriptionHeight + evidenceHeightTotal + 32,
  };
}

function drawSectionHeading(document, title, firstFinding = null, minimumFollowingHeight = 36) {
  const x = document.page.margins.left;
  const width = document.page.width - x - document.page.margins.right;
  const headingHeight = textHeight(document, title, { font: 'Helvetica-Bold', size: 16, width });
  const findingMetrics = firstFinding ? findingLayout(document, firstFinding, title, width) : null;
  const pageCapacity = contentBottom(document) - document.page.margins.top;
  const afterHeading = findingMetrics
    ? Math.min(findingMetrics.totalHeight, Math.max(findingMetrics.leadHeight, pageCapacity - headingHeight - 38))
    : Math.min(minimumFollowingHeight, Math.max(36, pageCapacity - headingHeight - 38));
  ensureSpace(document, headingHeight + afterHeading + 24);
  document.moveDown(0.55);
  document.font('Helvetica-Bold').fontSize(16).fillColor('#18243d')
    .text(printableText(title), { width, lineGap: 3 });
  document.moveDown(0.18);
  document.moveTo(x, document.y).lineTo(x + width, document.y).lineWidth(0.8).strokeColor('#d7deea').stroke();
  document.moveDown(0.5);
}

function evidenceHeight(document, evidence, width) {
  const name = evidence.sourceName || 'Source filename unavailable';
  const quote = evidence.verificationStatus === 'verified' && typeof evidence.matchedText === 'string'
    ? evidence.matchedText : evidence.quote;
  return 14 + textHeight(document, `Source: ${name}`, { font: 'Helvetica-Bold', size: 9.5, width })
    + (quote ? 9 + textHeight(document, quote, { font: 'Helvetica', size: 10.5, width: width - 18, lineGap: 3 }) : 0);
}

function drawEvidence(document, evidence, width) {
  const verified = evidence.verificationStatus === 'verified' && typeof evidence.matchedText === 'string';
  const quote = verified ? evidence.matchedText : evidence.quote;
  const name = evidence.sourceName || (evidence.sourceId ? `Source ID ${evidence.sourceId}` : 'Source filename unavailable');
  const label = verified ? 'Verified against source' : 'APPROVED FINDING - QUOTE NOT VERIFIED AGAINST SOURCE';
  const needed = evidenceHeight(document, evidence, width);
  const maximum = contentBottom(document) - document.page.margins.top;
  if (needed <= maximum) ensureSpace(document, needed + 14);

  document.moveDown(0.35);
  const startY = document.y;
  document.font('Helvetica-Bold').fontSize(8.5).fillColor(verified ? '#176b4d' : '#936000')
    .text(label, { width, lineGap: 2 });
  document.moveDown(0.15);
  document.font('Helvetica-Bold').fontSize(9.5).fillColor('#475569')
    .text(printableText(`Source: ${name}`), { width, lineGap: 2 });
  if (quote) {
    document.moveDown(0.18);
    const quoteStart = document.y;
    const quotePage = document.page;
    document.font('Helvetica').fontSize(10.5).fillColor('#334155')
      .text(printableText(quote), { width: width - 18, indent: 9, lineGap: 3 });
    const quoteEnd = document.y;
    if (document.page === quotePage) {
      document.save().lineWidth(2).strokeColor(verified ? '#38a879' : '#d79b2e')
        .moveTo(document.page.margins.left + 2, quoteStart - 1).lineTo(document.page.margins.left + 2, quoteEnd).stroke().restore();
    }
  }
  if (evidence.quote && verified && evidence.quote !== evidence.matchedText) {
    document.moveDown(0.2).font('Helvetica-Oblique').fontSize(8.5).fillColor('#64748b')
      .text(printableText(`Submitted quote: ${evidence.quote}`), { width, lineGap: 2 });
  }
  if (document.y <= startY) document.moveDown(0.5);
}

function drawFinding(document, item, sectionTitle, { skipSpaceCheck = false } = {}) {
  const x = document.page.margins.left;
  const width = document.page.width - x - document.page.margins.right;
  const title = typeof item.title === 'string' ? item.title.trim() : '';
  const description = typeof item.description === 'string' ? item.description.trim() : '';
  const evidence = Array.isArray(item.evidence) ? item.evidence : [];
  const category = item.category || categoryFromSection(sectionTitle);
  const approval = item.approvalStatus || item.status || 'Approved at snapshot time';
  const metrics = findingLayout(document, item, sectionTitle, width);
  const available = contentBottom(document) - document.page.margins.top;
  if (!skipSpaceCheck) ensureSpace(document, metrics.totalHeight <= available ? metrics.totalHeight : metrics.leadHeight);

  const startY = document.y;
  if (title) {
    document.font('Helvetica-Bold').fontSize(12).fillColor('#111827')
      .text(printableText(title), { width, lineGap: 3 });
  }
  document.moveDown(0.15);
  document.font('Helvetica').fontSize(8.5).fillColor('#5b6680')
    .text(printableText(`Category: ${category}  |  Approval: ${approval}`), { width, lineGap: 2 });
  if (item.findingId) {
    document.font('Helvetica').fontSize(8).fillColor('#7b8495')
      .text(printableText(`Finding reference: ${item.findingId}`), { width, lineGap: 2 });
  }
  if (description) {
    document.moveDown(0.35);
    document.font('Helvetica').fontSize(10.5).fillColor('#293449')
      .text(printableText(description), { width, lineGap: 4 });
  }
  if (!evidence.length) {
    document.moveDown(0.25).font('Helvetica-Oblique').fontSize(9).fillColor('#64748b')
      .text('No evidence was captured for this finding.', { width, lineGap: 2 });
  } else evidence.forEach((entry) => drawEvidence(document, entry, width));

  const endY = document.y;
  document.save().lineWidth(0.7).strokeColor('#e1e6ef')
    .moveTo(x, endY + 8).lineTo(x + width, endY + 8).stroke().restore();
  document.y = endY + 18;
  if (document.y < startY) document.y = startY;
}

function allFindingEntries(report) {
  const entries = [];
  const seen = new Set();
  for (const definition of PDF_SECTIONS.filter((section) => !section.overview)) {
    for (const item of sectionItems(report, definition)) {
      if (!item || typeof item !== 'object') continue;
      const identity = item.findingId || `${definition.title}:${item.title || ''}:${item.description || ''}`;
      if (seen.has(identity)) continue;
      seen.add(identity);
      entries.push({ item, sectionTitle: definition.title });
    }
  }
  return entries;
}

function sourceReferenceLayout(document, reference, width) {
  const name = reference.evidence.sourceName || 'Source filename unavailable';
  const rows = reference.findings.map((item) => ({
    title: `Finding: ${item.title || 'Untitled finding'}`,
    id: item.findingId ? `Finding ID: ${item.findingId}` : '',
  }));
  const cardPadding = 15;
  const headerHeight = textHeight(document, name, { font: 'Helvetica-Bold', size: 12, width: width - 34, lineGap: 3 })
    + textHeight(document, `${rows.length} approved finding${rows.length === 1 ? '' : 's'} reference this source`, { font: 'Helvetica', size: 9.5, width: width - 34 }) + 12;
  const titleWidth = width - 154;
  const rowsHeight = rows.reduce((sum, row) => sum + Math.max(
    textHeight(document, row.title, { font: 'Helvetica', size: 10.5, width: titleWidth, lineGap: 3 }),
    row.id ? textHeight(document, row.id, { font: 'Helvetica', size: 7.5, width: 110, lineGap: 2 }) : 0,
  ) + 8, 0);
  return { name, rows, cardHeight: cardPadding * 2 + headerHeight + rowsHeight };
}

function drawSourceReferences(document, report) {
  const references = new Map();
  for (const { item } of allFindingEntries(report)) {
    for (const evidence of item.evidence || []) {
      const key = evidence.sourceId || evidence.sourceName || 'source-unavailable';
      if (!references.has(key)) references.set(key, { evidence, findings: [] });
      references.get(key).findings.push(item);
    }
  }
  const width = document.page.width - document.page.margins.left - document.page.margins.right;
  const layouts = [...references.values()].map((reference) => sourceReferenceLayout(document, reference, width));
  const firstCardHeight = layouts[0]?.cardHeight || 36;
  const allCardsHeight = layouts.reduce((sum, layout) => sum + layout.cardHeight + 12, 0);
  const headingHeight = textHeight(document, 'Evidence and Source References', { font: 'Helvetica-Bold', size: 16, width });
  const pageCapacity = contentBottom(document) - document.page.margins.top;
  const pageRemaining = contentBottom(document) - document.y;
  if (allCardsHeight + headingHeight + 72 <= pageCapacity && allCardsHeight + headingHeight + 72 > pageRemaining) {
    document.addPage();
  }
  drawSectionHeading(document, 'Evidence and Source References', null, firstCardHeight);
  if (!references.size) {
    document.font('Helvetica').fontSize(10).fillColor('#64748b')
      .text('No source references were captured in this handover snapshot.', { width: document.page.width - document.page.margins.left - document.page.margins.right, lineGap: 4 });
    return;
  }
  for (const [[key, reference], layout] of [...references.entries()].map((entry, index) => [entry, layouts[index]])) {
    const { name, rows, cardHeight } = layout;
    const cardPadding = 15;
    const available = contentBottom(document) - document.y;
    const pageCapacity = contentBottom(document) - document.page.margins.top;
    if (cardHeight <= pageCapacity && cardHeight > available) document.addPage();

    const cardTop = document.y + 2;
    document.save().roundedRect(document.page.margins.left, cardTop, width, cardHeight, 8).fill('#f5f6fa');
    document.save().roundedRect(document.page.margins.left, cardTop, 4, cardHeight, 2).fill('#7863d8').restore();
    const contentX = document.page.margins.left + 17;
    let cursorY = cardTop + cardPadding;
    document.font('Helvetica-Bold').fontSize(12).fillColor('#1d2a43')
      .text(printableText(name), contentX, cursorY, { width: width - 34, lineGap: 3 });
    cursorY = document.y + 4;
    document.font('Helvetica').fontSize(9.5).fillColor('#68738a')
      .text(`${rows.length} approved finding${rows.length === 1 ? '' : 's'} reference this source`, contentX, cursorY, { width: width - 34, lineGap: 2 });
    cursorY = document.y + 8;
    rows.forEach((row) => {
      const titleWidth = width - 154;
      const titleHeight = textHeight(document, row.title, { font: 'Helvetica', size: 10.5, width: titleWidth, lineGap: 3 });
      const idHeight = row.id ? textHeight(document, row.id, { font: 'Helvetica', size: 7.5, width: 110, lineGap: 2 }) : 0;
      document.font('Helvetica').fontSize(10.5).fillColor('#334155')
        .text(printableText(row.title), contentX + 5, cursorY, { width: titleWidth, lineGap: 3 });
      if (row.id) {
        document.font('Helvetica').fontSize(7.5).fillColor('#858da0')
          .text(printableText(row.id), contentX + 13 + titleWidth, cursorY, { width: 110, align: 'right', lineBreak: false });
      }
      cursorY += Math.max(titleHeight, idHeight) + 8;
    });
    document.restore();
    document.y = Math.max(cardTop + cardHeight, cursorY) + 12;
  }
}

function formatGeneratedDate(value) {
  const date = value ? new Date(value) : null;
  return date && !Number.isNaN(date.getTime()) ? date.toLocaleString('en-US', { timeZone: 'UTC', dateStyle: 'long', timeStyle: 'short' }) + ' UTC' : 'Not recorded';
}

function drawCover(document, report) {
  const width = document.page.width;
  const left = document.page.margins.left;
  const contentWidth = width - left - document.page.margins.right;
  const projectName = report.project?.name || 'Project name not recorded';
  document.save().rect(0, 0, width, 224).fill('#101a33');
  document.font('Helvetica-Bold').fontSize(34).fillColor('#ffffff').text('RELAY', left, 42, { lineBreak: false });
  document.font('Helvetica').fontSize(12).fillColor('#b8a9ff').text('PROJECT KNOWLEDGE HANDOVER REPORT', left, 88, { lineBreak: false });
  document.font('Helvetica-Bold').fontSize(23).fillColor('#ffffff').text(printableText(projectName), left, 126, { width: contentWidth - 100, lineGap: 3 });
  document.roundedRect(width - document.page.margins.right - 92, 42, 92, 34, 9).fill('#6d4aff');
  document.font('Helvetica-Bold').fontSize(10).fillColor('#ffffff')
    .text(`VERSION ${report.version ?? '—'}`, width - document.page.margins.right - 86, 54, { width: 80, align: 'center', lineBreak: false });
  document.restore();

  const cardY = 244;
  const cardHeight = 66;
  document.save().roundedRect(left, cardY, contentWidth, cardHeight, 10).fill('#f1f3f8');
  const columnWidth = (contentWidth - 44) / 3;
  const fields = [
    ['GENERATED', formatGeneratedDate(report.generatedAt)],
    ['PREPARED BY', report.generatedBy?.name || report.generatedBy?.email || 'Not recorded'],
    ['APPROVED FINDINGS', String(report.approvedFindingCount ?? allFindingEntries(report).length)],
  ];
  fields.forEach(([label, value], index) => {
    const x = left + 16 + index * (columnWidth + 6);
    document.font('Helvetica-Bold').fontSize(7.5).fillColor('#778198').text(label, x, cardY + 13, { width: columnWidth, lineBreak: false });
    document.font('Helvetica-Bold').fontSize(9).fillColor('#1d2a43').text(printableText(value), x, cardY + 31, { width: columnWidth, height: 28, lineGap: 2 });
  });
  document.restore();
  // The metadata grid's last explicit text x-coordinate is the third column.
  // PDFKit keeps that cursor after restore(), so reset the body cursor to the
  // normal content margin before the first report section is rendered.
  document.x = left;
  document.y = cardY + cardHeight + 7;
}

function drawPageHeader(document) {
  const left = document.page.margins.left;
  const right = document.page.width - document.page.margins.right;
  document.save().font('Helvetica-Bold').fontSize(8).fillColor('#6554a4')
    .text('RELAY  /  PROJECT HANDOVER', left, 27, { lineBreak: false });
  document.moveTo(left, 48).lineTo(right, 48).lineWidth(0.6).strokeColor('#d7deea').stroke().restore();
}

export function renderHandoverPdf(report) {
  return new Promise((resolve, reject) => {
    const document = new PDFDocument({
      size: 'A4', margins: { top: 68, right: 52, bottom: 88, left: 52 },
      bufferPages: true, compress: false,
      info: { Title: `RELAY Handover v${report.version ?? 'unknown'}`, Author: 'RELAY' },
    });
    const chunks = [];
    document.on('data', (chunk) => chunks.push(chunk));
    document.on('error', reject);
    document.on('end', () => resolve(Buffer.concat(chunks)));

    drawCover(document, report);
    for (const definition of PDF_SECTIONS) {
      if (definition.overview) {
        const items = sectionItems(report, definition);
        drawSectionHeading(document, definition.title, true);
        const description = overviewText(report, items);
        const width = document.page.width - document.page.margins.left - document.page.margins.right;
        document.font('Helvetica').fontSize(10.5).fillColor('#293449')
          .text(printableText(description), { width, lineGap: 4 });
        document.moveDown(0.45);
        continue;
      }
      const items = sectionItems(report, definition);
      drawSectionHeading(document, definition.title, items[0] || null);
      if (!items.length) {
        const width = document.page.width - document.page.margins.left - document.page.margins.right;
        document.font('Helvetica-Oblique').fontSize(9.5).fillColor('#778198')
          .text('No approved information available.', { width, lineGap: 3 });
        document.moveDown(0.45);
        continue;
      }
      items.forEach((item, index) => drawFinding(document, item, definition.title, { skipSpaceCheck: index === 0 }));
    }
    drawSourceReferences(document, report);

    const pages = document.bufferedPageRange();
    for (let pageIndex = pages.start; pageIndex < pages.start + pages.count; pageIndex += 1) {
      document.switchToPage(pageIndex);
      if (pageIndex > pages.start) drawPageHeader(document);
      const bottomMargin = document.page.margins.bottom;
      document.page.margins.bottom = 0;
      document.save().font('Helvetica').fontSize(8).fillColor('#737b89')
        .text(`RELAY  |  Version ${report.version ?? '—'}  |  Page ${pageIndex + 1} of ${pages.count}`,
          document.page.margins.left, document.page.height - 38,
          { width: document.page.width - document.page.margins.left - document.page.margins.right, align: 'right', lineBreak: false });
      document.restore();
      document.page.margins.bottom = bottomMargin;
    }
    document.end();
  });
}
