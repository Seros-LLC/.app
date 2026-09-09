# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

Inferred from the existing product copy and application: delivery leads, product leads, operations leaders, and technical agencies whose commitments are made in Slack but must be tracked in Linear. Their job is to close the hand-off from a specific conversation to an owned task without losing source context.

## Product Purpose

Seros turns commitments from explicitly selected Slack channels into proposed Linear issues. The human reviewer edits, confirms, or rejects every proposal before Seros writes anything to the tracker.

## Positioning

Seros is a permissioned, human-confirmed commitment-to-task workflow: it does not autonomously create tracker work, and it does not ingest channels the workspace has not selected.

## Operating Context

A workspace owner creates a workspace, connects Slack, selects in-scope channels, and reviews drafts in an application queue. Confirmed work is written to Linear with source context. Members can inspect confirmed tasks and audit records.

## Capabilities and Constraints

Slack is connected by an owner or admin; unticked channels are not read. A proposed owner or due date is retained only where supported by the conversation. Linear is the production tracker integration. Production must not expose synthetic or demo paths. The site is static HTML; the application is server-rendered TypeScript/Express with CSP-safe markup.

## Evidence on Hand

Existing repository copy, application views, setup flow, and brand art. There are no approved customer testimonials, pricing plans, performance benchmarks, or certification claims; future marketing must not invent them.

## Product Principles

- Human confirmation is mandatory before every tracker write.
- Channel scope is chosen explicitly, not inferred.
- Source context must survive the Slack-to-tracker hand-off.
- A missed commitment is preferable to an unreviewed task.
- The product should make accountability clearer, not add automation theater.

## Accessibility & Inclusion

Inferred constraint: the web experiences should meet WCAG 2.2 AA where practical, including keyboard-operable controls, meaningful form states, responsive layout, and reduced-motion support.
