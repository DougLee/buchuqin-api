# Main merge + RBAC UI goal — 2026-09-21

Status: completed locally; final results are in acceptance.md. Entries below retain their chronological, pre-completion meaning.

Authorized: necessary local preservation/merge commits; no push, merge back to main, production deployment/data changes. No subagents requested.

## Fixed inputs
- API original RBAC HEAD dbfad69; preserved verified dirty work in f02b589.
- Admin original RBAC HEAD 8e02693; preserved dirty work in a68637d.
- API fetched main/origin/main bffd8d90d5dee7f086e1b06baa6d9cfab8cc3b71.
- Admin fetched main/origin/main 23609ac8e0596ff66bf0f19c115cc93d3dab5122.
- Both feature/rbac-v1 worktrees currently in `git merge --no-commit --no-ff origin/main`; merge commit NOT yet created.

## Conflict resolutions so far
- Dynamic DB navigation/router/session method gates retained over legacy role-name routes. New CampusConfigPage registered in view-catalog.
- DataPage combines fixedSection prop (embedded main page) with RBAC route-local cache state and action permissions.
- Dashboard exception links retain dynamic menuPath; promotion filter retains categoryId.
- Removed duplicate CampusDailySeq model and duplicate newOrderWatch method from automatic merge.
- New campus-config/slot/notice controller paths use awaited RBAC campusScope, not retired authorize calls. Registered a new campus-config menu and two independent slot/notice action nodes. Existing saved role/menu grants must not be replayed or expanded automatically.
- Main added campus announcements, servicePhone and noManagerTip; new SQL has NOT yet been applied to isolated databases.

## Verification so far
- Prisma generate passed after duplicate removal.
- API tsc noEmit passed (/tmp/rbac-merge-api-tsc.log).
- Admin vue-tsc/Vite build passed (/tmp/rbac-merge-admin-build.log).
- This is not runtime/system acceptance. Main merge remains unfinished.

## Required next work
1. Adapt CampusConfigPage away from role hq/admin and coarse canSee to per-operation platform/hasPerm; test profile/delivery/salary versus slot/notice permissions and embedded tabs. Inspect newly merged service semantics, caller scope and noManagerTip persistence.
2. Rehearse new migrations in isolated ledger DB; update regression/checks safely. Add real A/B tests for new endpoints, run API full suite and frontend session tests/build. Regenerate inventory (new count expected146) and check registry consistency.
3. Complete merge commits with conflict report after validation, without pushing.
4. Improve Accounts/Roles/Menus/Permissions/Audit UI with existing deep-green style: consistent fields, tables, tree, modal and responsive spacing. frontend-design skill read.
5. Remove synthetic validation navigation from local checks DB only, preserve scripts/evidence. Parent 工作台 is a fallback group, not necessarily DB directory.
6. Browser QA via gstack browse skill (ancestor AGENTS.md), screenshots, regression and final delivery audit.

## Local preview
Prior API port3191 PID29484/session86535 is NOT a watcher and still serves pre-merge code. Vite5191 watches frontend, so preview may currently show newer frontend against older API. Need controlled restart after local DB migration. User's separate3100 service untouched. Persistent browse shell session66356 may still be alive; check before use.

## Evidence preservation follow-up
Prior docs/rbac/evidence/*.log exist on disk but .gitignore excluded log files from checkpoint commit; manifest references them. Explicitly preserve those known-safe synthetic logs (or use tracked text extensions) before final delivery; do not blindly force-add ignored files.

## Continuation: campus permissions, migration and first UI pass

- CampusConfigPage now uses hasPerm/hasPlatformPerm, independently gates profile/salary, delivery, slots, notices and embedded content tabs. A platform read grant cannot enable cross-campus writes from a separate campus write role. Name-only campus picker uses auth/admin/campuses?purpose=filter.
- permmenu exposes platformPerms from server operation-scoped patterns; frontend resets them on logout/failure and includes them in authorizationEpoch signature. New module test covers mixed-scope permissions and scope-only cache invalidation. Session tests now15 scenarios /16TAP including parent, all passed (/tmp/rbac-merge-session.log).
- Delivery noManagerTip persistence was verified from merged service and by real HTTP readback.
- New real A/B HTTP test validates aggregate config, slot and notice create/update/delete, body campus override, foreign IDs, servicePhone defaults and noManagerTip. Missing/foreign slot/notice records now return404 rather than Prisma500. Scope suite16 passes.
- Regression DB received exactly3 main SQL migrations in one transaction after confirming fields/table absent. Upgrade ledger DB normal Prisma deploy applied same3; schema diff empty (/tmp/rbac-merge-migrate.log, /tmp/rbac-merge-schema-diff.log). CHECKS browser DB still NOT migrated; local API still pre-merge.
- API full regression40 suites/286 tests passed (/tmp/rbac-merge-full.log); all146 routes classified. API tsc final follow-up handle79713 (poll); evidence-index generation follows in same shell.
- UI first pass: five RBAC pages use scoped rbac-workspace; shared src/rbac.css aligns fields, filters, tables, badges, dialogs, menu tree, multiple-campus selectors and mobile layout with existing deep-green styling. Menu editor header/search/count improved; permissions directory adds search and empty state. Admin build passes /tmp/rbac-ui-first-build.log. Browser visual acceptance NOT yet performed.

## Next concrete actions
1. Poll79713; inspect platform scope backend metadata and new page refresh/selection races. The current CampusConfig load lacks a request-order check across rapid selectedCampus changes; add before final browser acceptance. UI read/write guards must be tested in browser with readonly and mixed-scope roles.
2. Migrate CHECKS DB only after verifying absent new schema; restart owned3191 server. Avoid resetting user-visible QA fixtures without need.
3. Clean synthetic validation menus in checks DB (review exact records; use RbacService deleteMenu for custom nodes), retain fixture scripts. Ensure no real navigation removed.
4. Use gstack browse live browser to review all five RBAC pages, menus modal, role tree, account grants and new campus-config; inspect screenshots desktop/mobile and fix rendering issues.
5. Finish local merge commits, protect ignored evidence logs explicitly, save new screenshots/report and final acceptance. No push/deploy.

## Final verification, superseding pending items above

- Checks DB migrated and owned API3191 restarted on merged source. Removed four exact custom test menus via API with snapshot.
- Browser discovered Set serialization failure in platformPerms; fixed to array and added HTTP contract test. Full API40/287 passes; API type/build and frontend type/build/session16 pass.
- Permissions directory corrected to actual catalog contract; mobile topbar fixed. Five RBAC screens, dialogs, mixed/read-only campus settings, notice create/delete and business reads verified in browser.
- Both ledger rehearsal databases deploy3 new migrations and diff empty. Evidence and limitations recorded in acceptance.md.
- Local merge commits next; no remote push or production changes.

Local merge commits completed: API257a567, Adminfae594c. Both main ancestry checks passed and worktrees clean before this final documentation commit. No push/deploy.
