# Local libmpv safety patch

This is the Rust source of crates.io `tauri-plugin-libmpv` 0.3.2, upstream
revision `5da4e044c276245dcfd8a279310e5106394a0679`, under MPL-2.0.
The upstream license, Rust API and native wrapper ABI are unchanged.
Only Rust sources, the build manifest and license documentation
are retained; upstream JavaScript tooling and lockfiles are not needed here.

Local changes:

- Load only the bundled wrapper beside the executable or in its `lib` directory.
- Stop event forwarding after teardown instead of draining discarded events.
- Consume owned property names and formats directly when building C strings.
- Return the initialized window label without allocating it again.
- Free failed initialization userdata as its actual `EventUserData` type.
- Clone event ownership before spawning work, so queued events cannot borrow
  userdata freed by teardown.
- Filter unused event kinds through a borrowed header and emit retained JSON
  verbatim with `emit_str_to`, preserving teardown serialization.
- Hold the instance mutex through synchronous native destruction, preventing
  overlapping destruction and replacement initialization; share poison recovery.
- Leave close requests to the app's save-and-teardown barrier; clean up on
  actual window destruction or application exit instead of racing a veto.
- Reject null property responses before registering their free operation,
  and avoid cloning property names on each native read or option maps at init.
- Resolve the embedding window handle before taking the instance mutex (the
  getter blocks on the event loop, whose destroyed handler takes that mutex),
  and fail initialization instead of opening an unembedded mpv window when the
  handle is unavailable.
- Validate init config before `mpv_wrapper_create` — option/property name
  grammar, scalar option values, and the wrapper's observed-property format
  set — so malformed payloads fail fast instead of wedging the unchanged
  wrapper DLL, whose negative init path hangs. Semantic option validity
  (real mpv option names) remains the caller's responsibility.
- Bound `RunEvent::Exit` teardown: a wedged native call holds the instance
  lock forever, and the event-loop exit handler must not block on it; skip
  after a short budget — process teardown reclaims native handles.
- Detach event-loop destruction onto an `mpv-destroy` thread with one total
  wait budget; retain the native handle, userdata and DLL until destroy returns.
- Return the real message in `get_wid`'s fallback `UnsupportedPlatform` error
  instead of an empty string.
- Drop the unused `base64` dependency.
- Remove the unused app handle and runtime generic from callback userdata.
- Apply video margins under one instance lock; skip unchanged sides, cache each
  successful write per instance and retry failures through the shared native setter.
- Keep command arguments and property values out of trace logs, since they
  can contain signed URLs or authorization headers.
- Remove raw plugin IPC and permissions: the app owns every native operation
  through bounded, window-bound commands; the plugin still supplies native
  methods and frontend events.
- Remove mobile wiring and non-Windows wrapper names; this fork targets Windows only.

The app selects this source with `[patch.crates-io]`. Keep the existing 0.3.2
JavaScript package and native DLL pair. Remove this override only after a
compatible upstream release includes these fixes and passes native checks.

Native validation used the staged DLL pair without touching app data.
Valid headless initialization/destruction passed with a live callback;
invalid-option initialization hung inside the unchanged wrapper DLL.
The app's single native-operation gate bounds callers and prevents blocked
thread accumulation, but cannot interrupt a running FFI call.
