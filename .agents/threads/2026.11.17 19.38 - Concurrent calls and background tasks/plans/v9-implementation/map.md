# Argsbarg v9 implementation

## Overview

Argsbarg v9 keeps a small CLI simple while letting app authors declare CLI, REST, JSON-RPC and MCP independently. It preserves one package and one executable per app, with local mirrors rather than generated cross-protocol endpoints.

<!-- docs:begin -->
Workers follow [rules.md](rules.md), [architecture.md](architecture.md) (rev 2) and [conventions.md](conventions.md) (rev 1); reread a doc when its rev changes.
<!-- docs:end -->

## Goal

Replace the 8.x CLI-to-wire adapter coupling with native surface bindings and shared guarded invocation. Discovery matches registered operations; streams and concurrent callers stay isolated. Modern MCP uses one registry and a selected stdio or HTTP transport, with app-owned tasks and authorization policy. No legacy migration path.

The [implementation contract](architecture.md) separates firm behavior from open APIs. [Verification](conventions.md) records local evidence goals and checks that cannot be claimed under current authority.

## Roles

- **lead** (Copilot chat configuration): owns Overview/Goal, permissions, dispatch and acceptance.

<!-- roles:begin -->
- **refiner** (`mai-code-2.medium`): independently checks and corrects a brief
- **decider** (`mai-code-2.high`): makes a bounded technical decision, or refers it to the user
- **brief-author** (`mai-code-2.medium`): researches a task and writes its brief or spike answer
- **scribe** (`mai-code-2.medium`): keeps thread bookkeeping current
- **helper** (`mai-code-2.medium`): supports the lead with bookkeeping
- **executor** (`mai-code-2.medium`): implements a contract and runs its checks
- **reviewer** (`mai-code-2.medium`): independently reviews results at the acceptance gate
<!-- roles:end -->

## Status

Argsbarg v9 is complete and released. D90 guards/caller seeding, D91 child composition,
native surfaces, local mirrors/relays, public APIs, templates, skills, packaging and the
critical-only Biome policy are accepted.

- Accepted: 134 tasks are accepted. Task 39 is dropped and superseded by task 39.1; task 78
  is dropped and superseded by the narrower 116–121 review split. No task remains active.
- Released: commit `89fdf1d`, tag and GitHub release `v9.0.0`, npm `argsbarg@9.0.0`.
- Validation: 346/346 core tests, 32/32 template tests, all four create checks, `just build`,
  package dry-run with 451 files, 110/110 public-symbol parity, stale-artifact scan and
  `git diff --check` passed.
- Next: none. Future work, including deferred MCP Tasks/OAuth/host verification, requires a
  new plan rather than reopening this completed graph.
- Hard limits/cleanup: the release commit excluded `.agents/**`. Remaining `.agents/` task,
  bus and planning artifacts are preserved as durable audit history.

### Subagents

<!-- agents:begin -->
Agents: 🔄 running · ✅ returned · 🛑 blocked · ⏸️ idle or released · 🚫 dropped · ❓ undecided

1. ✅ [1](tasks/1.md) · 22:54 · 2m · refiner — about to verify task 1 handoff against contract rev 2 and send the pointer
2. ✅ [2](tasks/2.md) · 22:54 · 2m · decider — render-map --check passed; about to send corrected task 2 review pointer
3. ✅ [3](tasks/3.md) · 22:54 · 7m · brief-author — task 3 front matter renders; renderer --check remains exit 1 only for unrelated task 2 evidence formatting
4. ✅ [4](tasks/4.md) · 22:59 · 0m · scribe — task 4 is in review after a clean final task-update render and --check; about to send the required one-line lead pointer
5. ✅ [5](tasks/5.md) · 23:04 · 10m · decider — about to rerun final render check after the last owned Brief refinement
6. ✅ [5.1](tasks/5.1.md) · 23:09 · 0m · helper — about to send the corrected task pointer to lead and config-api-decider
7. ✅ [5.2](tasks/5.2.md) · 23:09 · 0m · helper — render-map --check passed; about to send corrected task pointer to lead and config-api-decider
8. ✅ [5.3](tasks/5.3.md) · 23:09 · 1m · helper — about to send the corrected task pointer after the official check passed
9. ✅ [6](tasks/6.md) · 23:21 · 0m · refiner — about to reread contract rev 1 and send the final task pointer
10. ✅ [7](tasks/7.md) · 01:12 · 20m · executor — review handoff remains waiting; no reviewer inbox was registered after repeated 4-minute rounds; returning completed pointer without claimi…
11. ✅ [8](tasks/8.md) · 01:21 · 11m · reviewer — fix 8.1 and re-review 8.2 are written and sanitized; about to post the changes-needed verdict and task 8 pointer
12. ✅ [8.1](tasks/8.1.md) · 01:29 · 0m · executor — handoff sent; one 240-second follow-up wait timed out without task 8.2 mail; retaining completed review evidence and returning pointer
13. ✅ [8.2](tasks/8.2.md) · 01:32 · 0m · reviewer — approval recorded in task 8.2; about to notify executor and send lead pointer
14. ✅ [9](tasks/9.md) · 01:38 · 0m · scribe — about to perform the post-Notes official render and final --check
15. ✅ [10](tasks/10.md) · 01:45 · 1m · brief-author — brief complete; about to send review pointer to lead with refined-gate retained
16. ✅ [11](tasks/11.md) · 01:46 · 0m · brief-author — about to send the sanitized review pointer for completed task 11 brief
17. ✅ [12](tasks/12.md) · 01:51 · 0m · refiner — final contract reread and render --check after marking task 12 review
18. ✅ [13](tasks/13.md) · 01:52 · 0m · refiner — verification complete; about to send sanitized task pointer on channel @13
19. ✅ [14](tasks/14.md) · 01:56 · 23m · executor — no log rows yet
20. ✅ [16](tasks/16.md) · 02:03 · 0m · decider — about to perform the final owned-path and cleanup verification, then send the one-line task-16 pointer
21. ✅ [15](tasks/15.md) · 02:05 · 14m · reviewer — review artifacts complete; about to post changes-needed verdict and lead pointer
22. ✅ [15.1](tasks/15.1.md) · 02:05 · 10m · executor — about to rerun official render check after final task evidence edit
23. ✅ [15.2](tasks/15.2.md) · 02:19 · 0m · reviewer — approved: task 15.1 closes task 15 evidence findings; sending verdict and lead pointer
24. ✅ [17](tasks/17.md) · 02:26 · 18m · executor — renderer correction complete; official render-map --check exited 0 and no source or test files were edited
25. ✅ [18](tasks/18.md) · 02:35 · 9m · reviewer — removing an accidentally addressed empty bus database outside the thread, then setting idle on the correct bus
26. ✅ [18.2](tasks/18.2.md) · 02:44 · 0m · reviewer — Approval recorded in task 18.2; all three scoped findings have concrete file and final-bus evidence. Sending verdict pointer to lead.
27. ✅ [19](tasks/19.md) · 02:50 · 0m · scribe — Send sanitized task 19 review pointer to @19 and lead; render --check passed, with no promotions, contract changes, or watchers.
28. ✅ [20](tasks/20.md) · 02:57 · 1m · brief-author — Task 20 Brief complete: exact CLI binder/encoder/factory recipe, files, errors, cleanup, handoffs and write conflicts recorded. DP-20 publi…
29. ✅ [22](tasks/22.md) · 02:57 · 1m · brief-author — no log rows yet
30. ✅ [23](tasks/23.md) · 02:58 · 0m · brief-author — brief complete; about to send sanitized task 23 review pointer to lead
31. ✅ [24](tasks/24.md) · 02:58 · 0m · brief-author — brief complete; render-map --check and git diff --check passed; sending review pointer with DP-24 gate
32. ✅ [21](tasks/21.md) · 02:59 · 0m · brief-author — Task 21 brief is in review; sending artifact pointer to lead
33. ✅ [28](tasks/28.md) · 03:07 · 0m · refiner — about to send final task pointer to @28 after final render exit 0
34. ✅ [29](tasks/29.md) · 03:07 · 0m · refiner — refinement complete; about to render-check task 24 and task 29 ownership boundaries
35. ✅ [25](tasks/25.md) · 03:08 · 1m · refiner — refinement complete; sending task 25 review pointer to @25 and lead
36. ✅ [26](tasks/26.md) · 03:08 · 1m · refiner — verification complete; send refined task 21 pointer on @26
37. ✅ [27](tasks/27.md) · 03:08 · 1m · refiner — no log rows yet
38. ✅ [33](tasks/33.md) · 03:18 · 0m · decider — running final task render and scope checks before handoff
39. ✅ [31](tasks/31.md) · 03:21 · 1m · decider — about to verify DP-21 artifacts, cleanup and render
40. ✅ [32](tasks/32.md) · 03:21 · 1m · decider — Final verification passed: render-map --check exited 0; owned Markdown has no trailing whitespace; task 22 contains concrete accepted/negat…
41. ✅ [34](tasks/34.md) · 03:22 · 0m · decider — DP-24 decided; strict fixture and render check passed, cleanup complete, task 34 and task 24 Brief ready for review
42. ✅ [30](tasks/30.md) · 03:24 · 0m · decider — sending the completed decided DP-20 artifact pointer to task 30 and lead
43. ✅ [37](tasks/37.md) · 04:10 · 46m · executor — running final exact acceptance checks after the task evidence edit
44. ✅ [41](tasks/41.md) · 04:13 · 29m · executor — negotiation: 1 accept; 2 accept; 3 accept; 4 accept; bounded review-fix task requested
45. ✅ [39.1](tasks/39.1.md) · 04:26 · 21m · executor — Evidence pass complete after final owned edit: exact Biome exit 0, tsc exit 0, node test exit 0 with 9/9; ownership retry exit 0 and only f…
46. ✅ [42](tasks/42.md) · 04:26 · 16m · reviewer — no log rows yet
47. ✅ [44](tasks/44.md) · 04:42 · 0m · reviewer — no log rows yet
48. ✅ [40.2](tasks/40.2.md) · 04:46 · 0m · reviewer — approval recorded; send closure pointer to task channel and lead
49. ✅ [38.1](tasks/38.1.md) · 04:47 · 6m · executor — final command node_modules/.bin/biome check src/http/routes.ts src/http/bind.ts src/http/dispatch.ts src/http/encode.ts src/http/openapi.ts…
50. ✅ [40.1](tasks/40.1.md) · 04:47 · 0m · executor — git status --short -- src/json-rpc/declaration.ts src/json-rpc/catalog.ts src/json-rpc/dispatch.ts src/json-rpc/openrpc.ts src/json-rpc/rpc…
51. ✅ [38.2](tasks/38.2.md) · 04:56 · 0m · reviewer — final literal Biome command and exit 0 found in task 38.1 row 543; about to record approval in task 38.2
52. ✅ [45](tasks/45.md) · 05:17 · 0m · scribe — official render --check passed; about to mark task 45 review and send lead pointer
53. ✅ [49](tasks/49.md) · 05:24 · 0m · brief-author — about to write task 49 Brief from accepted DP-22 and DP-24 evidence
54. ✅ [50](tasks/50.md) · 05:24 · 1m · brief-author — Validation: render-map --check exited 0; task-50-owned git diff --check exited 0. No tests, sockets, network, hosts, thread-memory, install…
55. ✅ [51](tasks/51.md) · 05:24 · 1m · refiner — correcting the validation selector count and recording the owned-file diff check
56. ✅ [48](tasks/48.md) · 05:28 · 0m · brief-author — no log rows yet
57. ✅ [46](tasks/46.md) · 05:35 · 22m · executor — Lead verified task46 handoff: Biome/typecheck exit 0, listener 16/16, HTTP integration 36/36, owned diff check exit 0; worker bus script un…
58. ✅ [52](tasks/52.md) · 05:35 · 0m · refiner — rechecking final rendered artifacts after evidence-note edit
59. ✅ [53](tasks/53.md) · 05:36 · 0m · refiner — no log rows yet
60. ✅ [54](tasks/54.md) · 05:38 · 0m · refiner — no log rows yet
61. ✅ [47](tasks/47.md) · 05:46 · 11m · reviewer — writing verdict: changes needed; created scoped fix task 55 and re-review task 56
62. ✅ [55](tasks/55.md) · 05:49 · 5m · executor — no log rows yet
63. ✅ [56](tasks/56.md) · 05:56 · 0m · reviewer — verdict: findings 1-2 closed; finding 3 remains because task 55 bus has no exact final command rows; render check exit 0
64. ✅ [59](tasks/59.md) · 06:04 · 43m · executor — 2026-11-20: completed the bounded HTTP-mount slice and retained the implementation for independent task 60 review.
65. ✅ [57](tasks/57.md) · 06:07 · 26m · executor — about to update task 57 evidence with caller-supplied post-task61 full-tree typecheck exit 0; no source work
66. ✅ [61](tasks/61.md) · 06:11 · 36m · executor — no log rows yet
67. ✅ [58](tasks/58.md) · 06:32 · 0m · reviewer — no log rows yet
68. ✅ [63](tasks/63.md) · 06:33 · 36m · executor — Final evidence pointer retained by task 65: [task 65](65.md#notes). Exact rerun transcript records
69. ✅ [62](tasks/62.md) · 06:46 · 0m · reviewer — no log rows yet
70. ✅ [60](tasks/60.md) · 06:47 · 0m · reviewer — no log rows yet
71. ✅ [65](tasks/65.md) · 06:59 · 0m · executor — MCP HTTP evidence rerun on unchanged owned files: Biome exit0; tsc --noEmit exit0; node test http+registry+protocol+dispatcher exit0, 18/18…
72. ✅ [66](tasks/66.md) · 06:59 · 9m · reviewer — task 66 approval written; about to post verdict and lead pointer
73. ✅ [67](tasks/67.md) · time unknown · executor — no log rows yet
74. ✅ [69](tasks/69.md) · time unknown · executor — no log rows yet
75. ✅ [71](tasks/71.md) · time unknown · executor — no log rows yet
<!-- agents:end -->

## Tasks

| Workstream | Prerequisite | Scope and handoff |
| --- | --- | --- |
| Invocation core | Shared seam decision | Typed declarations, validated input, guards, caller context and isolation. Publish the shared contract to each adapter. |
| Service listener | Request/response boundary | Shared HTTP listener, Web streams, binds and graceful shutdown. REST, JSON-RPC and MCP plug in independently. |
| CLI and factory | Shared seam; registered adapters to finish integration | Preserve CLI parser/help behavior; add local mirrors, `--relay`, service launch and public entry point. One owner for shared factory and export files. |
| REST | Shared seam; listener for network wiring | Direct method/path/query/body binding and one dispatch/discovery registry; OpenAPI; streaming result support. |
| JSON-RPC | Shared seam; listener for network wiring | Independent method catalog, JSON-RPC envelopes and batches; OpenRPC and mirror adapter. No generated methods. |
| MCP | Shared seam; listener only for HTTP | Split protocol/dispatcher, stdio framing, HTTP adapter, OAuth helper, and app-owned Tasks. Stage native dispatch before auth/task integration. |
| Child mounts | Registry contracts and guard composition | Namespace declarations, scope inputs, preserve exposure and guards. Reject collisions; no runtime gateway loader. |
| Config helper | Independent | Platform defaults and explicit override; API export handed to factory owner. |
| Distribution and docs | Public launch and declaration contracts | Update templates, packaging, skills and docs; remove retired built-ins and routes. Integrate and validate locally, without a release wave. |

### Parallel dispatch

| Unblock on | Release independently |
| --- | --- |
| Scoped recall and plan review | Refine the config helper, HTTP listener lifecycle/streaming, and shared invocation contract independently. The config helper does not wait for service or factory work. |
| Invocation contract, not its implementation | Start separate briefs for the runner/context, CLI binding, REST binding, JSON-RPC envelopes and method binding, and the MCP registry/dispatcher. Where the accepted contract supports fixture-driven work, dispatch the isolated implementations without waiting for the factory. |
| REST route catalog | Generate OpenAPI independently of HTTP listener integration. |
| JSON-RPC method catalog | Generate OpenRPC independently of request dispatch and listener integration. |
| MCP framing and dispatcher boundary | Develop stdio framing and Streamable HTTP adaptation as separate slices. The stdio slice does not wait for the listener, OAuth, or Tasks. |
| MCP HTTP auth and Tasks callback contracts | Develop the HTTP OAuth helper and task-provider support independently of one another. Wire them into the dispatcher after both handoffs. |
| Each surface's native call contract | Build each local mirror and relay client against its own fixture. Relay work does not wait for a live server or another surface's client. |
| Registry and guard composition contracts | Start child namespaces/scoped inputs without waiting for packaging, relay clients, or a full app launch. |
| Public declaration and launch names | Update CLI/API examples, agent-plugin/bundle templates, and public docs independently, with explicit file ownership. Test them against the integrated executable once available. |

Use the next free slot for the highest-priority ready slice; don't wait for an entire wave. Give each slice its own source and test ownership. One integration owner wires the factory, root exports and shared registrations; adapter owners hand off interfaces and tests rather than editing those files. Serialize only conflicting writes and checks that mutate shared build outputs. Split work further when its acceptance can be checked independently, not merely to add workers. Keep unsupported `/mcp-rpc`, legacy compatibility, and live host smoke tests out of scope.

<!-- tasks:begin -->
Progress: ⬜ ready/queued · 🛑 blocked · 🔄 running/review/changes · ✅ accepted · ⏸️ paused · 🚫 dropped · ❓ undecided

- ✅ [1. Refine plan boundaries and dependencies](tasks/1.md): Contract rev 2 refined from the settled seed, workspace baseline and current source seams; dependency and ownership findings are ready for lead acceptance.
- ✅ [2. Decide the shared invocation seam](tasks/2.md): D2 accepts one typed native-binding runner seam with ordered guard locals and transport-owned outcomes.
- ✅ [3. Brief the config directory helper](tasks/3.md): Revised from local source evidence; API and Windows missing-default fallback await lead/decider acceptance.
- ✅ [5. Decide config directory API](tasks/5.md) `[3]`: D3 settles the config-directory API, internal selector seam and fail-closed path/error policy; task 3 Brief is ready for independent refinement.
- ✅ [6. Refine config directory brief](tasks/6.md) `[5]`: Refined task 3 Brief is deterministic for implementation, with exact D3 behavior, owned files, assertions and commands; no consequential choices remain.
- ✅ [7. Implement config directory helper leaf](tasks/7.md) `[6]`: Implemented the accepted D3 config-directory selector and recursive creator in the two owned leaf files; targeted tests and source audit pass and the task is ready for independent review.
- ✅ [8. Review config helper implementation](tasks/8.md): Changes needed: durable evidence repair 8.1 and re-review 8.2 are open.
  - ✅ [8.1. Repair config helper verification evidence](tasks/8.1.md)
  - ✅ [8.2. Re-review config helper verification evidence](tasks/8.2.md) `[8.1]`
- ✅ [10. Brief config helper public integration](tasks/10.md) `[9]`: Drafted an executable, non-behavioral public-integration Brief for one root export, two authoritative docs and the Unreleased handoff; separate refinement remains required.
- ✅ [11. Brief D2 invocation core](tasks/11.md) `[2,9]`: D2 core brief is complete with a core-only recipe, exact checks and one focused decision packet for unresolved internal guard/compiler signatures.
- ✅ [12. Refine config public integration brief](tasks/12.md) `[10]`: Task 10 Brief refined and approved; D3/public API, scope and version remain unchanged.
- ✅ [13. Refine D2 invocation core brief](tasks/13.md) `[11]`: Task 11 Brief refined; DP-11 remains the sole blocker with tighter typing, scope, cancellation and acceptance evidence.
- ✅ [14. Integrate config helper public surface](tasks/14.md) `[12]`: Exposed the accepted config helper and updated authoritative docs and Unreleased; ready for task 15 review.
- ✅ [15. Review config public integration](tasks/15.md): Changes needed: task 14 has no durable bus-log evidence for freshness, command coverage, or dirty-hunk/scope preservation.
  - ✅ [15.1. Repair config integration verification evidence](tasks/15.1.md)
  - ✅ [15.2. Re-review config integration evidence repair](tasks/15.2.md) `[15.1]`
- ✅ [16. Decide DP-11 internal guard signatures](tasks/16.md) `[13]`: DP-11 accepted for package-internal guard compiler, typed locals and scope metadata/signature evolution.
- ✅ [17. Implement D2 invocation core](tasks/17.md) `[16]`: Implemented D2/DP-11 invocation core and the authorized minimal CLI scope-v2 migration; all exact final checks pass with 33/33 tests.
- ✅ [18. Review D2 invocation core](tasks/18.md): Changes needed. Task 18 requests one fix task and one scoped re-review for actual handler-boundary type safety, required property JSDoc, and durable post-edit validation evidence.
  - ✅ [18.1. Repair D2 invocation core review findings](tasks/18.1.md)
  - ✅ [18.2. Re-review D2 invocation core repairs](tasks/18.2.md) `[18.1]`
- ✅ [20. Brief CLI and factory binding](tasks/20.md) `[19]`: CLI/factory brief completed; one focused packet must settle the public command-context cutover before implementation.
- ✅ [21. Brief REST native binding](tasks/21.md) `[19]`: REST binding brief drafted against D2/DP-11; exact declaration/query registration shape is isolated as DP-21.
- ✅ [22. Brief JSON-RPC native binding](tasks/22.md) `[19]`: Drafted the task 22 JSON-RPC declaration, catalog, envelope, D2 encoding, OpenRPC and handoff Brief; DP-22 remains a focused public API and wire-profile gate.
- ✅ [23. Brief MCP registry and dispatcher](tasks/23.md) `[19]`: Briefs one fixed MCP 2026 catalog, transport-neutral discovery/list/call dispatch, D2 invokeBound, metadata, tests and exact adapter handoffs.
- ✅ [24. Brief shared service listener](tasks/24.md) `[19]`: Task 24 brief is ready for independent refinement; DP-24 must settle the exact listener, bind, handle and shutdown signatures before execution.
- ✅ [25. Refine CLI and factory brief](tasks/25.md) `[20]`: Changes made. Task 20 now has an executable D2/DP-11 cutover recipe; DP-20 remains the only gate and must resolve the full public/compatibility packet.
- ✅ [26. Refine REST binding brief](tasks/26.md) `[21]`: Refined task 21; DP-21 remains required for declaration, schema, wire, response and discovery gaps.
- ✅ [27. Refine JSON-RPC brief](tasks/27.md) `[22]`: Task 22 refined; DP-22 now pins the bounded API, params/ID, output/error, OpenRPC and notification evidence needed for implementation.
- ✅ [28. Refine MCP dispatcher brief](tasks/28.md) `[23]`: Refined task 23 boundaries, DP-23 gate, caller/source model and exact focused tests; no source or host work.
- ✅ [29. Refine shared listener brief](tasks/29.md) `[24]`: Changes made; task 24 now has executable streaming, rollback, socket-ownership, lifecycle, adapter-handoff and DP-24 requirements.
- ✅ [30. Decide DP-20 CLI cutover](tasks/30.md) `[25]`: DP-20 accepts A with a direct InvocationContext, one runtime schema, staged unreleased App.invoke bridge and exact hook/migration owners.
- ✅ [31. Decide DP-21 REST API and wire](tasks/31.md) `[26]`: decided: DP-21. Settled REST declaration typing, one-parse schemas, query/body framing, outcomes/Response composition and /api discovery identity.
- ✅ [32. Decide DP-22 JSON-RPC profile](tasks/32.md) `[27]`: DP-22 accepted the public JSON-RPC builder/block, strict envelope and JSON-safe error profile, OpenRPC 1.3.2 mapping and notification observation contract.
- ✅ [33. Decide DP-23 MCP 2026 fixture](tasks/33.md) `[28]`: DP-23 accepted from local MCP 2026 SDK schema and accepted experiment; task 23 now has exact fixtures with host gaps explicit.
- ✅ [34. Decide DP-24 listener lifecycle](tasks/34.md) `[29]`: DP-24 selected exact package-internal mounts, TCP/Unix targets, barrier rollback, handle state, idempotent bounded stop and task 20/21 handoffs.
- ✅ [35. Brief post-adapter CLI migration integration](tasks/35.md) `[30]`: Executable post-adapter cutover and public-integration brief; task 36 remains blocked pending a contract revision and accepted mirror/relay prerequisite.
- ✅ [36. Implement CLI and factory cutover](tasks/36.md) `[30,35,56,58,60,62,66,70,75,76]`: Implemented D35 CLI/factory cutover; exact Biome, TypeScript, focused 231-test, diff and ownership checks pass.
- ✅ [37. Implement REST native binding leaf](tasks/37.md) `[31]`: Implemented and verified the DP-21 REST catalog, binding, dispatch, encoding and OpenAPI leaf.
- ✅ [38. Review REST native binding](tasks/38.md): Changes needed; task 38.1 repairs query discrimination, own-key binding and JSDoc/evidence gaps for scoped re-review.
  - ✅ [38.1. Repair REST binding review findings](tasks/38.1.md)
  - ✅ [38.2. Re-review REST binding repairs](tasks/38.2.md) `[38.1]`
- 🔄 [39. Implement JSON-RPC native binding leaf](tasks/39.md) `[32]`: Dropped as superseded after a model-chain violation; accepted replacement task 39.1 verified the five-file implementation on the selected model.
  - ✅ [39.1. Verify JSON-RPC implementation on selected model](tasks/39.1.md) `[32]`
- ✅ [40. Review JSON-RPC native binding](tasks/40.md): RPC review evidence refresh accepted; close parent after child 40.1 and re-review 40.2.
  - ✅ [40.1. Refresh JSON-RPC replacement evidence](tasks/40.1.md)
  - ✅ [40.2. Re-review JSON-RPC evidence repair](tasks/40.2.md) `[40.1]`
- ✅ [41. Implement MCP registry and dispatcher](tasks/41.md) `[33]`: Implemented and verified the DP-23 MCP registry, protocol codec and D2 dispatcher leaf.
- ✅ [42. Review MCP registry and dispatcher](tasks/42.md): Changes needed: MCP overlap typing, DP-23 fixture/evidence gaps need one bounded repair and re-review.
  - ✅ [43. Repair MCP dispatcher review findings](tasks/43.md)
  - ✅ [44. Re-review MCP dispatcher repairs](tasks/44.md) `[43]`
- ✅ [46. Implement shared HTTP listener](tasks/46.md) `[34,45]`: DP-24 listener review returned task55 for normalized path, Unix cleanup and durable evidence repairs.
- ✅ [47. Review shared HTTP listener](tasks/47.md): Changes needed: task55 repairs normalized claims, Unix identity cleanup and exact post-edit evidence; task56 re-reviews.
  - ✅ [55. Repair shared listener review findings](tasks/55.md)
  - ✅ [56. Re-review shared listener repairs](tasks/56.md) `[55]`
- ✅ [48. Brief REST transport adapter](tasks/48.md) `[45]`: Ready to brief the REST mount/local-mirror/relay adapter around accepted binding and listener contracts.
- ✅ [49. Brief JSON-RPC transport adapter](tasks/49.md) `[45]`: Task 49 Brief is ready for independent refinement with exact HTTP mount, local mirror, relay, source/signal, notification/batch, file, test and factory-owner contracts.
- ✅ [50. Brief MCP transport adapters](tasks/50.md) `[45]`: Briefed independent stdio and Streamable HTTP adapters, plus mirror/relay handoffs, around the accepted MCP dispatcher.
- ✅ [51. Refine CLI cutover executor readiness](tasks/51.md) `[35,45]`: Ready to turn task 36's reservation into an exact executor contract or identify the remaining prerequisite.
- ✅ [52. Refine REST transport brief](tasks/52.md) `[48]`: Refined task 48 with exact mount, hooks/CORS/trace, mirror/relay, discovery/health, source/stream/abort/body, files/tests and shared write-order handoffs; credential/display/factory gaps are routed.
- ✅ [53. Refine RPC transport brief](tasks/53.md) `[49]`: Refined task 49; exact RPC mount/200-204/source-signal behavior and listener/factory ownership are executable, while the shared relay API, credential and display choices are routed to task 36/51.
- ✅ [54. Refine MCP transport brief](tasks/54.md) `[50]`: Refined task 50 for exact one-registry, stdio framing/control, HTTP boundary, selection, mirror/relay and host gaps.
- ✅ [57. Implement REST HTTP mount leaf](tasks/57.md) `[46,52]`: Implemented and review-repaired the exact REST /api mount and discovery handoff; all named focused checks and post-task61 full-tree typecheck pass.
- ✅ [58. Review REST HTTP mount](tasks/58.md): Approve task 57 after retained-executor repair closes throwing access observation plus invocation, locals and incremental stream evidence gaps.
- ✅ [59. Implement JSON-RPC HTTP mount](tasks/59.md) `[46,53]`: Implemented and verified the exact /rpc HTTP mount and OpenRPC endpoint; retained for independent task 60 review.
- ✅ [60. Review JSON-RPC HTTP mount](tasks/60.md): Approved task 59's final /rpc HTTP mount and exact post-edit evidence after one negotiation round.
- ✅ [61. Implement MCP stdio adapter](tasks/61.md) `[54]`: Implemented and verified the MCP 2026 stdio NDJSON adapter for review.
- ✅ [62. Review MCP stdio adapter](tasks/62.md): Approved task 61; both negotiated findings are closed and exact 43/43, typecheck and Biome evidence is retained.
- ✅ [63. Implement MCP HTTP adapter](tasks/63.md) `[46,54]`: Implemented the MCP 2026 Streamable HTTP mount and retained it for task 64 review; owned checks pass, with one unrelated stdio typecheck blocker.
- ✅ [64. Review MCP HTTP adapter](tasks/64.md): Changes needed only for missing official fresh command evidence; implementation matches the MCP HTTP contract.
- ✅ [65. Retain MCP HTTP final evidence](tasks/65.md): Retained exact fresh MCP HTTP final evidence for the unchanged already-reviewed adapter.
- ✅ [66. Re-review MCP HTTP evidence](tasks/66.md) `[65]`: Approved task 65; exact unchanged MCP HTTP evidence closes task 64 finding 1.
- ✅ [67. Implement REST local mirror and relay](tasks/67.md) `[35]`: Implemented REST local mirror and relay; focused checks pass and independent review is pending.
- ✅ [68. Review REST local mirror and relay](tasks/68.md): Changes incorporated and closed by accepted repair task 73 and re-review task 75.
- ✅ [69. Implement JSON-RPC local mirror and relay](tasks/69.md) `[35]`: Implemented JSON-RPC local mirror and relay; focused checks pass and independent review is pending.
- ✅ [70. Review JSON-RPC local mirror and relay](tasks/70.md): Approved the D35 JSON-RPC mirror and relay implementation; no significant findings.
- ✅ [71. Implement MCP local mirror and relay](tasks/71.md) `[35]`: Implemented MCP local mirror and relay; focused checks pass and independent review is pending.
- ✅ [72. Review MCP local mirror and relay](tasks/72.md): Changes incorporated and closed by accepted repair task 74 and re-review task 76.
- ✅ [73. Repair REST mirror review findings](tasks/73.md): Ready to repair redirect handling and the missing shared D35 registration seam.
- ✅ [74. Repair MCP mirror review findings](tasks/74.md): Ready to repair MCP abort classification and validate complete 2026 tool results.
- ✅ [75. Re-review REST local mirror repairs](tasks/75.md) `[73]`: Waiting for the REST mirror repair handoff.
- ✅ [76. Re-review MCP local mirror repairs](tasks/76.md) `[74]`: Waiting for the MCP mirror repair handoff.
- ✅ [77. Review CLI and factory cutover](tasks/77.md): Approved after the retained executor closed all four CLI/factory review findings.
- 🚫 [78. Review final v9 public migration](tasks/78.md): Dropped as superseded by the narrower concurrent public API, template and docs review tasks 79-81.
- ✅ [79. Review v9 core public API](tasks/79.md): Core findings incorporated and closed through tasks 82, 83, 89 and 99.
- ✅ [80. Review v9 templates and packaging](tasks/80.md): Template/package findings incorporated and closed through tasks 84 and 87.
- ✅ [81. Review v9 docs and release claims](tasks/81.md): Docs/release findings incorporated and closed through tasks 85 and 88.
- ✅ [82. Repair v9 runtime integration](tasks/82.md): Ready to repair hooks, service selection, health/status mounts and legacy service aliases.
- ✅ [83. Repair v9 protocol clients](tasks/83.md): Ready to repair MCP wrapped inputs and RPC/MCP redirect policy.
- ✅ [84. Repair v9 plugin template](tasks/84.md): Ready to rebuild the plugin executable, fix launch docs and record package-content evidence.
- ✅ [85. Repair v9 docs and release claims](tasks/85.md): Reconciled stale 8.x claims and unsupported features; validation passed and independent review is pending.
- ✅ [86. Review v9 protocol repairs](tasks/86.md): Approved task 83; no significant protocol repair findings.
- ✅ [87. Review v9 plugin repairs](tasks/87.md): Approved task 84; bundle, launch docs and package evidence are consistent.
- ✅ [88. Review v9 docs repairs](tasks/88.md): Approved docs repair after Tasks were explicitly marked not implemented.
- ✅ [89. Review v9 runtime repairs](tasks/89.md): Approved runtime repairs; all three task-89 findings are closed.
- ✅ [90. Decide v9 guard and caller public APIs](tasks/90.md): Ready to settle public CLI/MCP surface guards and HTTP caller seed establishment.
- ✅ [91. Decide v9 child composition API](tasks/91.md): Ready to settle keyed build-time child composition.
- ✅ [92. Add v9 app-authoring skills](tasks/92.md): Ready to add the bootstrap and shared upsert skills required by the seed.
- ✅ [93. Review v9 authoring skills](tasks/93.md): Approved bootstrap/upsert skill parity and intent-first behavior.
- ✅ [94. Implement CLI guards](tasks/94.md) `[90]`: Ready to implement the public CLI surface/operation guard slice.
- ✅ [95. Implement MCP guards and caller seed](tasks/95.md) `[94]`: MCP guard and caller-seed implementation complete, including raw registration parity; re-review is active.
- ✅ [96. Implement keyed child composition](tasks/96.md) `[95,98]`: Child composition implementation and final regression fix complete; task 102 final re-review active.
- ✅ [97. Review CLI guard slice](tasks/97.md): Approved CLI guard slice after public guard typing was made precise.
- ✅ [98. Implement child snapshot core](tasks/98.md) `[91]`: Accepted isolated child snapshot core with D91 validation, immutable snapshots and review approval from task 100.
- ✅ [99. Review MCP guard slice](tasks/99.md): Approved MCP guard slice after raw registrations fail closed under mcp.guard.
- ✅ [100. Review child snapshot core](tasks/100.md): Approved isolated child snapshot core after final MCP-name and immutability fixes.
- ✅ [102. Review child composition integration](tasks/102.md): Approved child integration after all lifecycle, disabled CLI, grouped option and serve-collision findings closed.
- ✅ [103. Integrate D90 and D91 public APIs](tasks/103.md) `[96,102]`: Accepted rollup for D90/D91 exports, docs, reconciliation and all example/template integration slices.
  - ✅ [107. Export D90 and D91 APIs](tasks/107.md) `[94,95]`
  - ✅ [108. Update v9 examples and templates](tasks/108.md) `[110]`
  - ✅ [109. Update D90 and D91 docs](tasks/109.md) `[94,95]`
  - ✅ [110. Reconcile public slices with child outcome](tasks/110.md) `[96,102,107,109]`
  - ✅ [111. Update standalone v9 examples](tasks/111.md) `[110]`
  - ✅ [112. Update CLI template](tasks/112.md) `[110]`
  - ✅ [113. Update API template](tasks/113.md) `[110]`
  - ✅ [114. Update agent-plugin template](tasks/114.md) `[110]`
  - ✅ [115. Update Homebrew template](tasks/115.md) `[110]`
- ✅ [104. Review D90 and D91 public integration](tasks/104.md) `[110,111,112,113,114,115,116,117,118,119,120,121,122]`: All six disjoint public reviews and MCPB packaging repair are accepted.
- ✅ [105. Run final v9 release validation](tasks/105.md) `[104]`: Final release validation passed completely; all ordered tests, builds, package and audit gates succeeded.
- ✅ [106. Release argsbarg v9](tasks/106.md) `[105]`: Published argsbarg v9.0.0; commit 89fdf1d, tag v9.0.0, GitHub release and npm publish succeeded. .agents excluded from release commit.
- ✅ [116. Review public exports and docs](tasks/116.md) `[110]`: Approved public exports/docs with no significant findings.
- ✅ [117. Review standalone examples](tasks/117.md) `[111]`: Approved standalone examples after MCP and raw option-output repairs.
- ✅ [118. Review CLI template](tasks/118.md) `[112]`: Approved CLI template after serve semantics and reserved-command guidance repairs.
- ✅ [119. Review API template](tasks/119.md) `[113]`: Approved API template after status --json behavior repair.
- ✅ [120. Review agent-plugin template](tasks/120.md) `[114]`: Approved agent-plugin packaging after task 122 preserved MCPB executable mode.
- ✅ [121. Review Homebrew template](tasks/121.md) `[115]`: Approved Homebrew template with no significant findings.
- ✅ [122. Preserve MCPB executable mode](tasks/122.md): MCPB executable-mode repair complete; task 120 re-review is active.
<!-- tasks:end -->
