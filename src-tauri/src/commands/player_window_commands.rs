use tauri::{
    Manager, Monitor, PhysicalPosition, PhysicalSize, State, Window, WindowSizeConstraints,
};

struct WindowPlacement {
    position: PhysicalPosition<i32>,
    size: PhysicalSize<u32>,
    maximized: bool,
    always_on_top: bool,
    resizable: bool,
    maximizable: bool,
}

#[derive(Default)]
pub(crate) struct PlayerPipState(tokio::sync::Mutex<Option<WindowPlacement>>);

fn pip_size(work_size: PhysicalSize<u32>, scale: f64) -> PhysicalSize<u32> {
    let (min, max) = pip_limits(work_size, scale);
    let width = (440.0 * scale)
        .min(f64::from(work_size.width) * 0.4)
        .max(f64::from(min.width))
        .min(f64::from(max.width))
        .min(f64::from(max.height) * 16.0 / 9.0)
        .max(1.0);
    PhysicalSize::new(
        width.round() as u32,
        (width * 9.0 / 16.0).round().max(1.0) as u32,
    )
}

fn pip_limits(work_size: PhysicalSize<u32>, scale: f64) -> (PhysicalSize<u32>, PhysicalSize<u32>) {
    let max = PhysicalSize::new(
        (720.0 * scale).min((f64::from(work_size.width) - 32.0 * scale).max(1.0)) as u32,
        (480.0 * scale).min((f64::from(work_size.height) - 32.0 * scale).max(1.0)) as u32,
    );
    let min_width = (320.0 * scale)
        .min(f64::from(max.width))
        .min(f64::from(max.height) * 16.0 / 9.0)
        .max(1.0)
        .round() as u32;
    (
        PhysicalSize::new(
            min_width,
            (f64::from(min_width) * 9.0 / 16.0).round().max(1.0) as u32,
        ),
        max,
    )
}

fn pip_corner(
    origin: PhysicalPosition<i32>,
    area: PhysicalSize<u32>,
    outer: PhysicalSize<u32>,
    scale: f64,
) -> PhysicalPosition<i32> {
    let gap = (16.0 * scale).round() as i32;
    PhysicalPosition::new(
        origin.x + (area.width as i32 - outer.width as i32 - gap).max(0),
        origin.y + (area.height as i32 - outer.height as i32 - gap).max(0),
    )
}

fn area_contains(area: &tauri::PhysicalRect<i32, u32>, (x, y): (i64, i64)) -> bool {
    let left = i64::from(area.position.x);
    let top = i64::from(area.position.y);
    (left..left + i64::from(area.size.width)).contains(&x)
        && (top..top + i64::from(area.size.height)).contains(&y)
}

fn fit_position(
    position: PhysicalPosition<i32>,
    outer: PhysicalSize<u32>,
    origin: PhysicalPosition<i32>,
    area: PhysicalSize<u32>,
) -> PhysicalPosition<i32> {
    let axis = |value: i32, extent: u32, start: i32, span: u32| {
        let start = i64::from(start);
        let end = (start + i64::from(span) - i64::from(extent)).max(start);
        i64::from(value).clamp(start, end) as i32
    };
    PhysicalPosition::new(
        axis(position.x, outer.width, origin.x, area.width),
        axis(position.y, outer.height, origin.y, area.height),
    )
}

fn place_pip(
    window: &Window,
    monitor: &Monitor,
    requested: PhysicalSize<u32>,
) -> tauri::Result<()> {
    let area = monitor.work_area();
    let scale = monitor.scale_factor();
    let (min, max) = pip_limits(area.size, scale);
    window.set_size_constraints(WindowSizeConstraints {
        min_width: Some(tauri::PhysicalUnit::new(min.width).into()),
        min_height: Some(tauri::PhysicalUnit::new(min.height).into()),
        max_width: Some(tauri::PhysicalUnit::new(max.width).into()),
        max_height: Some(tauri::PhysicalUnit::new(max.height).into()),
    })?;
    window.set_size(PhysicalSize::new(
        requested.width.clamp(min.width, max.width),
        requested.height.clamp(min.height, max.height),
    ))?;
    window.set_position(pip_corner(
        area.position,
        area.size,
        window.outer_size()?,
        scale,
    ))
}

#[tauri::command]
pub(crate) async fn get_player_pip(state: State<'_, PlayerPipState>) -> Result<bool, String> {
    Ok(state.0.lock().await.is_some())
}

fn restore_window(window: &Window, saved: &WindowPlacement) -> tauri::Result<()> {
    // Remove the PiP ceiling before restoring the app's configured constraints.
    let configured = window
        .app_handle()
        .config()
        .app
        .windows
        .iter()
        .find(|entry| entry.label == window.label());
    window.set_size_constraints(WindowSizeConstraints {
        min_width: configured
            .and_then(|entry| entry.min_width)
            .map(|value| tauri::LogicalUnit::new(value).into()),
        min_height: configured
            .and_then(|entry| entry.min_height)
            .map(|value| tauri::LogicalUnit::new(value).into()),
        max_width: configured
            .and_then(|entry| entry.max_width)
            .map(|value| tauri::LogicalUnit::new(value).into()),
        max_height: configured
            .and_then(|entry| entry.max_height)
            .map(|value| tauri::LogicalUnit::new(value).into()),
    })?;
    window.set_always_on_top(saved.always_on_top)?;
    window.set_resizable(saved.resizable)?;
    window.set_maximizable(saved.maximizable)?;
    window.unminimize()?;
    let center = (
        i64::from(saved.position.x) + i64::from(saved.size.width / 2),
        i64::from(saved.position.y) + i64::from(saved.size.height / 2),
    );
    // A disconnected monitor must not strand the restored app off-screen.
    let monitor = match window
        .available_monitors()?
        .into_iter()
        .find(|monitor| area_contains(monitor.work_area(), center))
    {
        Some(monitor) => Some(monitor),
        None => window.current_monitor()?.or(window.primary_monitor()?),
    };
    if let Some(monitor) = monitor {
        let area = monitor.work_area();
        // Arrive on the target monitor before sizing: a DPI change on the way
        // would otherwise rescale the restored physical size.
        window.set_position(fit_position(
            saved.position,
            window.outer_size()?,
            area.position,
            area.size,
        ))?;
        window.set_size(PhysicalSize::new(
            saved.size.width.min(area.size.width),
            saved.size.height.min(area.size.height),
        ))?;
        window.set_position(fit_position(
            saved.position,
            window.outer_size()?,
            area.position,
            area.size,
        ))?;
    } else {
        window.set_size(saved.size)?;
        window.set_position(saved.position)?;
    }
    if saved.maximized {
        window.maximize()?;
    }
    window.set_focus()
}

#[tauri::command]
pub(crate) async fn set_player_pip(
    window: Window,
    state: State<'_, PlayerPipState>,
    enabled: bool,
) -> Result<bool, String> {
    let mut placement = state.0.lock().await;
    if enabled {
        if placement.is_some() {
            return Ok(true);
        }
        if window.is_fullscreen().map_err(|error| error.to_string())? {
            return Err("Exit fullscreen before opening picture in picture.".to_string());
        }
        let monitor = window
            .current_monitor()
            .map_err(|error| error.to_string())?
            .or(window
                .primary_monitor()
                .map_err(|error| error.to_string())?)
            .ok_or("No monitor is available for picture in picture.")?;
        let mut saved = WindowPlacement {
            position: window.outer_position().map_err(|error| error.to_string())?,
            size: window.inner_size().map_err(|error| error.to_string())?,
            maximized: window.is_maximized().map_err(|error| error.to_string())?,
            always_on_top: window
                .is_always_on_top()
                .map_err(|error| error.to_string())?,
            resizable: window.is_resizable().map_err(|error| error.to_string())?,
            maximizable: window.is_maximizable().map_err(|error| error.to_string())?,
        };
        let mut enter = || -> tauri::Result<()> {
            if saved.maximized {
                window.unmaximize()?;
                saved.position = window.outer_position()?;
                saved.size = window.inner_size()?;
            }
            place_pip(
                &window,
                &monitor,
                pip_size(monitor.work_area().size, monitor.scale_factor()),
            )?;
            window.set_resizable(true)?;
            window.set_maximizable(false)?;
            window.set_always_on_top(true)
        };
        if let Err(error) = enter() {
            if restore_window(&window, &saved).is_err() {
                *placement = Some(saved);
            }
            return Err(error.to_string());
        }
        *placement = Some(saved);
    } else if let Some(saved) = placement.as_ref() {
        restore_window(&window, saved).map_err(|error| error.to_string())?;
        *placement = None;
    }
    Ok(placement.is_some())
}

#[tauri::command]
pub(crate) async fn snap_player_pip(
    window: Window,
    state: State<'_, PlayerPipState>,
) -> Result<(), String> {
    let placement = state.0.lock().await;
    if placement.is_none() {
        return Ok(());
    }
    let monitor = window
        .current_monitor()
        .map_err(|error| error.to_string())?
        .or(window
            .primary_monitor()
            .map_err(|error| error.to_string())?)
        .ok_or("No monitor is available for picture in picture.")?;
    let size = window.inner_size().map_err(|error| error.to_string())?;
    place_pip(&window, &monitor, size).map_err(|error| error.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pip_fits_small_and_scaled_work_areas() {
        for (area, scale) in [
            (PhysicalSize::new(1366, 728), 1.25),
            (PhysicalSize::new(1920, 1040), 1.0),
            (PhysicalSize::new(3840, 2080), 2.0),
            (PhysicalSize::new(640, 360), 1.5),
            (PhysicalSize::new(1080, 1880), 1.5),
            (PhysicalSize::new(3440, 1400), 1.25),
            (PhysicalSize::new(1920, 1040), 3.0),
            (PhysicalSize::new(320, 200), 2.0),
        ] {
            let size = pip_size(area, scale);
            let (min, max) = pip_limits(area, scale);
            assert!(min.width <= max.width && min.height <= max.height);
            assert!((min.width..=max.width).contains(&size.width));
            assert!((min.height..=max.height).contains(&size.height));
            assert!(size.width <= area.width && size.height <= area.height);
            assert!((f64::from(size.width) / f64::from(size.height) - 16.0 / 9.0).abs() < 0.02);
        }
        assert_eq!(pip_size(PhysicalSize::new(3840, 2080), 2.0).width, 880);
    }

    #[test]
    fn restored_window_rect_stays_inside_the_work_area() {
        let origin = PhysicalPosition::new(-1920, 40);
        let area = PhysicalSize::new(1920, 1040);
        let outer = PhysicalSize::new(1440, 920);
        for (position, expected) in [
            ((-1800, 100), (-1800, 100)),
            ((-600, 600), (-1440, 160)),
            ((-4000, -500), (-1920, 40)),
        ] {
            let fitted = fit_position(
                PhysicalPosition::new(position.0, position.1),
                outer,
                origin,
                area,
            );
            assert_eq!((fitted.x, fitted.y), expected);
        }
        let oversized = fit_position(
            PhysicalPosition::new(-1000, 300),
            PhysicalSize::new(2560, 1400),
            origin,
            area,
        );
        assert_eq!((oversized.x, oversized.y), (origin.x, origin.y));
    }

    #[test]
    fn pip_corner_respects_work_area_offsets_and_outer_frame() {
        let area = PhysicalSize::new(1920, 1040);
        let outer = PhysicalSize::new(456, 264);
        for origin in [
            PhysicalPosition::new(0, 40),
            PhysicalPosition::new(-1920, 0),
            PhysicalPosition::new(1920, -1080),
        ] {
            for scale in [1.0, 1.25, 1.5, 2.0, 3.0] {
                let position = pip_corner(origin, area, outer, scale);
                let gap = (16.0 * scale).round() as i32;
                assert!(position.x >= origin.x && position.y >= origin.y);
                assert_eq!(
                    position.x + outer.width as i32 + gap,
                    origin.x + area.width as i32
                );
                assert_eq!(
                    position.y + outer.height as i32 + gap,
                    origin.y + area.height as i32
                );
            }
        }
    }
}
