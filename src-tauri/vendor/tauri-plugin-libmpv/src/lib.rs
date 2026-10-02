use tauri::{
    plugin::{Builder, TauriPlugin},
    Manager, RunEvent, Runtime, WindowEvent,
};

pub use models::*;

// Desktop-only build: the app targets Windows, so the upstream Android/iOS
// plugin module and `cfg(mobile)` wiring are removed.
mod desktop;
mod wrapper;

mod error;
mod models;
mod utils;

pub use error::{Error, Result};

pub use desktop::validate_mpv_config;
use desktop::Mpv;

pub trait MpvExt<R: Runtime> {
    fn mpv(&self) -> &Mpv<R>;
}

impl<R: Runtime, T: Manager<R>> crate::MpvExt<R> for T {
    fn mpv(&self) -> &Mpv<R> {
        self.state::<Mpv<R>>().inner()
    }
}

pub fn init<R: Runtime>() -> TauriPlugin<R> {
    Builder::new("libmpv")
        .setup(|app, api| {
            unsafe {
                let locale = std::ffi::CString::new("C").unwrap();
                libc::setlocale(libc::LC_NUMERIC, locale.as_ptr());
            }

            let mpv = desktop::init(app, api)?;
            app.manage(mpv);
            Ok(())
        })
        .on_event(|app_handle, run_event| {
            if let RunEvent::WindowEvent {
                label,
                event: WindowEvent::Destroyed,
                ..
            } = run_event
            {
                // CloseRequested may still be vetoed by the app's save barrier.
                // Normal close destroys mpv first; this handles forced window
                // destruction. The bounded wait keeps a wedged native call from
                // freezing the event loop — process teardown reclaims the handle.
                if let Err(error) = app_handle
                    .mpv()
                    .destroy_bounded(label, std::time::Duration::from_secs(3))
                {
                    log::error!("Failed to destroy mpv for '{}': {}", label, error);
                }
            } else if matches!(run_event, RunEvent::Exit) {
                let mpv_state = app_handle.state::<Mpv<R>>();
                let labels: Vec<String> = {
                    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(2);
                    let collected = loop {
                        match mpv_state.instances.try_lock() {
                            Ok(guard) => break Some(guard.keys().cloned().collect()),
                            Err(std::sync::TryLockError::Poisoned(poisoned)) => {
                                break Some(poisoned.into_inner().keys().cloned().collect())
                            }
                            Err(std::sync::TryLockError::WouldBlock) => {
                                if std::time::Instant::now() >= deadline {
                                    break None;
                                }
                                std::thread::sleep(std::time::Duration::from_millis(20));
                            }
                        }
                    };
                    match collected {
                        Some(labels) => labels,
                        // A wedged native call holds the lock forever; exit anyway.
                        None => return,
                    }
                };
                for label in labels {
                    if let Err(error) =
                        mpv_state.destroy_bounded(&label, std::time::Duration::from_secs(2))
                    {
                        log::error!("Failed to destroy mpv on exit for '{}': {}", label, error);
                    }
                }
            }
        })
        .build()
}
