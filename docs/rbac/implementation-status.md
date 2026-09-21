# RBAC replication implementation status

Current acceptance checklist: [completion-audit.md](completion-audit.md). Sections below are chronological evidence; later results supersede earlier pending items and process handles.

Updated 2026-09-21. Final status: **local implementation and acceptance complete**; see README.md and completion-audit.md. Historical active/pending notes below are superseded. Confirmed B: roles define capabilities, account-role bindings define one/multiple campuses; only super-admin configures permissions. No commits, pushes, merges or production deployments.

## Implemented

- Super-only menu/role/catalog configuration and account mutations enforced independently of editable permissions.
- Operation-specific platform patterns prevent a platform role from widening unrelated campus permissions. Invalid campus-scoped super bindings are rejected/ignored.
- Guard uses database campus and session version; stale JWT campus cannot mix old scope with new rights. Campus switch/list checks stale sessions.
- Explicit migration flags prevent replaying revoked account grants or empty roles. Startup sync is locked, fails startup on error, and preserves saved menu structure/display and role templates.
- Menu parent/view/cache/display management, registered view/permission catalog, cycle/path/pattern validation, display-only ancestry without inherited permissions, hidden authorized routes retained.
- Frontend dynamic routes and nested sidebar groups, registered components, HTTPS iframe, page cache cleared on authorization changes, stale asynchronous response protection, periodic/focus/navigation permission refresh.
- Role tree search/parent-child linkage/half selection/read-only menu choice; account role rows support multiple campuses and correct super-admin scope.
- Account profile/password/status/grants/audit are atomic. Grant replacement, account deletion and disable share a last-super advisory lock. Role deletion removes menu links inside that lock.
- Product ordinary PATCH checks price and status capabilities separately, including mixed-field payloads.
- Optional ADMIN_SINGLE_SESSION=true invalidates earlier tokens on successful login; default remains multiple sessions. Stale sessions cannot self-change password; frontend exits after successful password change.
- Main compatibility ported without merge: order notifications/new-order-watch, daily receipt sequence, printer formatting/tests, promotion search, official-price propagation, deleted-user 401, picker prices and order details/margins.

## Verification evidence

- API full regression after fixture preparation: 38 suites / 253 tests passed in `/tmp/buchuqin-rbac-seeded-tests-v2.log`. Latest full rerun including single-session: **38 suites / 254 tests passed**, `/tmp/buchuqin-rbac-regression-final.log`.
- Targeted RBAC tests after transaction/status changes: 53 passed, `/tmp/buchuqin-rbac-final-slice-tests.log`.
- API tsc passed after atomic changes; frontend vue-tsc + Vite build passed; latest build `/tmp/buchuqin-rbac-admin-build-final.log`.
- Browser: created custom product menu `/qa-products`, sidebar appears and deep-link reload renders product page. Screenshot `/tmp/buchuqin-rbac-dynamic-menu.png` inspected.
- Browser: selected orders.write leaf; orders and g.ops both half-selected. Saved qa-browser-role.
- Browser: created qa_browser account with the same role bound to qa-a and qa-b using the multi-select. Account creation confirmed in local DB.
- Browser: qa-multi operates A as operations, B as finance; switching to B removes products/menu configuration. Direct `/products` resolves to `/access-denied`. Screenshot `/tmp/buchuqin-rbac-campus-b-denied.png` inspected. Console reports no errors at final denied page.
- These browser checks do not yet prove revoke-in-open-page, half-state reload, hidden/moved menus, iframe, missing-view UX or cached page clearing.

## Isolated local databases

- `buchuqin_rbac_checks_20260921`: schema-only copy of preexisting local test DB (no source rows), new migrations applied manually; synthetic browser/HTTP fixtures. Some earlier tests left orphan custom roles; cleanup order is now fixed. Do not use this DB for migration-chain proof.
- `buchuqin_rbac_regression_20260921`: newly created for full regression, Prisma db push then repository synthetic seed, plus campus-official/campus-hq INSERT fixtures matching their historical migrations. Initial empty-library failures were fixture omissions, not passing evidence. Old session fixtures were updated to supply actual sessionVersion; audit/error expectations updated to atomic API semantics.
- Neither DB is production. Baseline schema + seed is **not** proof of migration chain correctness.

## Historical migration issue (fresh bootstrap and upgrade now rehearsed below)

Fresh `buchuqin_rbac_replica_20260921` fails migrate deploy at historical `20260915120000_restock_shipment`: FK references RestockOrder before creation in `20260917000000_restock_batch`. Failed DB retained. Original local test DB has no migration baseline (P3005) and was not modified. The verified bootstrap/upgrade path is documented in migration-guide.md and the later rehearsal section; historical files remain unchanged.

## Historical remaining work (superseded by completion-audit.md)

1. Endpoint-by-endpoint data-scope review/matrix for lists/details/stats/options/exports/files/printing/bulk/mutations, with valid A/B records and explicit shared-resource classification. Inventory currently still marks scope review pending; super scan only proves handler reachability.
2. Fine-grained frontend buttons/fields: canWrite is still broad in places, price-only role UI, action-specific platform flags and hardcoded links after custom route moves require review.
3. Multi-instance invalidation/read-failure tests, permission refresh race behavior, full browser revoke/relogin/hidden/menu-move/view-cache flow.
4. Migration rehearsal, synthetic per-account before/after comparisons, operator and rollback docs are now delivered below. Keep documentation aligned with remaining endpoint/UI changes.
5. Do not claim completion from regression count: pending core acceptance above is required.

## Historical local handles (latest handles appear at the end)

- API dev server port 3191, session 13829, log `/tmp/buchuqin-rbac-api3191.log`; not watch, needs restart for latest auth/status edits.
- Vite port 5191, session 51527, proxy env VITE_API_PROXY_TARGET=http://127.0.0.1:3191.
- gstack browse persistent PTY session 66356; `B=/Users/douglee/.agents/skills/gstack/browse/dist/browse`, BROWSE_PARENT_PID=0. Use write_stdin commands; short standalone exec kills daemon with process group.
- Browser currently qa-multi in qa-b, `/access-denied`. Synthetic qa-super / qa-multi / qa_browser password Local-Rbac-QA-2026!.
- User's separate server on port3100 is untouched.


## Additional scope and product capability slice

- GET campuses now limits campus-scoped grants to current operation campus, including counts; platform grants retain global listing.
- Global account list, account permission preview and RBAC audit require operation-specific platform grants. Campus bindings cannot globalize those reads. permmenu omits non-executable patterns (super-only or platform-only mismatches).
- Account page mutations use explicit super-admin state; read-only platform accounts no longer fetch super-only role configuration.
- Product detail editing and pricing split in UI; a price-only role can edit prices while other controls are disabled. When ordinary edit and price are both authorized, one PATCH commits both instead of sequential partial saves. State fields are omitted unless authorized and changed.
- Product row/bulk status actions require batch-status capability and use its endpoint; product import/create and upstream refresh have independent gates. Unauthorized category/location option requests are skipped.
- Full regression after scope changes: **38 suites / 255 tests passed**, `/tmp/buchuqin-rbac-scope-full-tests.log`. New real HTTP test covers current-campus counts and campus-granted global reads rejection.
- Frontend build passed `/tmp/buchuqin-rbac-product-ui-build.log`; rerun after final optional-dictionary guard change.
- Browser qa-price: disabled detail/status fields, only price controls writable; saved A product price 500 -> 525, page and DB verified. qa-status: no creation controls, status-only action changed A product on-sale -> off-sale, page and DB verified. B product stayed price=500/on-sale. These fixtures are synthetic local rows.
- API restarted to current scope backend, session **51639**, same port3191/log. Browser currently qa-status, products page. qa-price/qa-status fixtures added to scripts/rbac-browser-fixtures.ts; running fixture script resets qa account sessions.
- Remaining detail audit: product stock PATCH versus inventory adjustment rights, action-specific controls beyond products, global resource field classification, full endpoint scope matrix, migration rehearsal, and remaining browser lifecycle tests.


## Migration rehearsal slice

- Added empty-schema bootstrap preserving every historical migration file/checksum while executing restock_batch before restock_shipment. SQL phase is one transaction; populated schemas refuse. Prisma resolves original files afterward. Package command db:bootstrap defaults to plan-only.
- Fresh local `buchuqin_rbac_migration_20260921`: 51 migrations recorded, status current, final Prisma schema diff empty. Explicit rerun against populated schema refused without changes. Logs bootstrap/refusal/fresh-diff under `/tmp/buchuqin-rbac-*`.
- Existing-version rehearsal `buchuqin_rbac_upgrade_20260921`: original migrations through RBAC V1, synthetic old data, normal deploy of 3 incremental migrations, repeat deploy no pending migrations, schema diff empty.
- Found/fixed audited empty template seeded=false being refilled: seed loop now also respects menusMigrated. verify-rbac-upgrade.ts confirms 5 account mappings across A/B, revoked/empty remain empty and repeated startup unchanged; report docs/rbac/upgrade-rehearsal.json.
- Read-only repeatable pre/post snapshot script added, excludes password hashes and refuses output overwrite. Second replay database `buchuqin_rbac_upgrade_replay_20260921` verifies snapshot compatibility before/after new fields; snapshots `/tmp/buchuqin-rbac-replay-before.json` and `...-after.json`.
- Schema declares three indexes and Product.updatedAt default already present in historical SQL, preventing false drift; no historical migrations edited.
- Added migration-guide.md (bootstrap, upgrade, ledger-failure recovery, safe rollback constraints) and operator-guide.md (B model/configuration/session/reference differences).
- Full API regression after migration guard change: 38 suites / 255 tests passed in `/tmp/buchuqin-rbac-migration-regression.log`; tsc passed.
- Historical direct-from-zero migrate deploy remains unsuitable; documented bootstrap is the verified fresh-install path. No production database was accessed; deployment-specific snapshot audit remains an operator step.

## Staff isolation and sensitive access slice

- Fixed source-campus IDOR in staff PATCH/DELETE: controller supplies current campus unless this operation has a platform-scoped grant; service loads within that scope and writes with the observed source campus. Supplying A as destination no longer permits pulling B staff into A. Platform staff grants retain cross-campus reassignment.
- Real A/B fixture test checks foreign name update, foreign reassignment and deletion all reject without changes, then verifies platform reassignment succeeds. Fixture cleanup includes bills created by the endpoint matrix before staff deletion.
- Sensitive ID-card and cleartext phone reads now fail with 503 when audit persistence fails. Fault-injection HTTP tests verify the sensitive value is absent from the failed response.
- Public image uploads now also enforce current admin account status/sessionVersion; deleted admin tokens reject. Existing non-admin public-upload behavior is unchanged. Private ID-card upload retains its explicit capability check. Synthetic multipart denial tests never call COS.
- ID-card frontend component is pinned to app/idcard (private ACL); removed the invalid recruit folder supplied by its caller. Actual cloud upload has not been exercised; no external object writes occurred.
- Full API regression after staff/upload/ID-card fixes: **38 suites / 257 tests passed**, `/tmp/buchuqin-rbac-isolation-full.log`. After adding phone audit fail-closed behavior: **31 RBAC HTTP integration tests passed**, `/tmp/buchuqin-rbac-sensitive-tests.log`.
- Frontend vue-tsc/Vite build passed `/tmp/buchuqin-rbac-private-upload-build.log`. API tsc and diff whitespace check passed after final phone change.
- Initial targeted staff run had one non-reproduced 401 in the product field-permission test plus cleanup FK failure; cleanup corrected, subsequent targeted and full runs passed. Do not treat that initial failed run as evidence.
- Running API port3191 is not a watcher and still needs a restart before browser validation of this slice. Remaining goal gates: full evidence-backed endpoint scope matrix, product stock field separation, non-product action controls, cache/failure/refresh lifecycle and remaining browser acceptance. Goal remains active.

## Stock/report boundaries and action controls slice

- Product PATCH stock field now requires stocktake capability, and official/foreign target also requires that capability at platform scope. Mixed platform product editing + campus-only inventory role cannot widen stock scope. Campus ordinary edit cannot smuggle stock along with other fields; request rejects before writing.
- Frontend only submits stock if authorized and changed; stock input read-only otherwise. Inventory inbound versus stocktake buttons are independent. Initial product creation semantics remain unchanged.
- Added headquarters daily report to platform-only patterns. Campus-report menu contains this URL, so menu ownership alone formerly allowed a global report query; campus grants now reject and omit that pattern from effective permissions.
- Regenerated **139** route inventory with every route's permission nodes, explicit scope classification and controller/service source pointers. Added reproducible scripts/rbac-endpoint-inventory.ts and docs/rbac/data-scope-matrix.md. Matrix explicitly tracks remaining valid-record/HTTP evidence gaps; inventory generation is not isolation proof.
- DataPage now gates 60 action buttons by their actual API operation (finance confirmation/payment, staff/banner/category/building edits/deletion, coupon issuance, printing, room import, etc). Creation uses independent POST permission. Expanded operation containers so inbound-only/delete-only/print-only roles are not accidentally hidden by incomplete page-level lists.
- Frontend hasPerm now mirrors backend method/path matching (one parameter segment, strict method, trailing slash normalization), rather than only exact string equality. Browser regression of these latest action controls remains pending.
- Full API regression `/tmp/buchuqin-rbac-stock-report-full.log`: 38 suites / 257 tests passed. Following that run, added valid official product fixture for mixed-scope stock denial; targeted HTTP suite passed 31 tests in `/tmp/buchuqin-rbac-stock-mixed-tests.log`.
- API tsc passed. Latest frontend vue-tsc/Vite build `/tmp/buchuqin-rbac-action-build.log`. No commit, push, merge, production action or external printing performed. API port3191 needs restart before latest browser QA.

## Valid-target scope, cache failures and browser lifecycle slice

- Added rbac-scope.integration.spec.ts: real A/B fixtures with campus-A full capabilities (not super) plus B finance. Eight HTTP/PG test groups verify foreign order detail/status/outbound/reprint; printer test/delete before any mocked external call; product edits/stock and mixed batch/featured IDs; building/room parent mismatch; coupon ownership and mixed recipient all-or-nothing validation; banner/promotion/product ownership; sensitive recruitment/user reads and finance writes. Positive same-campus controls prove authorization/fixture validity.
- Global category names remain shared, but category productCount now filters to the current campus unless the categories operation itself is platform-scoped. Added HTTP count assertion (two campuses, A sees 1).
- Two separately instantiated RBAC services verify warmed caches observe menu removal and role disable through RbacState version changes. DB state read failure rejects; missing global state now 503 instead of silently treating version as zero. HTTP warmed-cache failure/recovery verified.
- Full API regression: **39 suites / 265 tests passed**, `/tmp/buchuqin-rbac-valid-scope-full.log`; API tsc passed. New valid-target suite passed 8/8 in `/tmp/buchuqin-rbac-valid-scope-tests.log`. Initial featured assertion corrected to compare actual fixture default (0), not assumed null; all subsequent runs passed.
- Browser (browse skill): fresh login as qa-super, reopen persisted qa-browser-role. DOM confirms orders.write checked, orders and g.ops indeterminate. Visual inspection caught missing half-state CSS and a wrapped vertical menu label. Added visible minus treatment and wrapped permission metadata onto its own row. Final cropped evidence `/tmp/buchuqin-rbac-role-half-visible.png` viewed.
- Browser menu edit: renamed local /qa-products menu to 验收移动入口, moved 仓储中心 -> 运营中心; live sidebar reflects both. Then hid it; sidebar link absent while direct #/qa-products still renders 商品管理. Synthetic local menu remains moved/hidden as the acceptance fixture.
- Browser cache: typed cache-probe-789 into #/qa-products search, navigated to dashboard, returned by hash navigation; DOM input retains exact value. DataPage now snapshots its own route and only consumes updates for its own path, preventing deactivated cached pages following another page's global route. Cache-off and authorization-cache clearing beyond observed revoke still need explicit probes.
- Browser revoke while qa-price product detail open: super-admin REST API cleared qa-price-only menuCodes; same browser old token immediately received 403 from GET products. After periodic refresh sidebar and drawer disappeared and route became /access-denied. Screenshot `/tmp/buchuqin-rbac-revoked-page.png` viewed. Revocation was performed through authenticated super API, not a second browser session. Original role menuCodes restored afterward through same API.
- Frontend build after route-local state and half-checkbox fixes passed `/tmp/buchuqin-rbac-cache-build.log`. API restarted with latest backend: **session85025**, port3191, same log path. Vite session51527 port5191; persistent browse shell66356.
- Remaining hard gates include residual resource/nested-path tests, explicit new-campus range behavior, frontend non-product action browser probes, cache-off/iframe/missing-component evidence, config-refresh race review, and requirement-by-requirement completion audit. No commit/push/merge/production deployment. Goal remains active.

## Remaining nested targets, new-campus semantics and frame/cache browser slice

- Extended valid-target HTTP suite to **10 tests**. Real B storage locations reject edit/delete; foreign commission rule ID and nested building reject; dispatch checks foreign staff, foreign building and foreign invitation independently, with positive A invitation creation. Foreign room template rejects while own template downloads.
- New-campus test warms membership lookup, creates C after A/B grants exist, verifies selectable campus list remains A/B and C switch is 403. Only after explicit platform grant does global campus listing include C and a scoped user query for C succeed.
- Removed known-campus 15s cache: campus creation does not bump RbacState, so a cached membership set could incorrectly reject a new campus on another instance. Membership now reads current DB; effective authorization cache still uses RbacState/sessionVersion.
- Full API: **39 suites / 267 tests passed**, `/tmp/buchuqin-rbac-nested-scope-full.log`. Targeted `/tmp/buchuqin-rbac-nested-scope-tests.log` 10/10, API tsc passed. Inventory regenerated (139 routes).
- Added guarded synthetic browser fixture script `scripts/rbac-browser-edge-fixtures.ts`: qa-edge account, HTTPS frame, cache-off page and simulated historically removed component. Missing component is injected in isolated DB after valid menu creation to model catalogue removal; normal creation API still rejects unknown components.
- Browser qa-edge: HTTPS example.com actually rendered inside sandboxed/no-referrer iframe; screenshot `/tmp/buchuqin-rbac-iframe.png` viewed. FramePage captures its route URL/title so deactivated cached frames do not follow unrelated route metadata.
- Browser qa-edge: missing historical component shows explicit 页面尚未配置 and recovery navigation; screenshot `/tmp/buchuqin-rbac-missing-component.png` viewed.
- Browser cache-off: input cache-off-probe confirmed in DOM, navigate to frame, back to /qa-cache-off; DOM input resets to empty. This contrasts previous keepAlive=true probe retaining cache-probe-789. No full-page reload used in the comparison.
- Frontend vue-tsc/Vite build passed `/tmp/buchuqin-rbac-frame-build.log`. Latest API membership-cache change is tested but running API85025 does not watch files; restart before any browser probe that needs that change. Browser currently qa-edge at /qa-cache-off, shell66356.
- Remaining work is now concentrated on final requirement audit: residual shared-field/audit/file scope review, restock receipt/nested targets, non-product button browser controls, and async permission response race/lifecycle evidence. Do not mark goal complete based only on test counts. No commits, pushes, merges or production deployments.


## Async session ordering and restock aggregate isolation slice

- Fixed a real frontend race: a delayed 401 from account A could clear a newly established account B session. JSON requests, public/private image uploads, room imports and binary downloads now capture token + session generation before asynchronous work and reject stale responses before any logout or data delivery. JSON/body/blob decoding and image compression also check after awaiting. Login/switch responses cannot overwrite a newer session; latest authentication attempt wins. loadRbac captures generation before its dynamic import.
- Added frontend `pnpm run test:rbac-session`: bundles actual api.ts/session.ts using the installed Vite esbuild dependency, runs Node tests with controlled deferred fetches. **13 scenarios passed** (14 TAP tests including the parent): four old-401 transports, stale success after same-token campus change, delayed JSON body, current 401, logout while login pending, competing logins, old campus switch, out-of-order revocation refresh, logout during permissions refresh, and strict method/segment matching. No server or external services used by this runner.
- Added real HTTP/PG restock fixtures with an official product, batch, global purchase, and separate A/B shipped orders. Own detail/shipment/receipt succeed; foreign detail/shipment/receipt reject, foreign audit/ship and purchase detail reject, forged query/body campus cannot redirect, invalid nested campus product cannot replace order lines. Successful A receipt creates stock=2 in A, no B stock is created and B shipment remains unreceived.
- Fixed a cross-scope field leak found during that review: campus batch detail had filtered orders but still returned global purchaseReceivedTotal and grossEstimate. These fields and the global purchase query now require platform scope of the batch-detail operation; campus sees only its own order amounts. Frontend types mark absent aggregates optional and hides those rows. Existing platform purchase regression still verifies aggregate calculation.
- Explicit platform role positive HTTP check for reports/hq-daily now passes. Valid-target scope suite is **11 tests**; targeted scope + purchase run **16 passed**, `/tmp/buchuqin-rbac-restock-scope-tests.log`.
- Latest full API regression: **39 suites / 268 tests passed**, `/tmp/buchuqin-rbac-session-restock-full.log`; API tsc passed (`/tmp/buchuqin-rbac-session-restock-tsc.log` empty). Frontend vue-tsc/Vite build passed `/tmp/buchuqin-rbac-session-restock-build.log`. Both worktrees pass git diff --check. Inventory regenerated for current service lines.
- Running API port3191/session85025 is still the prior compiled process; restart before browser verification of newest batch aggregate/membership behavior. Vite HMR includes current frontend. Browser remains qa-edge/cache-off. No production, commit, push, merge, cloud object or external printer operation occurred.
- Remaining final gates: audit/shared-field/file capability classification (frontend uses app/banner-detail and app/wheel but FilesController whitelist currently lacks both; resolve alongside file permission policy), non-product action browser probes, and requirement-by-requirement completion audit with current evidence. Goal remains active; this slice does not claim remaining checks passed.


## Public media capabilities, action browser checks and audit redaction slice

- FilesController now requires relevant business write capability for each public admin upload folder. Banner detail and wheel folders used by the frontend are now accepted. Generic uploads requires any public media write capability; ID-card remains independent/private. Non-admin app public uploads retain their existing behavior.
- Added files.controller.spec.ts with a mocked COS SDK: seven folder-specific allowed/denied checks plus private ACL, price-only denial and app-user compatibility. This tests actual controller + RbacService permission/session matching, and performs no cloud writes. HTTP finance-only denial covers all eight folders. Targeted **41 tests passed**, `/tmp/buchuqin-rbac-file-capabilities-tests.log`; final full run below includes corrected PATCH price-only test.
- Added isolated `scripts/rbac-browser-action-fixtures.ts`: qa-confirm, qa-pay, qa-inbound and one synthetic bill. Browser confirmed only-confirm account can confirm and has no payment button; only-pay account can mark paid and has no confirmation button. Screenshots `/tmp/buchuqin-rbac-confirm-only.png`, `/tmp/buchuqin-rbac-pay-only.png` viewed; DB bill qa-action-staff=paid.
- Browser inbound-only account exposed two dependency bugs: inventory picker fetched products, and campus filter fetched campus management. Inventory now uses inventory API for candidates. Added `GET /auth/admin/campuses?purpose=filter`, returning only id/name/shortName/current from the account's allowed campus set (platform all active). Default switch-list and actual switch authorization are unchanged. Same-campus names do not grant management data. HTTP tests prove fixed-campus set stays fixed and platform includes new C; exact response keys asserted. Original platform no-switch regression passes.
- ProductPickerField now skips category dictionary calls without GET categories permission, matching the main product form. Inventory default option says 当前校区 to reflect read behavior. Platform writes still require explicit selected target warehouse, as existing backend policy requires.
- Browser qa-inbound selected A and added 1 to synthetic product: A stock10 ->11, B remains10, no stocktake button. `/tmp/buchuqin-rbac-inbound-only.png` viewed; final action has no console errors. Initial attempt without selecting a warehouse correctly returned400, so it is not counted as success. Current final screenshot replaces that failed-attempt screenshot.
- General recruitment audit snapshots formerly included staffRemark, bypassing the separate note permission. New snapshots only record hasStaffRemark; general audit reads additionally redact historical staffRemark/idCardImages and mask idCardNo. Added assertions against new write snapshots and a historical raw snapshot. Targeted RBAC HTTP **31 tests passed**, `/tmp/buchuqin-rbac-audit-redaction-tests.log`.
- Before final audit-redaction change, full API **40 suites /278 tests passed**, `/tmp/buchuqin-rbac-action-final-tests.log`; API tsc passed. Frontend final build passed `/tmp/buchuqin-rbac-action-final-build.log`; session runner13 scenarios passed `/tmp/buchuqin-rbac-action-session-tests.log` (14 TAP tests includes parent). Final backend after redaction also passed **40 suites /278 tests**, `/tmp/buchuqin-rbac-audit-final-full.log`; tsc passed with empty `/tmp/buchuqin-rbac-audit-final-tsc.log`. Both worktrees pass diff whitespace checks; 139-route inventory regenerated.
- Restarted only owned local API PID37629; current port3191 process **PID86302/session2535** includes file policy, campus options and prior restock changes, but not the newest audit-read redaction. Vite session51527, browse shell66356 currently qa-inbound/inventory with A selected. User port3100 untouched.
- Remaining completion gate: requirement-by-requirement audit of current code/artifacts/evidence, refresh stale checklist/inventory verification entries, and resolve anything that audit shows incomplete. No commit, push, merge, production deploy, actual cloud upload or external printing. Goal remains active.


## Numbered goal audit and dedicated-page controls

- Added completion-audit.md matching all A1–E8 requirements to current implementation/evidence and explicit residual checks. Goal remains active; latest tests alone are not completion proof.
- Audit found independent pages missed by earlier DataPage gate work: PurchasePage's canManage was unused; FeaturedPage always exposed edit controls; RestockPage grouped actions under batch creation. Fixed purchase detail/receive/close/reopen individually, featured readonly loading and edit controls, restock batch edit/close/audit/ship/purchase generation/order save-submit-withdraw/receipt gates. Platform read-only/audit-only management views no longer depend on create-batch permission.
- Internal Dashboard, Roles and Restock links now resolve authorized registered menu paths via menuPath, including hidden authorized pages and moved routes. Account campus-name options use self filter endpoint instead of requiring campus management permission.
- Frontend build passed `/tmp/buchuqin-rbac-dedicated-pages-build.log`. Session tests now **14 scenarios /15 TAP tests including parent**, `/tmp/buchuqin-rbac-link-session-tests.log`, including moved hidden route resolution, display-only ancestor exclusion, and logout removal.
- Guarded synthetic supply fixture added: qa-supply-read with read-only purchase/restock/featured; real open and closed purchases and a batch. Browser: open purchase has only close-drawer button; closed purchase has no reopen; batch has no create/edit/close/generate buttons. Screenshots `/tmp/buchuqin-rbac-purchase-readonly.png`, `/tmp/buchuqin-rbac-restock-readonly.png` viewed.
- Featured readonly page loads actual selected qa-a product without GET products permission, and shows no save/picker/sort/remove controls. `/tmp/buchuqin-rbac-featured-readonly.png` viewed after correcting fixture featured=true (featuredSort alone does not select). Initial empty state is not the row-action proof. Fixture sets qa-a product on-sale+featured; this is local synthetic data only.
- API code unchanged this slice, prior latest full 40 suites/278 and tsc remains applicable. API session2535/PID86302 still lacks most recent audit-redaction change; restart needed before runtime verification of that change. Browser shell66356 now qa-supply-read on /featured. No commit/push/merge/production action.

## Fixed-main compatibility and positive supply actions

- Fixed API main a152b8dd09e1ac1db452aedb9c231e8c2fbc2d1e and admin main 46cabc0572cae8d62a963002e7e2e3ce181b166b; see main-compatibility.md. Ported asSeckill cart/channel behavior, promotion category filter and exception reason-dialog workflow while preserving RBAC gates.
- Full API **40 suites / 281 tests passed**, /tmp/buchuqin-rbac-main-compat-full.log; API tsc and frontend build passed in corresponding main-compat logs. Last follow-up API edit only aligns a comment with main.
- Migration and upgrade rehearsal DBs now each have **52 finished, 0 unfinished** ledger rows; both final schema diffs empty. New cart column applied to isolated regression/checks fixtures as well.
- Browser qa-supply-actions has only batch PATCH, purchase close and featured PUT write capabilities (plus page reads). Edited qa-read-batch to 单项编辑权限验收批次, closed qa-read-open, removed/saved the only featured A product. DB recheck confirms name, closedAt and featured=false. No create-batch, receive or reopen buttons appeared. Inspected screenshots /tmp/buchuqin-rbac-restock-edit-only.png, ...-purchase-close-only.png, ...-featured-save-only.png.
- Browser qa-super searched the menu list, opened 验收单项供应链动作, filtered permission catalogue by /admin/purchase, added GET detail while retaining the three other selected patterns, saved and reopened. DOM/DB confirm four patterns persist, including selections outside the current search. Screenshot /tmp/buchuqin-rbac-permission-picker.png inspected. One ambiguous text ref was rejected by browse; selection of detail and save succeeded, not falsely counted as selecting GET list.
- Live API current session2103/PID7083, port3191; Vite session51527 port5191; browser session66356 currently qa-super at rbac-menus edit dialog. All browser rows synthetic. User's 3100 server untouched.
- Remaining completion gates: endpoint-to-test evidence index and final shared-field classification/document consistency. Goal remains active; no commit/push/merge/production deployment.

## Endpoint evidence index follow-up

- Added scripts/rbac-evidence-index.ts, regenerated source inventory and generated endpoint-evidence.json. 139 routes: 77 have directly identifiable HTTP test calls, 28 only domain-service calls, 34 no static test-call match. Extractor does not count dynamic super sweep; helper/alias calls may be undercounted. This is evidence navigation, not a coverage percentage or proof of every route's isolation.
- data-scope-matrix.md records the exact limits and remaining source-only review. Also explicitly records existing products costPrice output versus frontend hiding; final classification review remains open. No fabricated security conclusion.
- git diff --check passed. New scripts executed successfully. Goal remains active until remaining route review, field classification and final document audit close.

## Residual route tests and permission-audit leakage fix

- Added 4 valid A/B HTTP test groups covering list/read/watch, delivery/building mutation, wheel nested coupon, audit/counts/create/transition/printer-bind. Scope suite now15 tests. All external printer methods remain mocked; no cloud writes.
- New audit assertion initially failed: generic business audit exposed rbac.grant.set snapshots with B grants despite A context. Fixed AdminService.auditLogs to exclude rbac.* entirely; separately authorized platform RBAC audit retains those records. Test uses real A/B binding and checks foreign content absent, not merely status200.
- Latest full regression **40 suites /285 tests passed** in /tmp/buchuqin-rbac-audit-isolation-full.log. API tsc passed /tmp/buchuqin-rbac-audit-isolation-tsc.log. Earlier residual-full 284 and failed intermediate audit run are historical, not final evidence.
- Inventory now94 directly identifiable HTTP routes,28 domain-only,17 not statically matched. residual-route-review.md accounts for all17 via actual loop/browser/source evidence and explicitly distinguishes their strength. Index excludes dynamic super sweep.
- Kept existing shared product cost and own-order margin contract; documented no new independent cost-read capability. Frontend hiding is not a confidentiality claim.
- Live API3191 has NOT restarted after latest audit-filter change; HTTP regression booted current source independently. Browser preview needs a controlled restart before final handoff. No submit/push/merge/deploy.
- Remaining: final document consistency and full goal acceptance audit against current files and evidence. Goal active.

## Final local handoff

- Final API session86535/PID29484 on3191 successfully started current source. Live login/me and business/RBAC audit smoke: super=true, business50rows with no rbac.* snapshots, separate RBAC100rows retained.
- Handoff frontend session test rerun passed14scenarios (15TAP including parent). Latest full API40/285 and tsc passed. No frontend code changed since passing main-compat build.
- Preserved final logs and16 browser screenshots under evidence/, with SHA256 manifest. README is current handoff entry; completion-audit.md closes A1—E8. Previous stage-specific pending notes are historical.
- Local scope completed; no production actions or git commit/push/merge.
