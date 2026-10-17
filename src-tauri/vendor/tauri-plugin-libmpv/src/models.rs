use indexmap::IndexMap;
use serde::{Deserialize, Serialize};
use std::ffi::{c_char, c_void};
use std::sync::{mpsc::Sender, Arc, Mutex};

use crate::wrapper::MpvHandle;

#[derive(Debug, Clone, Copy)]
pub struct MpvInstance {
    pub handle: *mut MpvHandle,
    pub event_userdata: *mut c_void,
    pub(crate) last_video_margins: [Option<f64>; 4],
}

unsafe impl Send for MpvInstance {}
unsafe impl Sync for MpvInstance {}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MpvConfig {
    #[serde(default)]
    pub initial_options: IndexMap<String, serde_json::Value>,
    #[serde(default)]
    pub observed_properties: IndexMap<String, String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct VideoMarginRatio {
    pub left: Option<f64>,
    pub right: Option<f64>,
    pub top: Option<f64>,
    pub bottom: Option<f64>,
}

#[derive(Debug, Clone)]
pub struct EventUserData {
    pub free_fn: unsafe extern "C" fn(*mut c_char),
    pub event_sender: Sender<String>,
    pub event_alive: Arc<Mutex<bool>>,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct FfiResponse {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub data: Option<serde_json::Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}
