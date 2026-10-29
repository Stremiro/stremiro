# Stremiro upgrade tracker

Reviewed 2026-10-29. Focus: release safety, less wasted work, and dependable player/search/details UX.
This is a curated checklist, not authorization to implement every item or start parked redesigns.

## Completion checkpoint

- **42 of 51 items verified (82%); 9 remain open.** Counts do not estimate remaining effort.
- Three security/provenance blockers: SEC1, SEC3, SEC5. Four packaged verification gates:
  RC1, PX1, DL1, UPG-QA1; RC1/PX1 already have implementations and isolated native proof.
- Two conditional optimizations: FO2, P4. Neither currently establishes a material startup/paint gain.
- Cleanup-only follow-ups remain separate: P3, FO3, FO4, UX3, UX7. Visual decisions and
  deferred experiments are not additional proven defects.

## Rules

1. **Evidence before edits.** Recheck each cited location and the current behavior. Add only confirmed
   defects, demonstrated waste, or explicitly labeled measurement/verification tasks. No speculative fixes.
2. **Smallest correct implementation.** Prefer deletions, reuse, and direct fixes. Simplify overengineered
   paths when behavior stays intact. No new dependencies, abstractions, scripts, or files without a scoped need.
3. **Rust owns the work.** Computation, transport, validation, persistence, ranking, and playback policy
   belong in Rust. TypeScript owns UX and presentation. A port must delete the replaced TS logic and
   preserve Unicode, ordering, errors, persisted formats, and both sides of IPC.
4. **Premium without waste.** Preserve responsive input, keyboard/focus behavior, reduced motion, cached
   content on refresh failure, and smooth transitions. Reduce legacy code, not supported features.
5. **No code bloat.** No redundant comments, design journals, speculative fallbacks, or duplicate policy.
   Extra lines must buy a concrete gain. **MORE CODE DOES NOT MEAN A BETTER APP.**
6. **Respect existing work.** Follow `AGENTS.md`, `.dev/CODEGRAPH_RULES.md`, and existing cleanup decisions.
   Use CodeGraph first; preserve README exactly, user changes, store/native gate lifetimes, and cancellation guards.
7. **Measure performance claims.** `[measure]` requires comparable before/after time, bytes, requests,
   IPCs, mounted rows, or frame costs. No material gain means drop the change, not expand the rewrite.
8. **Lint, format, test.** For app changes run `bun run check`, `bun run test:rust`,
   `bun run build` for frontend production changes, and `git diff --check`. Fix introduced failures.
   For documentation-only changes, format/check the changed document and check its diff.
9. **Tick only when verified.** Keep blocked/partial work unchecked. Under its AI notes record date,
   change, checks/results, measurements, and skipped native/visual checks. A required native check is
   a completion gate, not something an automated pass substitutes for.
10. **One identity per task.** Existing IDs refer to `.dev/cleanup_tracker.md`; do not implement twice.
    When completing an existing task, also record its required one-line result in `.dev/CLEANUP_LOG.md`.
    Keep new task results here. Recheck status before starting; completed fixes stay closed.

Tags: `[blocked]` needs missing evidence/testing; `[decision]` needs an agreed behavior/design;
`[measure]` is conditional, not a proven latency improvement; `[native]` needs packaged mpv/WebView2.
Append short dated bullets beneath each **AI notes** line, not implementation essays.

## Release hardening, resolve first

- [x] **SEC8: Replace the vulnerable updater ZIP dependency.**
  - Evidence: `src-tauri/Cargo.toml:24`; updater 2.14.0 pulled ZIP 4.6.1 with three RustSec advisories.
  - **AI notes:**
    - 2026-10-29: Upstream released updater 2.14.1 with ZIP 9. Raised the minimum and updated only
      its dependency chain to ZIP 9.1.3; audit vulnerabilities fall from three to zero. Existing
      advisory warnings remain. Independent review, check (44 UI tests, Clippy), 757 Rust tests,
      build and diff-check pass; packaged updater installation remains unverified.
    - 2026-10-29 second pass: Borrow the inline download callback's context; remove its Arc and
      cloned handles/operation ID. Move the saved error instead of copying it, formatting before
      locking. Guards and messages preserved; independent review, check, 757 Rust tests, audit and
      diff-check pass. Temporary comparison probes removed; packaged updater remains unverified.

- [ ] **SEC1: Verify native media HTTPS.** `[partial: DASH TLS and IP certificate names] [native]`
  - Evidence: `src-tauri/src/commands/player_mpv_commands.rs:154-188`; prior isolated bundled-DLL
    reproduction recorded invalid-certificate acceptance in `.dev/cleanup_tracker.md`.
  - Fix/benefit: enforce verified TLS with a validated native trust store; protect media and its
    authorization headers. Rust HTTPS settings do not configure libmpv.
  - Done: trusted media works; self-signed, expired, and wrong-host fixtures fail; check HLS/DASH.
    Preserve explicit local-addon policy. Verify option support before use; unknown options can wedge the wrapper.
  - **AI notes:**
    - 2026-10-28: Enabled the verified `tls-verify=yes` startup option. Bundled DLL/wrapper
      fixtures reject self-signed and expired direct requests before HTTP; trusted
      MP4/HLS/DASH load with the default trust store. Valid local fixture chains also load.
      HLS rejects self-signed and expired segment certificates; DASH still loads all three, so SEC1
      stays open. An extra FFmpeg option did not close that gap and was dropped. No local TLS
      bypass added; plain HTTP admission is unchanged. Rust-downloaded subtitles stay separate.
      Temporary configuration regression failed before/passed after and was removed. Check
      (44 UI tests, zero lint warnings, Clippy), 757 Rust tests, build and diff-check pass.
      Packaged playback/WebView2 remain unverified; DLL provenance and SEC3 remain open.
    - 2026-10-29 native pass: 44 DLL/wrapper observations and four independent TLS controls
      correct the earlier blanket hostname-rejection claim. CA-trusted certificates for an unrelated
      name load on IP-literal HTTPS direct media and HLS segments; the DNS-name direct control
      rejects the mismatch. DASH still loads self-signed, expired and wrong-name segments.
      At the reported FFmpeg revision `2df0ef601`, `tls_openssl.c:881-895` skips name verification
      for numeric hosts; DASH `open_url` opens directly and its copied URL options omit TLS settings.
      Explicit `demuxer-lavf-o=tls_verify=1` did not fix DASH. No safe configuration-only fix found;
      retain the chain-verification improvement, require a verified native fix or approved transport
      design, and do not block supported formats or add local TLS exceptions merely to close SEC1.
      Documentation format/diff checks passed; 67 non-document baseline hashes match, including
      README, existing UI tests, app code and DLLs. Temporary test code removed; app test/build
      gates were not rerun for this documentation-only update. Packaged playback remains unverified.

- [ ] **SEC3: Enforce policy on actual native requests.** `[decision: parked transport design] [native]`
  - Evidence: `src-tauri/src/commands/stream_resolver.rs:207-282,314-329`; recorded native GET
    redirect forwarded headers after a successful HEAD.
  - Fix/benefit: enforce destination/origin restrictions and credential stripping on media redirects
    and nested HLS/DASH requests. Another preflight cannot secure later native traffic.
  - Done: test HEAD/GET disagreement, cross-origin headers, public-to-private destinations, CDN
    compatibility, and explicit local addons. Agree the transport boundary before implementation.
  - **AI notes:**
    - 2026-10-29: Bundled DLL and wrapper both forward synthetic Authorization and custom-token
      headers to another port after HEAD 200/native GET 302, and on cross-origin DASH segment
      fetches. A protocol allowlist does not strip these headers or enforce destination/origin policy;
      network DASH already rejects `file:` segments without that extra option. The wrapper exposes
      commands/properties, not a per-request interception hook, and DASH bypasses mpv's nested I/O
      callback. Another preflight or global option is not an enforcement boundary.
      Keep the transport redesign parked pending approval; public-to-private, CDN/local-addon and
      packaged-flow checks remain open. P9 already moved external subtitle HTTP into Rust;
      do not reopen that solved path. No app changes or new dependencies.

- [ ] **RC1: Serialize exit flush with store operations.** `[native: packaged-flow verification]`
  - Evidence: the former exit callback flushed outside `STORE_OP_LOCK`; import stages list entries before order in
    `src-tauri/src/commands/backup_commands.rs:713-733`.
  - Fix/benefit: prevent the initial exit, asynchronously drain `STORE_OP_LOCK`, flush, then resume
    exit with a bounded fallback. Atomic files alone do not prevent incomplete logical snapshots.
  - Done: quit during import and timed-out blocking work; verify store/order consistency and a
    usable escape from stalled work. Do not block the event loop or promise safety against forced OS kills.
  - **AI notes:**
    - 2026-10-28: User approved a 10-second fallback. Exit now drains/flushes through the existing
      bounded Rust store helper, closes later store admission under the gate, and resumes exit
      once; removed the unsafe final `Exit` flush. The native Windows/WebView2 staged-list
      regression failed before and passed after. Queued writes, timed-out callers with running
      workers, repeated requests, last-window close, clean exit, failed flush and late-write
      rejection passed. Stalled work exited in 10.015 s without flushing the partial snapshot;
      clean exit took 16.6 ms. Check (44 UI tests, Clippy), 757 Rust tests, build and diff-check
      passed after temporary tests were removed. Isolated native probes used temporary data and
      a test-only Common Controls manifest; packaged quit during an actual import/restart remains
      unverified, so this task stays open. The timeout/forced OS kill can still interrupt running work.

- [x] **SEC10: Keep credential-bearing URLs out of addon IDs.**
  - Evidence: `src-tauri/src/commands/config_store/addons.rs:239-295`;
    `src/pages/settings/streaming.tsx:269-271` puts the ID in the DOM.
  - Fix/benefit: assign stable opaque fallback IDs in Rust for blank/colliding IDs, migrating affected
    source/history references consistently. Masked display URLs must not leak through another field.
  - Done: import configured token URLs with blank/duplicate IDs; inspect IPC/DOM and verify reorder,
    source affinity, resume, and identity stability across restart. Do not regenerate IDs on each read.
  - **AI notes:**
    - 2026-10-28: Rust derives stable opaque URL IDs, repairs collisions (including pinned defaults),
      and maps selector/history/source-health references while preserving release-family affinity.
      Import, long-URL, reorder, SQLite restart/resume and six real Settings markup rows passed;
      the credential leak and pinned-ID collision failed before their fixes. Check (44 UI tests,
      Clippy), 757 Rust tests, build and diff-check passed. Temporary tests removed; existing tests
      updated for the changed IDs. Live Tauri/WebView2 and native playback not checked.
    - 2026-10-28 second pass: Reused owned opaque IDs instead of copying them in registry,
      history and preference normalization; playback outcome writes now normalize URL IDs too.
      Buffer-reuse regression failed before and passed after; long-URL, Unicode and identity
      consistency checks passed. Check (44 UI tests, Clippy), 757 Rust tests and diff-check passed.
      Temporary tests removed; Rust-only changes, native playback/WebView2 not checked.

- [ ] **SEC5: Verify runtime provenance, then pin approved DLL hashes.** `[blocked: independent provenance]`
  - Evidence: `src-tauri/lib/PROVENANCE.txt:9-20`; `scripts/build-tauri.ps1:105-129` compares copies,
    not an approved expected pair.
  - Fix/benefit: verify distribution source, version, build flags, licensing, and wrapper compatibility;
    reject unapproved/mixed pairs during packaging. Matching copies are not proof of trust.
  - Done: known-good pair passes; staged tampering, matching tampered copies, and mixed pairs fail.
    Do not bless present hashes or swap runtimes merely to tick this task.
  - **AI notes:**
    - 2026-10-29: Public exact-version/digest lookup did not establish the distribution's independent
      provenance. No current hash was approved, no runtime replaced and no packaging pin added.
      Release-integrity work remains blocked, not a runtime performance improvement.

## Correctness and avoidable resource use

- [x] **UPG-B3: Restore language preferences from actual local state.**
  - Evidence: `playback_state/language_preferences.rs:247`; index membership blocked repair of
    unusable rows, while a missing index let imports overwrite a valid local pick.
  - **AI notes:**
    - 2026-10-29: Check sanitized local snapshots before restoring. Both regressions failed before
      and passed after; valid audio/subtitle Off, alias precedence and disk reopen checks pass.
      Temporary tests/helper removed; gates as SEC8. Packaged restore/restart remains unverified.
    - 2026-10-29 second pass: Keep the accepted-key fast path; removing it and reusing the full
      preference merge passed 290 parity cases but made the 10,000-row alias fixture slower.

- [x] **UPG-C1: Delete unusable reputation payloads during pruning.**
  - Evidence: `playback_state/stream_health.rs:523`; pruning removed malformed rows from the
    advisory index without deleting their persistent payloads, leaving unreachable cache entries.
  - **AI notes:**
    - 2026-10-29: Delete the rejected payload with its index entry. The regression failed before
      and passed after for both source-health and stream-family caches, including disk reopen;
      healthy rows survive. Temporary test removed; gates and native limits as SEC8.

- [x] **UPG-H15: Isolate undecodable catalog and subtitle display fields.**
  - Evidence: `src-tauri/src/providers/addon_resource.rs:165-180,210-225`; decoding one optional
    artwork/label field beyond JSON nesting or numeric limits discarded an otherwise valid row.
  - **AI notes:**
    - 2026-10-29: One borrowed-JSON field decoder drops only the unusable optional field; required
      identities, URL validation, ordering, coercions and row limits stay intact (+23 production lines).
      Both regressions failed before; 32 field cases and all 48 resource tests passed afterward.
      Temporary tests removed; existing subtitle fixtures now use production's JSON-text decode path.
      Check (44 UI tests, zero lint warnings, Clippy), 757 Rust tests, build and diff-check pass.
      README preserved; live addons, packaged WebView2 and native playback not checked.

- [x] **UPG-B2: Restore title-language aliases deterministically.**
  - Evidence: `src-tauri/src/commands/playback_state/language_preferences.rs:225-254`;
    randomized map order let aliases override a valid canonical title preference during import.
  - **AI notes:**
    - 2026-10-29: Normalize once, sort canonical keys before stable aliases, and retain local picks.
      A 128-map regression failed before and passed after; alias-only ties, Unicode/colon IDs,
      malformed/empty canonical fallback, timestamps and existing local snapshots pass.
      Temporary helper/tests removed; +5 production lines. Check (44 UI tests, Clippy),
      757 Rust tests, build and diff-check pass; packaged import/restart not checked.

- [x] **UPG-P8: Keep stale render handlers from skipping valid track changes.**
  - Evidence: `src/hooks/use-player-track-controller.ts:305-316`; a held handler skipped returning
    to its old audio/subtitle selection after a newer native acknowledgement.
  - **AI notes:**
    - 2026-10-29 second pass: Reuse the existing track matcher to check the live snapshot before
      skipping a native write; retain rendered-state checks and native reassertions during refresh.
      Fold the sole switch helper into its caller (-24 source lines), preserving generation,
      switching, silent-error and preference guards. Three regressions fail on the baseline;
      all 41 focused cases pass (195 assertions), including 32 mixed acknowledgement orders.
      Temporary tests removed; check (44 UI tests, zero lint warnings, Clippy), 757 Rust tests,
      build, compiler comparison and diff-check pass. README/existing tests preserved;
      packaged playback and WebView2 visuals not checked. No new state, IPC or playback policy.

- [x] **UPG-P7: Keep concurrent audio/subtitle acknowledgements independent.**
  - Evidence: `src/hooks/use-player-track-controller.ts:196-207`; a delayed audio acknowledgement
    replaced a newer subtitle selection and its observed ID, so even a refresh kept the wrong selection.
  - **AI notes:**
    - 2026-10-29: Reuse the pre-call confirmation revision to retain newer other-kind rows;
      update only the changed kind's observed ID. First acknowledgements still seed full enumeration.
      Sixteen reversed-order regressions failed before; all 33 selection/cycle/Off/external-subtitle/
      startup/reset cases pass (243 assertions). Temporary tests removed; independent combined
      review found no further issue. Check (44 UI tests, zero lint warnings, Clippy), 757 Rust tests,
      build, compiler comparison and diff-check pass. README/existing tests preserved;
      packaged playback and WebView2 visuals not checked. No extra IPC, state or playback policy.

- [x] **UPG-H14: Isolate undecodable optional metadata fields.**
  - Evidence: `src-tauri/src/providers/addon_resource.rs:803`; an excessive-depth or out-of-range
    optional field rejected otherwise usable title metadata and episodes.
  - **AI notes:**
    - 2026-10-29: Skip only undecodable fields before the existing required-field checks and
      fallback resolution. The regression failed before; 38 optional-field and six required-field
      cases pass, preserving title/episode output and required-field rejection. Temporary test
      removed; response/episode bounds unchanged. Independent review and gates as UPG-P7;
      live addons/native visuals not checked. No latency gain claimed.

- [x] **UPG-B1: Keep imported addon references aligned with retained local identities.**
  - Evidence: `config_commands.rs:53-105`, `backup_commands.rs:621-799`; the same addon URL can
    retain its local ID while imported history, release families and selector filters keep another ID.
  - **AI notes:**
    - 2026-10-29: Preflight maps imported history, matching family digests and selector filters to
      retained IDs; installed toggles/snapshots and opaque prepared keys stay unchanged. Different-ID,
      collision, full-registry and legacy-family probes pass. Review caught alias-index invalidation
      during URL deduplication; the regression failed before/passed after final-URL matching.
      Temporary tests removed. Check (44 UI tests, zero lint warnings, Clippy), 757 Rust tests,
      build and diff-check pass. README/existing UI tests preserved; packaged import/restart,
      native playback and WebView2 visuals unverified. SEC1/SEC3/SEC5 and existing native gates stay open.

- [x] **UPG-P6: Reject expired native work before it starts.**
  - Evidence: `player_mpv_commands.rs:97-105`; a queued blocking worker could execute after its
    deadline before the caller's timeout was polled.
  - **AI notes:**
    - 2026-10-29: Worker checks the shared deadline before executing. The delayed-poll/queued-worker
      regression failed before/passed after; running operations still retain their gate/input lifetime.
      Temporary test removed; gates and native limits as UPG-B1.

- [x] **UPG-H13: Keep malformed episode rows from discarding usable siblings.**
  - Evidence: `addon_resource.rs:976-981`; a single row's decoding failure discarded the entire episode array.
  - **AI notes:**
    - 2026-10-29: Decode rows independently; retain valid siblings, the accepted-row cap and stable
      sorting. The nested-field regression failed before/passed after. Larger projection alternatives
      measured slower and were dropped; no speedup claimed. Temporary tests removed; gates as UPG-B1.

- [x] **UPG-L3: Preserve accepted sequence-shaped Library records in selected reads.**
  - Evidence: `library_commands.rs:62-67`; normal reads accepted rows that selected reads silently skipped.
  - **AI notes:**
    - 2026-10-29: Borrow the accepted sequence ID too, retaining selected-only decoding. Normal/selected
      snapshot parity and read-only checks failed before/passed after; no shipped tuple writer claimed.
      Temporary test removed; gates and native limits as UPG-B1.

- [x] **UPG-H11: Decode only consumed metadata fields.** `[measure]`
  - Evidence: `src-tauri/src/providers/addon_resource.rs:770`; decoding unknown nested fields
    rejected otherwise usable titles and allocated data the app never reads.
  - **AI notes:**
    - 2026-10-29: Project known fields before decoding; keep episode bounds and output unchanged.
      Nested-field regression failed before/passed after. Fifteen-sample debug fixture medians
      (1,260,300 bytes): 2.97→0.38 ms, not app latency. Temporary tests removed; gates as UPG-U4.

- [x] **UPG-H12: Read backup addon identities without decoding discarded capabilities.** `[measure]`
  - Evidence: `src-tauri/src/commands/backup_commands.rs:436`, `config_store/addons.rs:63`;
    import decoded every snapshot before clearing it, while identity reads dropped valid legacy tuples.
  - **AI notes:**
    - 2026-10-29: Reuse identity projection and stream the merge; preserve legacy decoding,
      normalization, deduplication and limits. Legacy-read regression failed before/passed after;
      malformed/Unicode/tuple import parity passed. Fifteen-sample debug merge medians
      (64 addons, 1,170,499 bytes): 16.93→0.46 ms, excluding network/disk, not app latency.
      Temporary tests removed; gates as UPG-U4.
    - 2026-10-29 second pass: Export reuses the same identity reader (-6 production lines).
      Serialized addon bytes match the previous decoder for legacy/malformed/Unicode records,
      duplicate identities and pinned toggles without changing stored snapshots. A 30-addon,
      548,656-byte debug fixture (21 samples) reduced export identity decoding from 7.80→0.15 ms;
      excludes network/disk and is not total export latency. Passing temporary tests removed.

- [x] **UPG-U4: Preserve watch statuses for prototype-named media IDs.**
  - Evidence: `src/hooks/use-media-library.ts:77`, `src/lib/query-client.ts:22`; assignment
    and default query structural sharing silently lost the valid `__proto__` ID.
  - **AI notes:**
    - 2026-10-29: Define own cache keys and bypass deep copying only for affected snapshots;
      ordinary structural sharing stays intact. Mutation/replacement/selector regressions passed.
      Temporary tests removed; check (44 UI tests, zero lint warnings, Clippy), 757 Rust tests,
      build and diff-check passed. README/existing UI tests byte-preserved; live addons,
      packaged playback and WebView2 visual checks not performed. Native blockers remain open.
    - 2026-10-29 second pass: 200 mixed optimistic writes/server replacements preserve exact
      keys, prior snapshots and observer selection. Queued-write barriers retain late failures
      without blocking later attempts after settlement. Both probes passed (804 assertions);
      temporary tests removed. Existing cache, exit, reorder and playback-intent policies retained.

- [x] **UPG-P4: Preserve volume and mute intent across native echoes.**
  - Evidence: `src/hooks/use-player-volume-controls.ts:51-55`; delayed opposite mute events
    replaced the latest user intent, including input during native startup.
  - **AI notes:**
    - 2026-10-29: Reused the volume controller's pending-echo pattern for mute; confirmation
      releases it and failed writes still restore observed native state. Failing-before mute,
      unmute and startup regressions plus rapid reversals pass. Temporary tests removed;
      React Compiler coverage unchanged. Gates and native limits as UPG-L2 below.
    - 2026-10-29 second pass: Flattened both audio echo guards (-4 source lines); pending and
      observed state retain their distinct rollback roles. Four temporary startup/echo/confirmation/
      failure checks pass; compiler coverage unchanged. Gates below rerun; temporary tests removed.
    - 2026-10-29 echo-order review: Returning to an earlier volume let its old matching echo
      release the guard and rebase the next relative input. Reuse live desired refs with boolean
      intent guards; native observations still supply failed-write rollback (-2 source lines).
      Both event/acknowledgement orders failed before; all 12 startup, reversal, settled-write,
      failure/retry and external-preference cases pass. Temporary probes removed; React Compiler
      coverage unchanged. Gates as UPG-B2; packaged mpv/WebView2 timing not checked.

- [x] **UPG-P5: Retain volume changes made during native startup.**
  - Evidence: `src/hooks/use-player-volume-controls.ts:95-99`; the readiness guard cleared
    pending volume, letting the initial 50% echo overwrite a newer 70% request.
  - **AI notes:**
    - 2026-10-29: Keep pending volume while initialization owns native writes; external preference
      changes use the same guard. The startup regression failed before and passes after;
      no extra IPC or persistence policy. Temporary tests removed; gates as UPG-L2 below.

- [x] **UPG-L2: Decode only selected Library snapshots for bulk actions.** `[measure]`
  - Evidence: `src-tauri/src/commands/library_commands.rs:59-73`; list-add and status actions
    decoded/normalized all Library artwork and descriptions even for one selected title.
  - **AI notes:**
    - 2026-10-29: Filter borrowed stored IDs before decoding; preserve ordered results, normalized
      aliases, donor merging, malformed-record rejection and read-only capacity preflight.
      Nine-run medians in a 5,000-title debug fixture: 1 selected 73.23→2.87 ms, 100 selected
      72.84→4.19 ms, all 5,000 73.39→74.08 ms. This measures local resolution, not total UI latency.
      Differential/corruption checks and five audio regressions passed; temporary tests removed.
      Check (44 UI tests, zero lint warnings, Clippy), 757 Rust tests, build and diff-check passed.
      README/existing UI tests preserved; packaged mpv/WebView2 and visual checks not performed.
    - 2026-10-29 second pass: Rechecked aliases, full-length Unicode IDs, malformed records,
      stale/empty selections, donor order and read-only behavior. A single-map alternative added
      optional-state handling without a material timing gain; dropped and the resolver byte-restored.
      All gates above passed again after removing temporary tests; native limits unchanged.

- [x] **UPG-H10: Merge capability refreshes without registry copies or lost notifications.**
  - Evidence: `src-tauri/src/commands/config_commands.rs:388,436`; refresh cloned all routing
    trees before/after merging and skipped the change event when saving the live registry failed.
  - **AI notes:**
    - 2026-10-29 second pass: Compute routing changes during the existing merge and reuse the
      persistence/invalidation helper; removed the snapshot-copy helper/type and 15 production lines.
      A 32-addon/2.6 MB debug fixture (21 warmed samples) reduced unchanged/display/routing merge
      medians from 3.78/6.30/5.80 ms to 1.03/0.92/0.93 ms; excludes network/disk and is not app latency.
      Failed-save notifications, retries, stale identities and display/routing distinctions pass.
      Check (44 UI tests, Clippy), 757 Rust tests, build and diff-check passed; temporary probes
      removed, existing assertions updated, README/UI tests preserved. Live WebView2 not checked.

- [x] **UPG-H7: Reject catalog constraints with unusable required names.**
  - Evidence: `src-tauri/src/providers/addon_manifest.rs:173,221`; missing/null names were
    ignored, and non-string names dropped the required declaration during decoding.
  - **AI notes:**
    - 2026-10-28: Preserve required flags through name decoding and reject the affected catalog;
      valid siblings remain available. Five batch regressions failed before and passed after;
      ASCII/Unicode boundaries, scope persistence and existing manifest cases pass. Check
      (44 UI tests, Clippy), 757 Rust tests, build and diff-check passed after temporary tests
      were removed. README/existing tests preserved; live addons and native WebView2 not checked.

- [x] **UPG-H8: Keep catalog inputs and resource types exact.**
  - Evidence: `src-tauri/src/providers/addon_manifest.rs:182,261,444`; truncation let an
    overlong input displace a valid sibling's options and aliased resource/request types.
  - **AI notes:**
    - 2026-10-28: Shared strict opaque-field validation rejects overlong identities while keeping
      valid trimmed values, options and ordering. Routing borrows resource/type text; removed a
      single-use helper and duplicate option/catalog bounds. Gates and native limits as UPG-H7.

- [x] **UPG-H9: Keep malformed addon ID-prefix scopes restrictive.**
  - Evidence: `src-tauri/src/providers/addon_manifest.rs:203,305`; truncated prefixes matched
    unintended IDs, while malformed/nonempty lists could normalize into unrestricted empty lists.
  - **AI notes:**
    - 2026-10-28: Retain valid exact prefixes; disable scopes with no usable declared prefix while
      keeping them classified through persistence, preventing unknown-addon fallback. Explicit
      empty/null lists and object-resource inheritance semantics remain intact. Gates as UPG-H7.

- [x] **UPG-P3: Apply unmute safety to native string flags.**
  - Evidence: `src-tauri/src/commands/player_mpv_commands.rs:344-346,492-497`; admitted `"no"`
    unmutes natively but bypassed the boolean-only failed-volume and obsolete-write guards.
  - **AI notes:**
    - 2026-10-28: One Rust predicate covers `false` and `"no"` across command/batch IPC without
      changing accepted payloads. Both failing-before regressions pass; native wrapper checks
      confirm the valid flag spellings. Temporary assertions removed; gates as SEC1.
      No new dependency, IPC or persisted-format changes; packaged playback not checked.

- [x] **UPG-U3: Keep disabled inline menus closed after a rapid return.**
  - Evidence: `src/hooks/use-inline-menu.ts:47-55`; disabling hid the menu while retaining its
    open intent, so a mini-player exit reversal could reopen it without input or keyboard focus.
  - **AI notes:**
    - 2026-10-28: Clear the intent in the existing layout effect and skip disabled focus work.
      Chromium reproduction failed before/passed after; keyboard opening/arrows, repeat actions,
      Escape and host focus return pass. Temporary fixture removed; packaged mini-player remains
      unverified. Gates as SEC1; README and existing test files byte-preserved.

- [x] **UPG-H5: Preserve every required catalog input.**
  - Evidence: `src-tauri/src/providers/addon_manifest.rs:221-285`; legacy required-only
    extras, required duplicate declarations and extras beyond the cap lost their constraints.
  - **AI notes:**
    - 2026-10-28: Gather required names before deduplication/capping and expand legacy declarations.
      Reject catalogs with unrepresentable required inputs instead of making those inputs optional.
      Required-input regression failed before; legacy/duplicate/cap, ASCII/Unicode boundaries and
      valid-sibling recovery pass. Check (44 UI tests, zero lint warnings, Clippy), 757 Rust tests,
      build and diff-check passed after temporary tests were removed. Native WebView2 not checked.

- [x] **UPG-H6: Reject fabricated catalog filter options.**
  - Evidence: `src-tauri/src/providers/addon_manifest.rs:266-274`; overlong opaque options
    became truncated values the addon never declared.
  - **AI notes:**
    - 2026-10-28: Drop overlong options before normalization, retaining exact valid values, trimming,
      order and deduplication. Failing-before ASCII/Unicode boundary regression passes; temporary
      tests removed. Gates as UPG-H5; no measured latency improvement claimed.

- [x] **UPG-L1: Preserve the latest list and title reorder.**
  - Evidence: `src/components/list/lists-manager.tsx:575-619,1007-1090`; concurrent native
    reorders and older completions could overwrite newer persisted or optimistic order.
  - **AI notes:**
    - 2026-10-28: Reuse TanStack mutation scopes and exact-key ownership guards; track the complete
      queued UI write for close/export. Consolidated item success/error reconciliation. Eleven
      temporary regressions pass, including failures, remounts, barriers and independent-list
      concurrency. Older list-completion invalidations while a newer order is pending fell 2→0;
      equivalent item invalidations fell 1→0. Gates as UPG-H5; temporary tests removed and
      README/existing UI tests byte-preserved. Reuse/quality/efficiency reviews found no further issue.
      Interactive WebView2 drag/focus and packaged close/export remain unverified.

- [x] **UPG-H3: Preserve distinct addon catalog identities.**
  - Evidence: `src-tauri/src/providers/addon_manifest.rs:210-222,264-272` truncated catalog
    types/IDs and folded opaque IDs during deduplication; `addon_resource.rs:577-598` selected
    the first case-insensitive match even when another catalog matched exactly.
  - **AI notes:**
    - 2026-10-28: Reject overlong catalog types/IDs, deduplicate by the type/ID pair, and prefer
      exact catalog IDs while retaining the existing case-insensitive fallback. Case-distinct
      catalogs no longer disappear or borrow each other's search/required-extra capabilities.
      ASCII/Unicode limits, whitespace, exact duplicates and legacy matching passed. Five
      temporary regressions across H3/H4 failed before and passed after; removed them and updated
      the existing catalog expectation. Check (44 UI tests, zero lint warnings, Clippy), 757 Rust
      tests, build and diff-check passed. README and existing UI tests byte-preserved.
      No IPC, persisted-format or frontend changes; native mpv/WebView2 not checked.

- [x] **UPG-H4: Reject resource paths that rewrite request identity.**
  - Evidence: `src-tauri/src/providers/addon_resource.rs:1061-1071` truncated resource/type/ID
    segments and allowed dot-only segments that URL normalization can remove.
  - **AI notes:**
    - 2026-10-28: Reject overlong and dot-only segments before URL construction instead of silently
      rewriting them; reuse the trimmed string slice instead of allocating it. Boundary-length
      ASCII/Unicode values, encoded dot text, configured paths/queries, extras and episode IDs pass.
      Gates as H3; temporary resource tests removed with their original file hash restored.
      No transport redesign or measured app-latency claim; native playback not checked.

- [x] **UPG-H2: Validate addon identities before publishing the registry.**
  - Evidence: `src-tauri/src/commands/config_commands.rs:65-70` truncated imported IDs;
    `src-tauri/src/commands/config_store/addons.rs:260-270` accepted loaded IDs beyond the
    source-identity bound or equal to the selector's reserved `all` value.
  - **AI notes:**
    - 2026-10-28: Reused Rust's source-ID validator at the shared registry boundary and deleted
      import-time ID truncation. Invalid/reserved IDs use the existing stable opaque URL fallback;
      valid ASCII/Unicode IDs remain unchanged. Three regressions failed before the fixes;
      load/import parity, 256/257-character boundaries and repeat-load stability passed.
      Check (44 UI tests, Clippy), 757 Rust tests, build and diff-check passed after temporary tests
      were removed. README preserved; packaged import/restart and WebView2 not checked.

- [x] **UPG-U2: Keep collection Select all shortcuts aligned with result readiness.**
  - Evidence: `src/components/profile-library-controls.tsx:548-568` let Ctrl+A select stale rows
    while Library, History and list toolbars disabled Select all for pending/failed searches.
  - **AI notes:**
    - 2026-10-28: Button and keyboard selection share one guarded action and each caller's existing
      readiness flag; deleted the duplicate Library handler. The disabled-shortcut regression
      failed before the fix; ready/disabled keyboard and direct actions plus Escape passed.
      Gates as UPG-H2; temporary tests removed, existing UI tests byte-preserved. Native
      WebView2/focus interactions and performance gains not measured.

- [x] **UPG-R1: Keep empty partial resume-rail results provisional.** `[FO4 partial fix]`
  - Evidence: `src/hooks/use-media-library.ts:346-355`; publishing an empty local half ended
    loading and hid the rail while Up Next was still pending, allowing it to reappear later.
  - **AI notes:**
    - 2026-10-28 second pass: Ignore empty channel snapshots; nonempty local rows still appear
      early, and the final result still confirms an empty rail. Two regressions failed before;
      five staged completion/error cases pass. Check (44 UI tests, Clippy), 757 Rust tests,
      build, four-file compiler comparison and diff-check passed. Temporary cases removed.
      No startup reads or IPC changes; FO4 bootstrap/visual measurement remains open.

- [x] **UPG-P2: Retain resume failure protection until playback advances.**
  - Evidence: `src/hooks/use-player-resume-controller.ts:134-140`; a target-position tick
    cleared the seek target before a delayed failed range read could report EOF.
  - **AI notes:**
    - 2026-10-28 second-pass review: Successful resume settlement retains its target; the existing
      advancing-playback callback confirms it. Pending seeks cannot be confirmed early, and
      cancellation/reset still clear them. Paused/unpaused delayed-failure regressions failed
      before and pass after. Gates as UPG-R1; temporary assertions removed, existing confirmation
      expectation updated. Native playback/WebView2 not checked.

- [x] **UPG-H1: Reject overlong resume lookup and source IDs without aliasing.**
  - Evidence: `src-tauri/src/commands/history_helpers.rs:115-126`; 257-character IDs were
    truncated to another valid 256-character identity before persistence.
  - **AI notes:**
    - 2026-10-28: Reused Rust's media/source validators and removed duplicate limits; URL source
      IDs still become opaque before validation. ASCII/Unicode boundary regressions failed before
      and pass after. Check (44 UI tests, Clippy), 757 Rust tests, build and diff-check passed.
      Temporary tests removed; README preserved, native playback/WebView2 not checked.

- [x] **UPG-E1: Preserve valid full-length episode video IDs.**
  - Evidence: `src-tauri/src/commands/episode_navigation.rs:151-158`; a legacy pre-trim guard
    rejected valid 256-character IDs despite strict provider ingress.
  - **AI notes:**
    - 2026-10-28: Removed the redundant guard; the shared validator still rejects overlong IDs.
      ASCII/Unicode/padded boundary regressions pass; updated the existing boundary expectation.
      Gates and native limits as UPG-H1; temporary tests removed.

- [x] **UPG-P1: Keep subtitle delay nudges aligned after cancelled writes.**
  - Evidence: `src/hooks/use-subtitle-adjustments.ts:117-126`; a cancelled 3-second delay write
    left the next positive nudge at 0.1 seconds instead of 3.1.
  - **AI notes:**
    - 2026-10-28: Deleted the duplicate delay ref and reused the live settings ref; Rust still
      normalizes values. Cancellation, normalized replies, rapid nudges and reset ordering pass.
      Gates and native limits as UPG-H1; React Compiler coverage unchanged, temporary tests removed.

- [x] **UPG-D1: Distinguish failed Details Up Next lookup from no successor.** `[third-pass finding]`
  - Evidence: `src/pages/details.tsx:404-431,658-674`; an isolated actual-page render reproduced
    failed lookup and valid empty lookup both becoming "Choose episode", with no targeted retry.
  - Fix/benefit: show a small retry state for this helper only; keep episode selection available and
    preserve genuine no-successor behavior. Do not invalidate/refetch all metadata to retry it.
  - Done: regression covers exhausted error, retry success naming the next episode, and real empty
    result. Rust still chooses the successor; TS only explains and retries the failure.
  - **AI notes:**
    - 2026-10-28: Added the existing compact RetryBanner for this query only. Chromium verified
      exhausted error, retry to Play S1:E2 without a metadata refetch, and genuine empty results;
      episode selection stays available. Check, 757 Rust tests, build and diff-check passed.
      Temporary fixtures removed; live WebView2 not checked.

- [ ] **PX1: Remove hidden native-surface updates during mini-player motion.** `[measure] [native]`
  - Evidence: `src/components/mini-player.tsx:574-603,750-763`;
    `src/hooks/use-player-surface-layout.ts:510-562`.
  - Fix/benefit: suspend the mask while the opaque poster covers drag/snap motion; animate the
    poster, apply the final rectangle, and reveal only after confirmation, as dock entrance does.
  - Done: record margin-IPC counts/frame costs before/after; verify drag, snap, interrupted motion,
    resize, and reduced motion without exposed video, stale holes, or incorrect landing geometry.
  - **AI notes:**
    - 2026-10-28 second pass: Removed the per-frame rect scheduler; drag/snap/resize suspend the
      mask and reuse the existing verified landing/retry path. The cover becomes opaque immediately.
      An isolated real Windows/WebView2/bundled-mpv 30-frame drag fell from 9 to 1 margin IPCs,
      32 to 2 rect callbacks and 3 to 1 mask measurements; motion itself sent no margin IPCs.
      All 14 native scenarios passed, including snap, cancellation, capture loss, resize, delayed
      replies, two injected failures, docking, unmount/remount and reduced motion. Native properties
      matched final content bounds; composed-window and mpv screenshots verified the landing.
      Combined H3/H4/PX1 review reused the resize end-motion handler; mini-player source is 18 lines
      smaller, with unchanged React Compiler coverage. Check (44 UI tests, zero lint warnings,
      Clippy), 757 Rust tests and build passed; temporary probes removed, README/UI tests preserved.
      Packaged-app motion/return-to-player verification remains open, so this task stays unchecked.

- [x] **UPG-T1: Suppress automatic hover trailers during a player session.** `[behavior change]`
  - Evidence: `src/components/media-card.tsx:620-637,683-688` gates on preference/reduced motion,
    but not the persistent session.
  - Fix/benefit: use existing session state in the expanded overlay so browsing with mini playback
    does not start another iframe/video pipeline. Keep static artwork and explicit playback actions.
  - Done: no automatic embed mounts during a session; normal previews return after close; verify
    already-open overlays and reduced motion. Do not subscribe every resting card to playback ticks.
  - **AI notes:**
    - 2026-10-28: Only the expanded overlay reads session presence; disabling previews resets
      dwell/reveal state. Chromium verified an open preview unmounts during a session, returns
      after close, and stays absent with reduced motion. Gates as UPG-D1; native video and
      CPU/GPU savings not measured. Temporary fixtures removed.

- [x] **UX2: Virtualize the Add Titles scroller.** `[measure]`
  - Evidence: `src/components/list/add-titles-dialog.tsx:23,167-230` mounts 150 rows, then 150 more per click.
  - Fix/benefit: reuse the existing virtualizer to bound mounted artwork/controls in large libraries.
    Preserve cumulative Load more, cross-search selection, cached rows on error, and focused-row mounting.
  - Done: compare mounted-row count and open/interaction time on a large fixture; verify keyboard,
    Select all/Clear, search, retry, scroll position, and focus return. No new virtualization dependency.
  - **AI notes:**
    - 2026-10-28: Reused TanStack virtualization and existing focus helpers. In a 5,000-title
      Chromium fixture, mounted rows fell 150→14 initially and 300→20 after Load more; five warmed
      opens had median 119.3→7.6 ms. All titles remained reachable; disabled-row Tab/Shift+Tab,
      identity/focus retention, cumulative paging, selection across search, cached-error retry,
      scroll preservation, close focus and a 390px dialog passed. Gates as UPG-D1; full backend
      snapshots remain unchanged. Temporary fixtures removed; native WebView2 not checked.
    - 2026-10-28 second pass: Removed pending-focus ref/effect and an unnecessary memo; Load more
      scans only the next page and focuses by escaped title ID. A refresh-insertion reproduction
      changed the wrong Title 0149 focus to the intended Title 0150. Disabled pages, special IDs,
      5,000-title reachability and selection/search/error/keyboard checks passed. Check, 757 Rust
      tests, build and diff-check passed; temporary fixtures removed, native WebView2 not checked.

- [x] **UPG-U1: Make automatic update deferral mini-player-aware.** `[third-pass finding] [behavior change]`
  - Evidence: `src/App.tsx:326-337,349-354,402-409` checks `/player`, not the persistent session;
    the actual predicate allows checks/notifications on `/search` during mini playback.
  - Fix/benefit: reuse session presence for automatic deferral and resume due checks after session
    close, even without a route change. Avoid interrupting ongoing viewing; manual checks remain explicit.
  - Done: cover expanded/mini sessions, close on the same route, hidden/offline transitions, and a
    check finishing after playback starts. Preserve one-check deduplication and the existing timer budget.
  - **AI notes:**
    - 2026-10-28: Automatic checks/announcements read current session presence and wake on close.
      Chromium verified mini playback deferral, same-route close, hidden/offline recovery and
      completion after playback starts; close reused that result without another native check.
      Gates as UPG-D1. Temporary fixtures removed; packaged updater/player not exercised.

## Conditional search and startup work

- [x] **FO1: Avoid impossible first-run requests to pinned built-ins.** `[measure]`
  - Evidence: `src-tauri/src/commands/config_store/addons.rs:306-324` seeds unclassified defaults;
    `src-tauri/src/commands/addon_registry.rs:335-367` routes catalogs to unclassified addons.
  - Fix/benefit: seed the pinned subtitle-only default's verified capabilities, avoiding impossible
    catalog requests before classification. Keep fail-open handling for unknown third parties.
  - Done: compare clean-profile request count/time to first results; retain manifest refresh and
    user toggles. Drop if classification already wins and no meaningful waste remains.
  - **AI notes:**
    - 2026-10-28: Live manifests verified; seeded only OpenSubtitles, since Cinemeta had no
      impossible catalog requests. Production Rust routing reduced clean-profile movie+series
      browse/search work from 4 requests to 2. Fresh-client live browse samples: 429/168/162 ms
      before, 179/177/180 ms after; no consistent latency gain claimed. Unknown-addon routing,
      subtitle support, reload identity and disabled toggles passed; startup refresh retained.
      Identity-only reads still omit capabilities. Gates as UPG-D1; temporary tests removed.

- [ ] **FO2: Measure the All-browse join before adding progressive delivery.** `[measure] [decision: delivery]`
  - Evidence: `src-tauri/src/commands/search_commands.rs:948-961` joins movie and series before returning.
  - Fix/benefit: if this join materially delays first paint, expose ready results while the other
    branch completes. Reuse existing delivery patterns; preserve both cursors, source claims, dedupe, and ordering.
  - Done: asymmetric fast/slow/error fixtures show a first-result gain without missing/duplicated
    titles, replay loops, or worse continuation behavior. Agree IPC delivery before changing contracts.
  - **AI notes:**
    - 2026-10-28: Five fresh-client live Cinemeta runs through the production Rust browse branches:
      movie 239/158/161/155/146 ms, series 268/169/192/169/166 ms; the join held ready results
      29/11/31/14/20 ms (median 20 ms). Each merged 99 items without partial failure. This does not
      establish a material first-paint gain; progressive delivery remains deferred with IPC/cursors
      unchanged. Temporary measurement removed; app paint and asymmetric failure delivery not measured.

- [ ] **P4: Move cosmetic subtitle writes off the pre-load path only if safe.** `[blocked: first-cue check] [measure] [native]`
  - Evidence: `src/hooks/use-player-mpv-lifecycle.ts:842-858`; nine appearance writes precede `loadfile`.
  - Fix/benefit: test applying appearance immediately after `loadfile` so media loading starts earlier.
    Keep headers, required audio settings, and pause ownership in their correct order.
  - Done: measure time to `loadfile`/first frame; first cues are styled on cold start and replacement;
    authored ASS styling survives. No native proof or no meaningful gain means leave this unchanged.
  - **AI notes:**
    - 2026-10-29: Bundled mpv v0.41.0-157-gdb22a4528/wrapper, headless idle cores
      (`config=no`, `vo=null`, `ao=null`): nine appearance writes took median 0.7174 ms across
      41 fresh handles and 0.3945 ms across 121 warmed samples; p95 1.9158/0.5929 ms.
      Alternating default/box styles passed native property readback. This excludes Tauri IPC,
      `loadfile`, first frame and first-cue/ASS rendering; no material startup gain established.
      Preserve pre-load ordering and the first-cue gate. One existing batched IPC, not nine.
      Initial probe attempts failed on an unsupported read format and float precision; the corrected
      probe passed and was removed. Results: `%TEMP%\stremiro-p4-second-pass.json`.

## Installed-build completion gates

- [ ] **DL1: Verify installed deep links end to end.** `[native]`
  - Evidence: `src-tauri/windows/installer-hooks.nsh`; `.dev/cleanup_tracker.md` records installed checks as open.
  - Done: cold/running/tray-hidden title and addon links from Chrome/Edge/Firefox; addon links only
    prefill setup, never auto-install; uninstall removes registration and updater reinstall retains it.
  - **AI notes:** Pending. Parser/unit success does not verify Windows registration.

- [ ] **UPG-QA1: Run the packaged critical-flow matrix.** `[verification only] [native]`
  - Evidence: `.dev/CLEANUP_LOG.md:15-25` records outstanding interactive checks after recent fixes.
  - Done: player cold start, resume/failed seek, stream replacement, manual subtitles/Off, mini drag
    and return, tray hide/restore, and quit during a pending write; verify persisted progress after restart.
  - Done: Search typing/composition plus immediate facets, overlapping-source pagination, partial
    errors/offline recovery, and grid keyboard navigation; Details placeholder/full metadata,
    Back/Forward season/page restoration, explicit episode links, spoilers, completion, and retries.
  - Record build/runtime, fixture, result, and any blocker. Do not touch real user data for destructive tests.
  - **AI notes:**
    - 2026-10-29: Available release executable is dated 2026-10-27, before the latest fixes;
      it cannot validate this workspace's packaged behavior. The desktop automation driver is
      absent too. Require a fresh package and isolated-profile interactive testing; no installation,
      registry changes or real-user-data tests attempted. These remain validation gaps, not defects.

## Third-pass disposition

- Reviewed player lifecycle/resume/recovery, search state/cursors, Details loading/episode actions,
  prefetch/query defaults, and update/persistence boundaries. New scoped findings: UPG-D1 and UPG-U1.
- P9 subtitle HTTP isolation, PTRACK track guards, PRESUME1 failed-seek handling, SFLT1 overlap
  ownership, and SFLT2 facet commits already have fixes. Preserve them rather than restarting those tasks.
- Keep single-flight/cache generations, leaf playback-clock subscriptions, current media cache/probe
  budgets, and the Rust/TS split. Context-menu is still used by the player; do not remove its dependency.
- No blanket memo removal, unmeasured cache shrinking, crate/hook rewrites, or speculative TS-to-Rust
  ports. UX3/UX7 and other visual preferences are not promoted into release blockers here.
- This pass changed only this document. The corrected isolated Details fixture and update predicate
  check passed. Initial fixture attempts timed out/needed retry-on-mount correction; they were not app
  test regressions. Native/visual/performance gates remain open; earlier full-suite passes are not new runs.

## Follow-up review, 2026-10-28

- Reviewed both follow-up passes and the combined workspace diff for correctness, reuse and efficiency.
  UPG-R1 fixes only FO4's intermediate collapse; bootstrap still contains preferences only, so adding
  history reads needs startup/visual evidence. No progressive search, lazy Settings or native-surface
  redesign was justified by the available gates.
- UPG-P2 resolves the one actionable combined-review finding. First-pass ID validation and subtitle
  nudges remain unchanged. All automated gates passed again; README hash preserved. Temporary tests
  were removed. Installed-build, live playback and WebView2 checks remain open.
- Reviewed UPG-H2/UPG-U2 and RC1 together: shared ID validation, selection readiness/Escape,
  store gate/deadline lifetimes, tray/frontend close barriers and updater preflush remain consistent.
  No new dependencies, IPC contracts or persisted formats. Check, 757 Rust tests, build and
  diff-check passed again; README and existing UI tests byte-preserved. RC1's packaged gate and
  the other native/provenance/design/measurement tasks remain open.
- Audited addon transport/cache and resource routing, list persistence, preferences, avatar/update/
  calendar validation, player resume/subtitle ownership and adjacent menu/selector UI. H3/H4 were
  the new reproduced defects; no additional high-confidence frontend fix justified a change.
  Native/provenance blockers, parked transport work and measurement/visual decisions stay open.
- Reviewed H3/H4 and the second-pass PX1 change together: catalog/cache/cursor identities,
  resource encoding, motion generations, stale replies, retries and resize ownership stay consistent.
  No new policy, dependency or IPC contract; the remaining list still needs its recorded
  packaged, trust-store, provenance, measurement or visual-decision gates.
- 2026-10-29: Reviewed H7-H9 through manifest normalization, stored classification, refresh merging
  and frontend invalidation, plus exit/write barriers and the tracker benefit claims. Retained the
  direct validators; H10 removes redundant refresh work and fixes failed-save notification loss.
  Recorded workload gains do not establish an overall startup, FPS, RAM or failure-rate improvement.
- 2026-10-29 second pass: Rechecked RC1 admission/deadlines, UPG-L1 scopes/write barriers,
  UPG-P4/P5 pending intent, UPG-L2 selected reads and H10-H12/U4 projection/cache behavior.
  Only export's redundant capability decoding warranted a change; no new policy, dependency,
  IPC contract or persisted-format change. Check (44 UI tests, Clippy), 757 Rust tests, build and
  diff-check passed after temporary probes were removed; README/existing UI tests byte-preserved.
  Existing Babel build-timing notice remains. Live addon, packaged/native, provenance and visual
  gates remain open; these checks do not establish total export or app-latency gains.
- 2026-10-29 final checkpoint: Reviewed every remaining item's completion gate; measured P4's
  native writes without changing startup policy. Current Settings chunk is 86,856 bytes, but UX3
  still lacks a measured lazy-loading benefit and approved fallback; FO4 lacks startup/visual proof.
  No further app changes justified. Documentation formatting/diff checks passed; 57 saved baseline
  files remain byte-identical, including README and existing UI tests. Prior full app gates above
  were not rerun for this documentation-only pass; native/security gates remain open.
