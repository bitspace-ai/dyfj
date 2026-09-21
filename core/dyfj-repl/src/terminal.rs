//! Terminal input, owned by one thread.
//!
//! rustyline blocks, so it lives on a dedicated thread and the async side asks
//! it for input over channels. That single-owner arrangement is deliberate: it
//! is what lets the approval prompt refuse input the operator gave before they
//! could see what they were approving.

use anyhow::Result;
use rustyline::DefaultEditor;
use rustyline::error::ReadlineError;
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
/// will be refused. Kept in step with MAX_INPUT_CHARACTERS in the main loop.
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

/// Put the terminal back if we panic.
///
/// rustyline restores its own termios when `readline` returns or unwinds, but
/// a panic elsewhere while it holds the terminal leaves the operator with no
/// echo, no line editing and a hidden cursor in the shell they return to. The
/// hook is installed before the terminal is ever taken.
///
/// This covers panics only. There is no SIGTERM handler, so a termination
/// signal during a read exits without restoration, and the reset below
/// re-enables three local flags rather than restoring a saved termios — any
/// other setting a caller changed stays changed.
pub fn install_panic_restore() {
    let previous = std::panic::take_hook();
    std::panic::set_hook(Box::new(move |info| {
        restore();
        previous(info);
    }));
}

/// Re-enable the terminal settings an operator notices, and show the cursor.
///
/// Not a full restoration: it does not replay a saved termios. Written with
/// raw syscalls because this runs from a panic hook, where allocation and
/// locks are the things most likely to make a bad situation worse.
fn restore() {
    // Disable bracketed paste and show the cursor.
    const RESET: &[u8] = b"\x1b[?2004l\x1b[?25h";
    // SAFETY: a write of a fixed-length constant to stdout, and a termios
    // round-trip on stdin. Neither retains the descriptor.
    unsafe {
        libc::write(libc::STDOUT_FILENO, RESET.as_ptr() as *const libc::c_void, RESET.len());

        let mut termios: libc::termios = std::mem::zeroed();
        if libc::tcgetattr(libc::STDIN_FILENO, &mut termios) == 0 {
            // Re-enable the three the operator notices: echo, line editing,
            // and signal generation.
            termios.c_lflag |= libc::ECHO | libc::ICANON | libc::ISIG;
            libc::tcsetattr(libc::STDIN_FILENO, libc::TCSANOW, &termios);
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
                && line.chars().count() <= MAX_REMEMBERED_CHARACTERS
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
    use super::approval_surface_available;

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
}
