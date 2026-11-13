# artifacts-and-mobile

Moved verbatim from `FORK.md` on 2026-11-13. These rules and records stay binding; read this file before acting on the topic. Artifacts page filters/folders/preview and mobile PDF return

### Mobile PDF return (2026-11-08)

Feature branch michael/mobile-pdf-return adds one local-state PDF preview dialog
across attachment entry points. Back restores the task/sheet, with separate raw
and download actions; browser Back remains normal navigation. The authenticated
PDF stream is bounded and validated before embedding, and URLs/reads are released
on close. See AGENTS.md and doc/DEVELOPING.md for the contract and device limits.
Publish from michael/main through the existing UI overlay after relevant UI
tests, typecheck, token gates and build; retain rollback assets. No backend,
schema, restart, worker retry or workspace-policy changes are part of this fix.

- Artifacts media filter (HOM-241, released by HOM-249): the company Artifacts API
  accepts an opt-in `mediaOnly` flag, enabled only by the Artifacts page. The filter
  runs in SQL so counts, pagination and grouping agree, keeps image/video/audio/PDF
  attachments and hides task documents, text/JSON/Markdown attachments and non-attachment
  work products. Stored records are unchanged and other listing callers keep their result.
  Feature commit `ffec9110d`, merged as `2bfd909f8`; no schema change; fc0350d9af-r1 is
  kept for rollback.
- Artifacts project folders (HOM-266, 2026-11-09): the Artifacts page opens on a
  Projects view, one folder per project plus a "No project" folder, built from the
  `mediaOnly` projection through the new opt-in `groupBy=project` grouping; opening a
  folder (`groupProjectId`, a project id or `none`) filters every source in SQL and pages
  by cursor, and archived or foreign projects return no folder. `mediaOnly` now also
  admits Office files (pptx/ppt/key/odp, docx/doc/odt, xlsx/xls/ods) by content type,
  using the extension only for generic types, so Markdown/JSON named like media stay out.
  The project page's Artifacts tab requests `mediaOnly` too, so task plans and notes no
  longer appear there. Task grouping stays in the Group by menu, and saved
  `?groupIssueId=` links still open their stack. Stored records are unchanged; no schema
  change.
- Artifacts chat project (HOM-265, 2026-11-09): agent chats carry no project, so their
  media fell into "No project". The artifacts listing now files an issue under
  `coalesce(issues.project_id, <the one active project led by its conversation agent>)`
  for project folders, the `projectId` filter (project page tab), the archived-project
  filter and each artifact's `project`. An explicit project wins; an agent leading none
  or several active projects stays under "No project". Read-only; no stored issue or
  project changes, no schema change.
- Artifacts open the file (HOM-265, 2026-11-10): on the Artifacts page (single tiles and
  classic cards) and the project Artifacts tab, a file-backed artifact (attachment or work
  product with `openPath`/`contentPath`) opens its stored file instead of its task: a PDF in
  the shared in-app PdfPreviewProvider dialog, anything else in a new tab. The classic card
  keeps the task one click away as a secondary action. Documents and work products without a
  file still open their task. UI only (`ui/src/lib/artifact-file-link.ts`); no API change.
  Follow-up (same day): a plain click shows the file in a small page-local preview window
  (`ArtifactPreviewProvider`: image, video, audio, PDF through the shared validated
  `PdfContent`; other types offer a download) with task, new-tab and download actions;
  modifier clicks keep the native new-tab link. Navigation closes the window.
