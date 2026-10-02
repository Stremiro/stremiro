# Local libmpv safety patch

This is the Rust source of crates.io `tauri-plugin-libmpv` 0.3.2, upstream
revision `5da4e044c276245dcfd8a279310e5106394a0679`, under MPL-2.0.
The upstream license, Rust API and native wrapper ABI are unchanged.
Only Rust sources, the build manifest and license documentation
are retained; upstream JavaScript tooling and lockfiles are not needed here.

Local changes:

- Free failed initialization userdata as its actual `EventUserData<R>` type.
- Clone event ownership before spawning work, so queued events cannot borrow
  userdata freed by teardown.
- Hold the instance mutex through native destruction, preventing overlapping
  destruction and replacement initialization; share poison recovery.
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
- Return the real message in `get_wid`'s fallback `UnsupportedPlatform` error
  instead of an empty string.
- Drop the unused `base64` dependency.
- Keep command arguments and property values out of trace logs, since they
  can contain signed URLs or authorization headers.
- Remove raw plugin IPC and permissions: the app owns every native operation
  through bounded, window-bound commands; the plugin still supplies native
  methods and frontend events.
- Remove the Android/iOS module, `cfg(mobile)`/`cfg(desktop)` gates, the
  mobile-only plugin error variant and the build script's mobile source paths:
  the app targets Windows only. (Upstream `mobile.rs` also referenced model
  types that no longer exist, so it could not compile anyway.)

The app selects this source with `[patch.crates-io]`. Keep the existing 0.3.2
JavaScript package and native DLL pair. Remove this override only after a
compatible upstream release includes these fixes and passes native checks.

Native validation used the staged DLL pair without touching app data.
Valid headless initialization/destruction passed with a live callback;
invalid-option initialization hung inside the unchanged wrapper DLL.
The app's single native-operation gate bounds callers and prevents blocked
thread accumulation, but cannot interrupt a running FFI call.
