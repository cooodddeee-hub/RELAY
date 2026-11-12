function normalizeForMatch(value) {
  // Ignore only Markdown list markers at the start of a line. Requiring a
  // following space avoids treating horizontal rules or ordinary hyphens as bullets.
  const withoutListMarkers = [];
  let lineStart = 0;
  while (lineStart <= value.length) {
    let lineEnd = value.indexOf('\n', lineStart);
    if (lineEnd < 0) lineEnd = value.length;
    const line = value.slice(lineStart, lineEnd);
    const marker = line.match(/^[\t ]*(?:[-*+]|\d+[.)])[\t ]+/);
    const contentStart = lineStart + (marker ? marker[0].length : 0);
    for (let offset = contentStart; offset < lineEnd; offset += 1) withoutListMarkers.push({ character: value[offset], sourceOffset: offset });
    if (lineEnd < value.length) withoutListMarkers.push({ character: '\n', sourceOffset: lineEnd });
    if (lineEnd === value.length) break;
    lineStart = lineEnd + 1;
  }

  // Treat whitespace runs (including CRLF/newlines) as one space. Keep an
  // offset for every normalized UTF-16 code unit so matches map to source text.
  const characters = [];
  const offsets = [];
  let pendingWhitespace = null;
  for (const item of withoutListMarkers) {
    if (/\s/.test(item.character)) {
      if (characters.length && pendingWhitespace === null) pendingWhitespace = item.sourceOffset;
      continue;
    }
    if (pendingWhitespace !== null) {
      characters.push(' ');
      offsets.push(pendingWhitespace);
      pendingWhitespace = null;
    }
    characters.push(item.character);
    offsets.push(item.sourceOffset);
  }
  return { text: characters.join(''), offsets };
}

/** Verify quotes with source offsets measured in original UTF-16 string units. */
export function verifyEvidenceQuote({ sourceId, sourceName, sourceText, quote, section = '' }) {
  const originalQuote = typeof quote === 'string' ? quote : '';
  const evidence = {
    source: sourceId,
    sourceName,
    quote: originalQuote,
    section: typeof section === 'string' ? section : '',
    verificationStatus: 'unverified',
  };
  if (!originalQuote) return evidence;

  const originalText = typeof sourceText === 'string' ? sourceText : '';
  const normalizedSource = normalizeForMatch(originalText);
  const normalizedQuote = normalizeForMatch(originalQuote).text;
  if (!normalizedQuote) return evidence;
  const normalizedStart = normalizedSource.text.indexOf(normalizedQuote);
  if (normalizedStart < 0) return evidence;

  const startOffset = normalizedSource.offsets[normalizedStart];
  const finalCharacterOffset = normalizedSource.offsets[normalizedStart + normalizedQuote.length - 1];
  const endOffset = finalCharacterOffset + 1;
  return { ...evidence, verificationStatus: 'verified', matchedText: originalText.slice(startOffset, endOffset), startOffset, endOffset };
}
