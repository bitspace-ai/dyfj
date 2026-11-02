//! The live status line under a running turn.
//!
//! A turn's lines arrive only when something happens. Between them (a
//! provider call that takes forty seconds, a test suite that takes three
//! minutes) the screen is still, and still looks the same whether the turn is
//! working or stuck. This line says what the turn is waiting on and for how
//! long, redrawn every second, so a long wait is visibly a wait on something
//! named, with a clock on it.
//!
//! It is drawn on stderr only when stderr is a terminal, only at the start of
//! a line (never over streamed text), and erased before anything else is
//! written, so it never lands in scrollback.

use crate::activity;
use serde_json::Value;
use std::io::Write;
use std::time::{Duration, Instant};

/// What the turn is waiting on, as the last event left it.
#[derive(Debug, Clone, PartialEq)]
enum Phase {
    /// Submitted; the runtime has not yet asked a model anything.
    Starting,
    /// A provider request is out.
    Model { model: Option<String> },
    /// The model answered; the runtime is deciding what comes next.
    Runtime,
    /// A tool call is running.
    Tool { label: String },
    /// Answer text is arriving.
    Streaming,
}

/// How long without any frame before the line says so. A provider call can
/// legitimately take longer; the line reports the silence, it does not judge
/// it.
const QUIET_AFTER: Duration = Duration::from_secs(30);

#[derive(Debug)]
pub struct StatusLine {
    enabled: bool,
    started: Instant,
    phase: Phase,
    phase_since: Instant,
    last_frame: Instant,
    step: Option<i64>,
    calls: usize,
    /// Whether the cursor is at the start of a line, so the status line can
    /// be drawn without overwriting text.
    at_line_start: bool,
    shown: bool,
    cancelling: bool,
}

impl StatusLine {
    /// `enabled` is whether stderr is a terminal.
    pub fn new(enabled: bool, now: Instant) -> Self {
        StatusLine {
            enabled,
            started: now,
            phase: Phase::Starting,
            phase_since: now,
            last_frame: now,
            step: None,
            calls: 0,
            at_line_start: true,
            shown: false,
            cancelling: false,
        }
    }

    pub fn enabled(&self) -> bool {
        self.enabled
    }

    pub fn elapsed(&self, now: Instant) -> Duration {
        now.saturating_duration_since(self.started)
    }

    fn enter(&mut self, phase: Phase, now: Instant) {
        if self.phase != phase {
            self.phase = phase;
            self.phase_since = now;
        }
    }

    /// Fold a runtime event into the phase.
    pub fn observe_event(&mut self, event: &Value, now: Instant) {
        self.last_frame = now;
        match event.get("type").and_then(Value::as_str) {
            Some("beforeProviderRequest") => {
                let model = event
                    .get("modelSlug")
                    .and_then(Value::as_str)
                    .map(|slug| activity::bounded(slug, 40));
                self.enter(Phase::Model { model }, now);
            }
            Some("afterProviderResponse") => self.enter(Phase::Runtime, now),
            Some("toolStepStarted") => {
                self.step = event.get("step").and_then(Value::as_i64);
            }
            Some("toolCallStarted") => {
                self.calls += 1;
                self.enter(Phase::Tool { label: activity::call_label(event) }, now);
            }
            Some("toolCallCompleted") => self.enter(Phase::Runtime, now),
            Some("agentProgress") => {
                let running = event.get("kind").and_then(Value::as_str) == Some("tool_call")
                    && !matches!(
                        event.get("status").and_then(Value::as_str),
                        Some("completed" | "failed")
                    );
                let label = match activity::agent_progress_title(event) {
                    Some(title) if running => format!("external agent: {title}"),
                    _ => "external agent".to_string(),
                };
                self.enter(Phase::Tool { label }, now);
            }
            _ => {}
        }
    }

    /// Answer text reached the terminal.
    pub fn observe_text(&mut self, text: &str, now: Instant) {
        self.last_frame = now;
        self.enter(Phase::Streaming, now);
        if !text.is_empty() {
            self.at_line_start = text.ends_with('\n');
        }
    }

    /// Something other than answer text was printed: a whole line.
    pub fn printed_line(&mut self) {
        self.at_line_start = true;
    }

    /// Whether a line about to be printed needs a newline first, because
    /// streamed text left the cursor mid-line.
    pub fn needs_newline(&self) -> bool {
        !self.at_line_start
    }

    pub fn cancelling(&mut self) {
        self.cancelling = true;
    }

    /// The line's text for `now`, or None when nothing should be drawn.
    pub fn text(&self, now: Instant) -> Option<String> {
        let in_phase = now.saturating_duration_since(self.phase_since);
        let quiet = now.saturating_duration_since(self.last_frame);
        let what = match &self.phase {
            Phase::Starting => "starting the turn".to_string(),
            Phase::Model { model: Some(model) } => format!("waiting on {model}"),
            Phase::Model { model: None } => "waiting on the model".to_string(),
            Phase::Runtime => "runtime working".to_string(),
            Phase::Tool { label } => format!("running {label}"),
            // Streaming text is its own progress. Once it pauses at a line
            // break, say the model is still writing.
            Phase::Streaming if quiet < Duration::from_secs(2) => return None,
            Phase::Streaming => "model writing".to_string(),
        };
        let mut parts = vec![format!("{what} {}", clock(in_phase))];
        let total = now.saturating_duration_since(self.started);
        if total > in_phase + Duration::from_secs(1) {
            parts.push(format!("turn {}", clock(total)));
        }
        if let Some(step) = self.step {
            parts.push(format!("step {step}"));
        }
        if self.calls > 0 {
            parts.push(if self.calls == 1 { "1 call".into() } else { format!("{} calls", self.calls) });
        }
        // Only when the silence is not already the clock beside the phase.
        if quiet >= QUIET_AFTER && quiet + Duration::from_secs(1) < in_phase {
            parts.push(format!("no runtime event for {}", clock(quiet)));
        }
        parts.push(if self.cancelling {
            "cancelling; Ctrl-C again stops waiting".into()
        } else {
            "Ctrl-C cancels".into()
        });
        Some(format!("… {}", parts.join(" · ")))
    }

    /// Redraw the line for `now`, when it is enabled and the cursor is at the
    /// start of a line.
    pub fn draw(&mut self, now: Instant) {
        if !self.enabled || !self.at_line_start {
            return;
        }
        let Some(text) = self.text(now) else {
            self.clear();
            return;
        };
        let width = terminal_width().saturating_sub(1).max(20);
        let text: String = text.chars().take(width).collect();
        let mut err = std::io::stderr().lock();
        let _ = write!(err, "\r\x1b[K{text}");
        let _ = err.flush();
        self.shown = true;
    }

    /// Erase the line, before anything else is written.
    pub fn clear(&mut self) {
        if !self.shown {
            return;
        }
        let mut err = std::io::stderr().lock();
        let _ = write!(err, "\r\x1b[K");
        let _ = err.flush();
        self.shown = false;
    }
}

/// Seconds, then minutes and seconds: a clock that ticks visibly.
fn clock(duration: Duration) -> String {
    let secs = duration.as_secs();
    if secs < 60 {
        format!("{secs}s")
    } else {
        format!("{}m{:02}s", secs / 60, secs % 60)
    }
}

/// The terminal's width in columns, from stderr, or 80.
fn terminal_width() -> usize {
    // SAFETY: TIOCGWINSZ writes a winsize into the zeroed struct passed; the
    // result is read only when the call reports success.
    unsafe {
        let mut size: libc::winsize = std::mem::zeroed();
        if libc::ioctl(libc::STDERR_FILENO, libc::TIOCGWINSZ, &mut size) == 0 && size.ws_col > 0 {
            return size.ws_col as usize;
        }
    }
    80
}

#[cfg(test)]
mod tests {
    use super::StatusLine;
    use serde_json::json;
    use std::time::{Duration, Instant};

    fn secs(n: u64) -> Duration {
        Duration::from_secs(n)
    }

    #[test]
    fn a_new_turn_says_it_is_starting() {
        let t0 = Instant::now();
        let line = StatusLine::new(true, t0);
        assert_eq!(line.text(t0 + secs(3)).as_deref(), Some("… starting the turn 3s · Ctrl-C cancels"));
    }

    /// The long silence of a provider call is a named wait with a clock.
    #[test]
    fn a_provider_call_names_the_model_and_counts() {
        let t0 = Instant::now();
        let mut line = StatusLine::new(true, t0);
        line.observe_event(&json!({"type": "toolStepStarted", "step": 2, "toolCallCount": 1}), t0);
        line.observe_event(&json!({"type": "toolCallStarted", "commandId": "read_file", "subject": "a.ts"}), t0);
        line.observe_event(&json!({"type": "toolCallCompleted", "commandId": "read_file"}), t0 + secs(1));
        line.observe_event(
            &json!({"type": "beforeProviderRequest", "modelSlug": "z-ai/glm-5.2"}),
            t0 + secs(5),
        );
        assert_eq!(
            line.text(t0 + secs(52)).as_deref(),
            Some("… waiting on z-ai/glm-5.2 47s · turn 52s · step 2 · 1 call · Ctrl-C cancels")
        );
    }

    #[test]
    fn a_running_tool_is_named_with_its_subject() {
        let t0 = Instant::now();
        let mut line = StatusLine::new(true, t0);
        line.observe_event(&json!({"type": "toolCallStarted", "commandId": "bash", "subject": "npm test"}), t0);
        assert_eq!(
            line.text(t0 + secs(125)).as_deref(),
            Some("… running bash npm test 2m05s · 1 call · Ctrl-C cancels")
        );
    }

    /// Silence is reported only when it is not already the phase's clock.
    #[test]
    fn silence_after_the_phase_began_is_reported() {
        let t0 = Instant::now();
        let mut line = StatusLine::new(true, t0);
        line.observe_event(&json!({"type": "beforeProviderRequest", "modelSlug": "m"}), t0);
        assert!(!line.text(t0 + secs(90)).unwrap().contains("no runtime event"));
        // A bookkeeping event that leaves the phase alone resets the silence.
        line.observe_event(&json!({"type": "contextBuilt"}), t0 + secs(10));
        assert!(line.text(t0 + secs(90)).unwrap().contains("no runtime event for 1m20s"));
    }

    #[test]
    fn streaming_text_is_its_own_progress() {
        let t0 = Instant::now();
        let mut line = StatusLine::new(true, t0);
        line.observe_text("partial", t0);
        assert_eq!(line.text(t0 + secs(1)), None);
        assert!(line.needs_newline(), "the cursor is mid-line");
        line.observe_text(" line\n", t0 + secs(1));
        assert!(!line.needs_newline());
        assert_eq!(
            line.text(t0 + secs(4)).as_deref(),
            Some("… model writing 4s · Ctrl-C cancels")
        );
    }

    #[test]
    fn a_cancel_in_flight_says_how_to_stop_waiting() {
        let t0 = Instant::now();
        let mut line = StatusLine::new(true, t0);
        line.cancelling();
        assert!(line.text(t0).unwrap().ends_with("cancelling; Ctrl-C again stops waiting"));
    }

    #[test]
    fn an_external_agent_call_in_progress_is_named() {
        let t0 = Instant::now();
        let mut line = StatusLine::new(true, t0);
        line.observe_event(
            &json!({"type": "agentProgress", "kind": "tool_call", "title": "Run npm test", "status": "in_progress"}),
            t0,
        );
        assert_eq!(
            line.text(t0 + secs(4)).as_deref(),
            Some("… running external agent: Run npm test 4s · Ctrl-C cancels")
        );
    }
}
