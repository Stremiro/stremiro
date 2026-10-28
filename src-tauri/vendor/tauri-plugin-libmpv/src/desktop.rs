use log::{error, info, trace, warn};
use once_cell::sync::OnceCell;
use raw_window_handle::HasWindowHandle;
use scopeguard::defer;
use serde::de::DeserializeOwned;
use std::borrow::Cow;
use std::collections::HashMap;
use std::ffi::{c_char, c_void, CStr, CString};
use std::path::PathBuf;
use std::sync::{mpsc, Arc, Mutex};
use tauri::Emitter;
use tauri::{plugin::PluginApi, AppHandle, Manager, Runtime};

use crate::models::*;
use crate::utils::get_wid;
use crate::wrapper::LibmpvWrapper;
use crate::Error;
use crate::Result;

/// mpv option names are ASCII alnum with `-`/`_` separators; observed property
/// paths additionally allow `/` (e.g. `current-tracks/audio/id`). The native
/// wrapper wedges instead of reporting an error when `mpv_wrapper_create`
/// receives malformed input, so the whole init payload is checked before the
/// FFI call. Semantic validity (real mpv option names) is the caller's
/// responsibility.
fn valid_mpv_option_name(name: &str) -> bool {
    let mut chars = name.chars();
    chars.next().is_some_and(|c| c.is_ascii_alphanumeric())
        && chars.all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
}

fn valid_observed_property_name(name: &str) -> bool {
    let mut chars = name.chars();
    chars.next().is_some_and(|c| c.is_ascii_alphanumeric())
        && chars.all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '/'))
}

/// Property formats the wrapper accepts for observation.
const OBSERVED_PROPERTY_FORMATS: &[&str] = &["string", "flag", "int64", "double", "node"];

pub fn validate_mpv_config(mpv_config: &MpvConfig) -> Result<()> {
    for (name, value) in &mpv_config.initial_options {
        if !valid_mpv_option_name(name) {
            return Err(Error::InvalidConfig(format!(
                "invalid option name '{name}'"
            )));
        }
        let scalar = match value {
            serde_json::Value::String(_) | serde_json::Value::Bool(_) => true,
            serde_json::Value::Number(number) => number.as_f64().is_none_or(f64::is_finite),
            _ => false,
        };
        if !scalar {
            return Err(Error::InvalidConfig(format!(
                "option '{name}' requires a scalar value"
            )));
        }
    }
    for (name, format) in &mpv_config.observed_properties {
        if !valid_observed_property_name(name) {
            return Err(Error::InvalidConfig(format!(
                "invalid observed property name '{name}'"
            )));
        }
        if !OBSERVED_PROPERTY_FORMATS.contains(&format.as_str()) {
            return Err(Error::InvalidConfig(format!(
                "observed property '{name}' has unsupported format '{format}'"
            )));
        }
    }
    Ok(())
}

pub fn init<R: Runtime, C: DeserializeOwned>(
    app: &AppHandle<R>,
    _api: PluginApi<R, C>,
) -> crate::Result<Mpv<R>> {
    info!("Plugin registered.");
    let mpv = Mpv {
        app: app.clone(),
        instances: Mutex::new(HashMap::new()),
        wrapper: OnceCell::new(),
    };
    Ok(mpv)
}

pub struct Mpv<R: Runtime> {
    app: AppHandle<R>,
    pub instances: Mutex<HashMap<String, MpvInstance>>,
    pub wrapper: OnceCell<Arc<LibmpvWrapper>>,
}

pub unsafe extern "C" fn event_callback(event: *const c_char, userdata: *mut c_void) {
    if event.is_null() || userdata.is_null() {
        return;
    }

    let EventUserData {
        free_fn,
        event_sender,
        ..
    } = unsafe { &*(userdata as *const EventUserData) };

    let event_string = unsafe { CStr::from_ptr(event).to_string_lossy().into_owned() };

    unsafe {
        free_fn(event as *mut c_char);
    }

    // The native event-listener thread must not wait for frontend delivery.
    let _ = event_sender.send(event_string);
}

const FRONTEND_EVENTS: &[&str] = &[
    "seek",
    "playback-restart",
    "file-loaded",
    "audio-reconfig",
    "video-reconfig",
    "property-change",
];

#[derive(serde::Deserialize)]
struct EventHeader<'a> {
    #[serde(borrow)]
    event: Cow<'a, str>,
}

fn forward_events(
    receiver: mpsc::Receiver<String>,
    alive: &Mutex<bool>,
    mut emit: impl FnMut(String),
) {
    for event_string in receiver {
        // Serialize emission with teardown, not just an alive check before emit.
        let alive = alive
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        if !*alive {
            break;
        }
        let should_emit = match serde_json::from_str::<EventHeader<'_>>(&event_string) {
            Ok(event) => FRONTEND_EVENTS.contains(&event.event.as_ref()),
            Err(e) => {
                error!("Failed to deserialize mpv FFI event: {}", e);
                false
            }
        };
        if should_emit {
            emit(event_string);
        }
    }
}

impl<R: Runtime> Mpv<R> {
    pub fn init(&self, mpv_config: MpvConfig, window_label: &str) -> Result<String> {
        self.init_wid_mode(mpv_config, window_label)
    }

    fn init_wid_mode(&self, mpv_config: MpvConfig, window_label: &str) -> Result<String> {
        let app = self.app.clone();

        validate_mpv_config(&mpv_config)?;

        let wrapper = self.get_wrapper()?;

        let free_fn = wrapper.mpv_wrapper_free;

        let mut initial_options = mpv_config.initial_options;

        let audio_only = initial_options.iter().any(|(key, value)| {
            (key == "video" && (value == "no" || value == false))
                || (key == "vid" && (value == "no" || value == false))
        });

        if audio_only {
            info!(
                "Audio-only mode detected for window '{}'. Skipping window embedding.",
                window_label
            );
        }

        // Resolve the handle before taking the instance lock: the getter blocks on
        // the event loop, whose window-destroyed handler also takes that lock.
        if !audio_only && !initial_options.contains_key("wid") {
            let window = self
                .app
                .get_webview_window(window_label)
                .ok_or_else(|| crate::Error::WindowNotFound(window_label.to_string()))?;
            let window_handle = window.window_handle()?;
            let wid = get_wid(window_handle.as_raw())?;
            initial_options.insert("wid".to_string(), serde_json::json!(wid));
        }

        let Some(mut instances_lock) = self.lock_and_check_existence(window_label)? else {
            return Ok(window_label.to_string());
        };
        if self.app.get_webview_window(window_label).is_none() {
            return Err(crate::Error::WindowNotFound(window_label.to_string()));
        }

        let initial_options_string = serde_json::to_string(&initial_options)?;
        let observed_properties_string = serde_json::to_string(&mpv_config.observed_properties)?;

        let c_initial_options = CString::new(initial_options_string)?;
        let c_observed_properties = CString::new(observed_properties_string)?;

        let (event_sender, event_receiver) = mpsc::channel();
        let event_alive = Arc::new(Mutex::new(true));
        let event_callback_data = Box::new(EventUserData {
            free_fn,
            event_sender,
            event_alive: Arc::clone(&event_alive),
        });
        let event_userdata = Box::into_raw(event_callback_data) as *mut c_void;

        let mpv_handle = unsafe {
            wrapper.mpv_wrapper_create(
                c_initial_options.as_ptr(),
                c_observed_properties.as_ptr(),
                Some(event_callback),
                event_userdata,
            )
        };

        if mpv_handle.is_null() {
            let _ = unsafe { Box::from_raw(event_userdata as *mut EventUserData) };
            return Err(crate::Error::CreateInstance);
        }

        let window_label_owned = window_label.to_string();
        tauri::async_runtime::spawn_blocking(move || {
            let event_name = format!("mpv-event-{}", window_label_owned);
            forward_events(event_receiver, &event_alive, |event| {
                if let Err(e) = app.emit_str_to(&window_label_owned, &event_name, event) {
                    error!("Failed to emit mpv event to frontend: {}", e);
                }
            });
        });

        info!("mpv instance initialized for window '{}'.", window_label);

        let instance = MpvInstance {
            handle: mpv_handle,
            event_userdata: event_userdata,
            last_video_margins: [None; 4],
        };

        instances_lock.insert(window_label.to_string(), instance);

        info!("Wid mode initialized for window '{}'.", window_label);

        Ok(window_label.to_string())
    }

    pub fn destroy(&self, window_label: &str) -> Result<()> {
        let mut instances_lock = self.lock_instances();
        if let Some(instance) = instances_lock.remove(window_label) {
            Self::destroy_instance(instance, self.get_wrapper()?, window_label);
        } else {
            trace!(
                "No running mpv instance found for window '{}' to destroy.",
                window_label
            );
        }
        Ok(())
    }

    /// Bound the total event-loop wait, including instance locking and native teardown.
    pub fn destroy_bounded(&self, window_label: &str, budget: std::time::Duration) -> Result<()> {
        let started = std::time::Instant::now();
        let Some(mut instances_lock) = self.lock_instances_bounded(budget) else {
            warn!(
                "Skipped mpv destroy for '{}': the instance lock is held by a wedged call.",
                window_label
            );
            return Ok(());
        };
        let Some(instance) = instances_lock.remove(window_label) else {
            trace!(
                "No running mpv instance found for window '{}' to destroy.",
                window_label
            );
            return Ok(());
        };
        let wrapper = Arc::clone(self.get_wrapper()?);
        let label = window_label.to_string();
        let (completed, completion) = mpsc::channel();
        if let Err(error) = std::thread::Builder::new()
            .name("mpv-destroy".into())
            .spawn(move || {
                Self::destroy_instance(instance, &wrapper, &label);
                let _ = completed.send(());
            })
        {
            instances_lock.insert(window_label.to_string(), instance);
            return Err(error.into());
        }
        drop(instances_lock);

        match completion.recv_timeout(budget.saturating_sub(started.elapsed())) {
            Ok(()) => {}
            Err(mpsc::RecvTimeoutError::Timeout) => warn!(
                "Timed out waiting for mpv destroy for '{}'; native teardown continues.",
                window_label
            ),
            Err(mpsc::RecvTimeoutError::Disconnected) => {
                return Err(Error::Destroy("Native teardown thread stopped.".into()));
            }
        }
        Ok(())
    }

    fn destroy_instance(instance: MpvInstance, wrapper: &LibmpvWrapper, window_label: &str) {
        let event_data = unsafe { &*(instance.event_userdata as *const EventUserData) };
        *event_data
            .event_alive
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner()) = false;

        unsafe {
            wrapper.mpv_wrapper_destroy(instance.handle);
        }

        // Callback userdata must outlive native destroy, even if its caller times out.
        let _ = unsafe { Box::from_raw(instance.event_userdata as *mut EventUserData) };

        info!(
            "mpv instance for window '{}' has been destroyed.",
            window_label,
        );
    }

    pub fn command(
        &self,
        name: &str,
        args: &Vec<serde_json::Value>,
        window_label: &str,
    ) -> Result<()> {
        trace!("COMMAND '{}'", name);

        self.with_instance(window_label, |instance| {
            let wrapper = self.get_wrapper()?;

            let args_string = serde_json::to_string(&args)?;

            let c_name = CString::new(name)?;
            let c_args = CString::new(args_string)?;

            let result_ptr = unsafe {
                wrapper.mpv_wrapper_command(instance.handle, c_name.as_ptr(), c_args.as_ptr())
            };

            if result_ptr.is_null() {
                return Err(crate::Error::FFI("Call returned null pointer".into()));
            }

            defer! {
                unsafe { wrapper.mpv_wrapper_free(result_ptr) };
            }

            let response_str = unsafe { CStr::from_ptr(result_ptr).to_string_lossy() };
            let response: FfiResponse = serde_json::from_str(&response_str)?;

            if let Some(err) = response.error {
                Err(crate::Error::Command {
                    window_label: window_label.to_string(),
                    message: err,
                })
            } else {
                Ok(())
            }
        })
    }

    pub fn set_property(
        &self,
        name: &str,
        value: &serde_json::Value,
        window_label: &str,
    ) -> crate::Result<()> {
        self.with_instance(window_label, |instance| {
            self.set_property_locked(instance, name, value, window_label)
        })
    }

    fn set_property_locked(
        &self,
        instance: &MpvInstance,
        name: &str,
        value: &serde_json::Value,
        window_label: &str,
    ) -> crate::Result<()> {
        trace!("SET PROPERTY '{}'", name);

        let wrapper = self.get_wrapper()?;

        let value_string = serde_json::to_string(value)?;

        let c_name = CString::new(name)?;
        let c_value = CString::new(value_string)?;

        let result_ptr = unsafe {
            wrapper.mpv_wrapper_set_property(instance.handle, c_name.as_ptr(), c_value.as_ptr())
        };

        if result_ptr.is_null() {
            return Err(crate::Error::FFI("Call returned null pointer".into()));
        }

        defer! {
            unsafe { wrapper.mpv_wrapper_free(result_ptr) };
        }

        let response_str = unsafe { CStr::from_ptr(result_ptr).to_string_lossy() };
        let response: FfiResponse = serde_json::from_str(&response_str)?;

        if let Some(err) = response.error {
            Err(crate::Error::SetProperty {
                window_label: window_label.to_string(),
                message: err,
            })
        } else {
            Ok(())
        }
    }

    pub fn get_property(
        &self,
        name: String,
        format: String,
        window_label: &str,
    ) -> crate::Result<serde_json::Value> {
        self.with_instance(window_label, |instance| {
            let wrapper = self.get_wrapper()?;

            trace!("GET PROPERTY '{}'", name);
            let c_name = CString::new(name)?;
            let c_format = CString::new(format)?;

            let result_ptr = unsafe {
                wrapper.mpv_wrapper_get_property(
                    instance.handle,
                    c_name.as_ptr(),
                    c_format.as_ptr(),
                )
            };

            if result_ptr.is_null() {
                return Err(crate::Error::GetProperty {
                    window_label: window_label.to_string(),
                    message: "FFI call returned null pointer".into(),
                });
            }

            defer! {
                unsafe { wrapper.mpv_wrapper_free(result_ptr) };
            }

            let response_str = unsafe { CStr::from_ptr(result_ptr).to_string_lossy() };

            let response: FfiResponse = serde_json::from_str(&response_str)?;

            if let Some(err) = response.error {
                return Err(crate::Error::GetProperty {
                    window_label: window_label.to_string(),
                    message: err,
                });
            }

            let value = response.data.ok_or_else(|| crate::Error::GetProperty {
                window_label: window_label.to_string(),
                message: "FFI response contained no data".to_string(),
            })?;

            Ok(value)
        })
    }

    pub fn set_video_margin_ratio(
        &self,
        ratio: VideoMarginRatio,
        window_label: &str,
    ) -> Result<()> {
        trace!("SET VIDEO MARGIN RATIO '{:?}'", ratio);

        let margins = [
            ("video-margin-ratio-left", ratio.left),
            ("video-margin-ratio-right", ratio.right),
            ("video-margin-ratio-top", ratio.top),
            ("video-margin-ratio-bottom", ratio.bottom),
        ];

        if margins.iter().all(|(_, value)| value.is_none()) {
            return Ok(());
        }

        self.with_instance(window_label, |instance| {
            for (index, (property, value)) in margins.into_iter().enumerate() {
                if let Some(value) = value {
                    if instance.last_video_margins[index] == Some(value) {
                        continue;
                    }
                    self.set_property_locked(
                        instance,
                        property,
                        &serde_json::json!(value),
                        window_label,
                    )?;
                    instance.last_video_margins[index] = Some(value);
                }
            }
            Ok(())
        })
    }

    fn lock_and_check_existence<'a>(
        &'a self,
        window_label: &str,
    ) -> Result<Option<std::sync::MutexGuard<'a, HashMap<String, MpvInstance>>>> {
        let instances_lock = self.lock_instances();

        if instances_lock.contains_key(window_label) {
            info!(
                "mpv instance for window '{}' already exists. Skipping initialization.",
                window_label
            );
            Ok(None)
        } else {
            Ok(Some(instances_lock))
        }
    }

    fn with_instance<F, T>(&self, window_label: &str, operation: F) -> Result<T>
    where
        F: FnOnce(&mut MpvInstance) -> Result<T>,
    {
        let mut instances_lock = self.lock_instances();

        let instance = instances_lock.get_mut(window_label).ok_or_else(|| {
            crate::Error::InstanceNotFound(format!(
                "mpv instance for window label '{}' not found",
                window_label
            ))
        })?;

        operation(instance)
    }

    fn lock_instances(&self) -> std::sync::MutexGuard<'_, HashMap<String, MpvInstance>> {
        match self.instances.lock() {
            Ok(guard) => guard,
            Err(poisoned) => {
                warn!("Mutex was poisoned, recovering.");
                poisoned.into_inner()
            }
        }
    }

    /// Bounded lock acquisition for event-loop callers: the unbounded `lock`
    /// in `lock_instances` is correct on IPC paths (the caller can time out
    /// and leave the blocking thread parked), but the event loop must never
    /// park on a wedged native call.
    fn lock_instances_bounded(
        &self,
        budget: std::time::Duration,
    ) -> Option<std::sync::MutexGuard<'_, HashMap<String, MpvInstance>>> {
        let deadline = std::time::Instant::now() + budget;
        loop {
            match self.instances.try_lock() {
                Ok(guard) => return Some(guard),
                Err(std::sync::TryLockError::Poisoned(poisoned)) => {
                    warn!("Mutex was poisoned, recovering.");
                    return Some(poisoned.into_inner());
                }
                Err(std::sync::TryLockError::WouldBlock) => {
                    if std::time::Instant::now() >= deadline {
                        return None;
                    }
                    std::thread::sleep(std::time::Duration::from_millis(20));
                }
            }
        }
    }

    fn get_wrapper(&self) -> Result<&Arc<LibmpvWrapper>> {
        self.wrapper.get_or_try_init(|| {
            info!("libmpv-wrapper not initialized. Trying to load libmpv-wrapper now...");

            let lib_name = "libmpv-wrapper.dll";

            let mut search_dirs: Vec<PathBuf> = Vec::new();
            if let Ok(exe_path) = std::env::current_exe() {
                if let Some(exe_dir) = exe_path.parent() {
                    search_dirs.push(exe_dir.to_path_buf());
                    search_dirs.push(exe_dir.join("lib"));
                }
            }

            let valid_lib_path: String = search_dirs
                .iter()
                .map(|dir| dir.join(lib_name))
                .find(|path| path.exists())
                .map(|path| path.to_string_lossy().into_owned())
                .ok_or_else(|| {
                    Error::FFI(format!(
                        "Bundled {lib_name} not found beside the executable or in its lib directory"
                    ))
                })?;

            info!("Attempting to load libmpv-wrapper from: {}", valid_lib_path);
            let result = unsafe { LibmpvWrapper::new(&valid_lib_path) };

            match result {
                Ok(wrapper) => {
                    info!("Successfully loaded libmpv-wrapper.");
                    Ok(Arc::new(wrapper))
                }
                Err(e) => Err(Error::FFI(format!(
                    "Failed to load libmpv-wrapper from '{}'. Error: {:?}",
                    valid_lib_path, e
                ))
                .into()),
            }
        })
    }
}
