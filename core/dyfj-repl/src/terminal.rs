//! Terminal input, owned by one thread.
//!
//! rustyline blocks, so it lives on a dedicated thread and the async side asks
//! it for input over channels. That single-owner arrangement is deliberate: it
//! is what lets the approval prompt refuse input the operator gave before they
//! could see what they were approving.

use anyhow::Result;
use rustyline::DefaultEditor;
use rustyline::error::ReadlineError;
use std::sync::OnceLock;
use std::sync::mpsc as std_mpsc;
use tokio::sync::{mpsc, oneshot};

/// What the terminal thread was asked to read.
pub enum Ask {
    /// The ordinary prompt. History applies.
    Prompt { respond: oneshot::Sender<ReadOutcome> },
    /// A mid-turn approval question. Input typed before this point is
    /// discarded first, and the answer never enters history.
    Approval { question: String, respond: oneshot::Sender<ReadOutcome> },
}

#[derive(Debug, Clone)]
pub enum ReadOutcome {
    Line(String),
    /// Ctrl-C. At the ordinary prompt this clears the line. Inside an approval
    /// read it denies that approval and does not cancel the turn — turn
    /// cancellation is the SIGINT the main loop catches while no read is
    /// active, which is a different path.
    Interrupted,
    /// Ctrl-D on an empty buffer.
    Eof,
    Failed(String),
}

/// The submission ceiling, mirrored here so history does not retain input that
/// will be refused. Kept in step with MAX_INPUT_CHARACTERS in the main loop,
/// and measured the same way, in UTF-16 code units.
///
/// Known limit: this bounds what is REMEMBERED, not what is read. `readline`
/// has already allocated the whole line by the time either check runs, so an
/// enormous paste costs that allocation before it is refused.
const MAX_REMEMBERED_CHARACTERS: usize = 32_768;

/// Attempt to discard terminal input received but not yet read.
///
/// Returns false when the flush did not succeed, which the caller must treat
/// as a reason not to read an answer. Whether stdin is a terminal at all is a
/// separate question, asked first.
///
/// A keystroke typed while a turn was running sits in the tty's input queue.
/// Without this, the next read consumes it — so an approval prompt would be
/// answered by a `y` the operator typed before they saw the question. That was
/// observed in an earlier attempt at this feature, and the flush was verified
/// by hand against a real terminal.
///
/// Two limits worth stating. TCIFLUSH acts on a terminal; on a pipe it does
/// nothing, so piped input written ahead of an approval is NOT discarded —
/// approval from a non-interactive stream is outside what this defends. And
/// the call's result is reported rather than ignored, because a failed flush
/// means the next read may consume input the operator did not intend as an
/// answer.
fn discard_pending_input() -> bool {
    // SAFETY: tcflush on a borrowed fd with a constant queue selector. It
    // neither allocates nor retains the descriptor.
    unsafe { libc::tcflush(libc::STDIN_FILENO, libc::TCIFLUSH) == 0 }
}

/// Whether an approval can be both shown and answered here.
///
/// Both halves matter and for different reasons. Without terminal INPUT there
/// is no operator, and a prewritten line on a pipe would answer the request.
/// Without terminal OUTPUT the request's details go somewhere the answering
/// operator cannot see — `dyfj-repl > out.txt` puts the command, the amounts
/// and the limits into a file while the prompt still reads from the keyboard,
/// so a `y` would be consent to something never displayed.
fn approval_surface_available(input_is_terminal: bool, output_is_terminal: bool) -> bool {
    input_is_terminal && output_is_terminal
}

fn terminal_surfaces() -> (bool, bool) {
    unsafe {
        (
            libc::isatty(libc::STDIN_FILENO) == 1,
            libc::isatty(libc::STDOUT_FILENO) == 1,
        )
    }
}

/// The terminal settings as they were before this process started driving the
/// terminal. Captured before rustyline is constructed, so it is the caller's
/// state and not ours.
struct SavedTermios(libc::termios);

// SAFETY: `termios` is a plain settings struct with no interior mutability and
// no owned resources. It is written once, before any thread could read it, and
// only read afterwards — including from a panic hook, which is why this is a
// `OnceLock` rather than a mutex.
unsafe impl Sync for SavedTermios {}
unsafe impl Send for SavedTermios {}

static SAVED: OnceLock<SavedTermios> = OnceLock::new();

/// Put the terminal back if we panic.
///
/// rustyline restores its own termios when `readline` returns or unwinds, but
/// a panic elsewhere while it holds the terminal leaves the operator with no
/// echo, no line editing and a hidden cursor in the shell they return to. The
/// hook is installed before the terminal is ever taken, and it captures the
/// startup termios here so `restore` can replay it.
///
/// This covers panics only. There is no SIGTERM handler, so a termination
/// signal during a read exits without restoration. The reset below replays the
/// whole startup termios when it acts, so a setting the caller changed AFTER
/// capture is overwritten rather than preserved. An ordinary exit is covered
/// separately, by the main loop calling `restore` on its way out.
pub fn install_panic_restore() {
    // SAFETY: a termios read on a borrowed descriptor, which neither allocates
    // nor retains it.
    unsafe {
        let mut termios: libc::termios = std::mem::zeroed();
        if libc::tcgetattr(libc::STDIN_FILENO, &mut termios) == 0 {
            let _ = SAVED.set(SavedTermios(termios));
        }
    }
    let previous = std::panic::take_hook();
    std::panic::set_hook(Box::new(move |info| {
        restore();
        previous(info);
    }));
}

/// Whether the terminal's settings have moved since they were captured.
///
/// Every field, not just the local flags: an editor can change input flags or
/// the VMIN/VTIME pair while leaving `c_lflag` alone, and a comparison that
/// looked only at `c_lflag` would call that unchanged and leave it behind. On
/// Linux that includes `c_line` (the line discipline), a field the BSD/macOS
/// termios does not have.
fn differs(current: &libc::termios, saved: &libc::termios) -> bool {
    // `c_line` exists only in the Linux termios; `cfg` it out elsewhere so the
    // comparison stays complete on Linux without breaking the macOS build.
    #[cfg(target_os = "linux")]
    let line_differs = current.c_line != saved.c_line;
    #[cfg(not(target_os = "linux"))]
    let line_differs = false;

    line_differs
        || current.c_iflag != saved.c_iflag
        || current.c_oflag != saved.c_oflag
        || current.c_cflag != saved.c_cflag
        || current.c_lflag != saved.c_lflag
        || current.c_ispeed != saved.c_ispeed
        || current.c_ospeed != saved.c_ospeed
        || current.c_cc != saved.c_cc
}

/// Disable bracketed paste, show the cursor, and replay the termios captured
/// at startup.
///
/// Two independent cleanups, because they are independent settings. Bracketed
/// paste and cursor visibility are display modes, not part of termios, so the
/// reset for them is written unconditionally (to a terminal) — a snapshot that
/// is absent or unchanged says nothing about them, and the previous panic hook
/// always wrote it. The termios replay is the conditional part: it acts only
/// when a snapshot was captured, the current settings can be read, and they
/// differ from it.
///
/// The comparison detects a difference; it does not establish who caused one.
/// Something else sharing this terminal could have changed a setting, and
/// replaying the snapshot would overwrite that — the trade is deliberate,
/// because the case this exists for is the editor having left the terminal raw,
/// the far likelier cause and the one the operator cannot recover from without
/// `reset`.
///
/// Written with raw syscalls because this also runs from a panic hook, where
/// allocation and locks are the things most likely to make a bad situation
/// worse. That is also why a failed restore is reported with a constant write
/// to stderr rather than a formatted message.
pub fn restore() {
    const RESET: &[u8] = b"\x1b[?2004l\x1b[?25h";
    const FAILED: &[u8] = b"the terminal could not be restored; run `reset`\n";
    // SAFETY: writes of fixed-length constants and a termios round-trip on
    // stdin. None of these retain a descriptor.
    unsafe {
        // Display modes first, and regardless of the termios outcome below.
        // Only to a terminal: `dyfj-repl > out.txt` would otherwise collect
        // escape sequences meant for the operator's screen.
        if libc::isatty(libc::STDOUT_FILENO) == 1 {
            libc::write(libc::STDOUT_FILENO, RESET.as_ptr() as *const libc::c_void, RESET.len());
        }

        // Then the termios replay, only when there is a snapshot to replay, it
        // can be compared, and it actually moved.
        let Some(saved) = SAVED.get() else { return };
        let mut current: libc::termios = std::mem::zeroed();
        if libc::tcgetattr(libc::STDIN_FILENO, &mut current) != 0 {
            return;
        }
        if !differs(&current, &saved.0) {
            return;
        }
        if libc::tcsetattr(libc::STDIN_FILENO, libc::TCSANOW, &saved.0) != 0 {
            // Say so. Exiting quietly leaves the operator in a shell with no
            // echo and no idea why.
            libc::write(libc::STDERR_FILENO, FAILED.as_ptr() as *const libc::c_void, FAILED.len());
        }
    }
}

/// Spawn the terminal thread. Returns the channel to ask it for input.
pub fn spawn() -> Result<mpsc::Sender<Ask>> {
    let (tx, mut rx) = mpsc::channel::<Ask>(8);
    let (ready_tx, ready_rx) = std_mpsc::channel::<Result<(), String>>();

    std::thread::spawn(move || {
        let mut editor = match DefaultEditor::new() {
            Ok(editor) => {
                let _ = ready_tx.send(Ok(()));
                editor
            }
            Err(err) => {
                let _ = ready_tx.send(Err(err.to_string()));
                return;
            }
        };

        while let Some(ask) = rx.blocking_recv() {
            match ask {
                Ask::Prompt { respond } => {
                    let outcome = read(&mut editor, "dyfj> ", true);
                    let _ = respond.send(outcome);
                }
                Ask::Approval { question, respond } => {
                    // Consent requires an operator who can see the request.
                    // An earlier version treated a pipe as "nothing to flush,
                    // therefore safe" and read anyway; a later one checked the
                    // input side only, which still allowed the details to be
                    // redirected away from the terminal answering them.
                    let (input_is_terminal, output_is_terminal) = terminal_surfaces();
                    if !approval_surface_available(input_is_terminal, output_is_terminal) {
                        let _ = respond.send(ReadOutcome::Failed(
                            "approval requires an interactive terminal for both the \
                             request and the answer"
                                .into(),
                        ));
                        continue;
                    }
                    // The flush failed on a real terminal, so input typed
                    // before this request appeared may still be queued and
                    // would answer it. Refuse to read; the caller turns a
                    // failure into a denial.
                    if !discard_pending_input() {
                        let _ = respond.send(ReadOutcome::Failed(
                            "could not discard input typed before this prompt".into(),
                        ));
                        continue;
                    }
                    let outcome = read(&mut editor, &question, false);
                    let _ = respond.send(outcome);
                }
            }
        }
    });

    match ready_rx.recv() {
        Ok(Ok(())) => Ok(tx),
        Ok(Err(err)) => Err(anyhow::anyhow!("terminal unavailable: {err}")),
        Err(_) => Err(anyhow::anyhow!("terminal thread died during startup")),
    }
}

fn read(editor: &mut DefaultEditor, prompt: &str, remember: bool) -> ReadOutcome {
    match editor.readline(prompt) {
        Ok(line) => {
            // History is for prompts the operator composed, not for approval
            // answers — recalling a bare "y" would be noise at best. Input the
            // submission ceiling will reject is not kept either: it would be
            // retained and recallable despite never being sent.
            if remember
                && !line.trim().is_empty()
                && line.encode_utf16().count() <= MAX_REMEMBERED_CHARACTERS
            {
                let _ = editor.add_history_entry(line.as_str());
            }
            ReadOutcome::Line(line)
        }
        Err(ReadlineError::Interrupted) => ReadOutcome::Interrupted,
        Err(ReadlineError::Eof) => ReadOutcome::Eof,
        Err(err) => ReadOutcome::Failed(err.to_string()),
    }
}

#[cfg(test)]
mod tests {
    use super::{approval_surface_available, differs};

    /// Both surfaces are required, and for different reasons: input because a
    /// pipe would answer the request without an operator, output because
    /// redirecting it sends the command, amounts and limits somewhere the
    /// answering operator cannot see.
    #[test]
    fn an_approval_needs_a_terminal_at_both_ends() {
        assert!(approval_surface_available(true, true));
        assert!(!approval_surface_available(true, false), "redirected output");
        assert!(!approval_surface_available(false, true), "piped input");
        assert!(!approval_surface_available(false, false));
    }

    /// `differs` must notice a change in any field, not only `c_lflag`: an
    /// editor can leave the local flags alone while changing an input flag or
    /// the VMIN/VTIME control characters, and missing that would leave the
    /// terminal unrestored.
    #[test]
    fn differs_compares_every_termios_field_not_only_the_local_flags() {
        // SAFETY: `termios` is a plain settings struct; a zeroed value is a
        // valid baseline for a field-by-field comparison.
        let saved: libc::termios = unsafe { std::mem::zeroed() };
        let unchanged = saved;
        assert!(!differs(&unchanged, &saved), "an identical termios must not differ");

        let mut input_flag = saved;
        input_flag.c_iflag |= libc::IXON;
        assert!(differs(&input_flag, &saved), "an input-flag change must be noticed");

        let mut control = saved;
        control.c_cc[libc::VMIN] = 1;
        assert!(differs(&control, &saved), "a control-character change must be noticed");
    }

    /// `c_line` is Linux-only, and a change to it alone must still be noticed —
    /// otherwise the full-snapshot contract has a hole on Linux.
    #[cfg(target_os = "linux")]
    #[test]
    fn differs_notices_a_line_discipline_change() {
        // SAFETY: a zeroed `termios` is a valid baseline for the comparison.
        let saved: libc::termios = unsafe { std::mem::zeroed() };
        let mut line = saved;
        line.c_line = 1;
        assert!(differs(&line, &saved), "a line-discipline change must be noticed");
    }
}
