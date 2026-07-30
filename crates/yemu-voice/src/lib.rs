//! Native voice engine: microphone capture, speaker playback, and the WebRTC
//! live-conversation peer.
//!
//! napi-free by design. `yemu-native` wraps these types in thin `#[napi]`
//! adapters, so the webrtc/opus/miniaudio dependency graph compiles once into
//! this rlib and rebuilds only when voice code changes — never when the
//! N-API surface elsewhere in the addon does.
//!
//! # Architecture
//! ```text
//! JS (packages/natives) -> #[napi] adapters (yemu-native audio.rs / live.rs)
//!   -> yemu_voice::audio  (miniaudio capture/playback engine)
//!   -> yemu_voice::live   (WebRTC peer + Opus media, feeds audio playback)
//! ```
//!
//! Async entry points ([`live::LivePeerCore::create_offer`] and friends) run
//! on the caller's ambient tokio runtime — napi-rs's `tokio_rt` inside the
//! addon. Callback fields ([`live::LiveCallbacks`]) are invoked from tokio
//! worker threads and must not block.

pub mod audio;
pub mod live;

/// Engine-level result: a human-readable failure message the N-API layer maps
/// to a JS error verbatim.
pub type VoiceResult<T> = std::result::Result<T, String>;
