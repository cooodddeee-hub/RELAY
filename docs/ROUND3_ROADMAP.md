# RELAY Round 3 Roadmap and Delivery Status

**Status:** Round 3 feature implementation is complete in the current working tree. This document records delivery status and remaining release gates; it does not recommend beginning already-completed feature phases. Production deployment is not certified by local tests.

## Scoring criteria

| Criterion | Points | Delivery evidence |
| --- | ---: | --- |
| Completeness | 25 | Source ingestion through explicit analysis, evidence review, immutable handover versions, and version-bound signoff. |
| Three promised improvements | 20 | GitHub multi-source intake; narrow evidence-backed contradiction candidates with human review; separate reviewer/approver permissions and formal signoff. |
| Reliability | 20 | Bounded manual sync with durable checkpoints, revision-pinned analysis, unique-index migration safeguards, retryable deletion, and regression coverage. |
| Usability | 20 | Responsive project workspace with source provenance, sync progress, review/signoff and recovery states. Browser end-to-end validation remains a release task. |
| Documentation and roadmap | 15 | Setup, architecture, API, migration, deployment, demo, and limitation documentation maintained against implementation. |

## Completed implementation

- GitHub App authorization, installation verification, owner-authorized repository linking/unlinking, and safe audit events.
- Manual bounded README/commit/issue ingestion with immutable source revisions, checkpoints, leases, explicit retry, and no automatic analysis.
- Explicit AI analysis pins GitHub source revisions; findings retain revision evidence. Uploaded-source and legacy job compatibility remains.
- Contradiction candidates use supported, evidence-backed patterns across revisions. Candidates require human review and rationale. Only human-confirmed conflicts appear in newly generated handovers. This is not general semantic contradiction detection.
- Granular reviewer, approver, and audit-reader assignments remain distinct from editor role.
- Handover snapshots are versioned and immutable. Assigned workflow uses exact-version signoff; creator self-approval is denied, rejection requires a reason, and pending older versions become computed superseded status.
- Project deletion uses a tombstone and recovery window followed by scheduled retryable cleanup; required audit/signoff metadata retention is configurable.
- Frontend workflows exist for GitHub sync, sources, review, contradictions, signoff, and deletion recovery.

See [the implementation plan](ROUND3_IMPLEMENTATION_PLAN.md), [the detailed Phase 4 plan](ROUND3_PHASE4_IMPLEMENTATION_PLAN.md), and [the architecture decisions](ROUND3_ARCHITECTURE_DECISIONS.md) for implemented behavior and compatibility constraints.

## Remaining release gates

1. Review the production Vercel project roots, effective runtime/function duration, environment variable names, frontend API base, CORS origin, GitHub App callback/setup URLs, and cron registration.
2. Back up the exact production database, verify restore readiness, run the ordered duplicate preflight/dry-run reports, obtain explicit migration approval, apply migrations in order, and run full index verification. No production migration has been run from this repository workflow.
3. Verify indexes directly in the target database. Production Mongoose `autoIndex` is disabled; `Model.init()` is not a guarantee of index creation.
4. Perform browser smoke tests with a disposable project, including GitHub authorization and sync, explicit analysis, reviewer decisions, contradiction review, handover signoff, and deletion recovery. Confirm cron authentication and one safe cleanup cycle.
5. Record final regression results, known limitations, and operational ownership before approving deployment.

Use [Known Limitations](KNOWN_LIMITATIONS.md) for behavior boundaries and [Vercel Deployment](../VERCEL_DEPLOYMENT.md) for deployment setup. Completing the feature phases does not imply that infrastructure, migrations, browser verification, or production data are ready.
