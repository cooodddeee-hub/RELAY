export const DEMO_ANALYSIS_FALLBACK = Object.freeze({
  label: 'DEMO DATA — NOT LIVE AI OUTPUT',
  sourceName: 'campus-connect-sample-brief.md',
  sourceText: `# Campus Connect — Sample Handover Brief

## Decision
The team selected university single sign-on for student accounts.

## Completed work
The closed beta launched with three student clubs on October 21.

## Pending task
Before general availability, verify calendar export for recurring events.
`,
  findings: Object.freeze([
    Object.freeze({
      category: 'Decision',
      title: 'Use university single sign-on',
      description: 'The sample team selected university single sign-on for student accounts.',
      quote: 'The team selected university single sign-on for student accounts.',
    }),
    Object.freeze({
      category: 'Completed Work',
      title: 'Closed beta launched with three clubs',
      description: 'The sample closed beta launched on October 21.',
      quote: 'The closed beta launched with three student clubs on October 21.',
    }),
    Object.freeze({
      category: 'Pending Tasks',
      title: 'Verify recurring event calendar export',
      description: 'Recurring event calendar export still needs verification before general availability.',
      quote: 'Before general availability, verify calendar export for recurring events.',
    }),
  ]),
});
