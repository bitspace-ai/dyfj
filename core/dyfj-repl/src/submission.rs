//! What one completed input is: nothing, a request to quit, too long to send,
//! or a prompt. Shared by the main loop and the wait for a runtime that went
//! away, which both have to recognise a quit.

/// The runtime's input ceiling. Mirrors MAX_INPUT_LENGTH in the TypeScript
/// CLI; a longer prompt is rejected there, so rejecting it here costs the
/// operator a round trip less.
pub const MAX_INPUT_CHARACTERS: usize = 32_768;

/// What the operator's input turns out to be.
#[derive(Debug, PartialEq, Eq)]
pub enum Submission {
    Empty,
    Quit,
    TooLong { characters: usize },
    Prompt,
}

/// Classify one completed input.
///
/// A slash command counts only when the WHOLE input is that command. This is
/// what keeps a pasted block whose first line reads `/exit` from quitting the
/// session: the paste arrives as one string, so it is a prompt, not a command.
pub fn classify(input: &str) -> Submission {
    let trimmed = input.trim();
    if trimmed.is_empty() {
        return Submission::Empty;
    }
    if trimmed == "/exit" || trimmed == "/quit" {
        return Submission::Quit;
    }
    // Count as the TypeScript CLI does: its ceiling is JavaScript's
    // `line.length`, which is UTF-16 code units. A byte count would reject
    // valid multi-byte input; a scalar count would accept an astral paste
    // (emoji, some CJK) of up to twice what the peer allows.
    let characters = input.encode_utf16().count();
    if characters > MAX_INPUT_CHARACTERS {
        return Submission::TooLong { characters };
    }
    Submission::Prompt
}
