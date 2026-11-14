use super::describe;
use serde_json::json;

#[test]
fn plan_statuses_and_omissions() {
    assert_eq!(describe(&json!({"type":"agentProgress", "kind":"plan", "plan":{
        "steps":[{"content":"Inspect", "status":"completed"}, {"content":"Edit", "status":"in_progress"},
            {"content":"Create", "status":"pending"}], "stepsOmitted":5
    }})).as_deref(), Some("  · plan (external agent)\n      [x] Inspect\n      [>] Edit\n      [ ] Create\n      … 5 more steps"));
}

#[test]
fn file_changes_render_counts_lines_and_withholding() {
    assert_eq!(describe(&json!({"type":"agentProgress", "kind":"tool_call", "toolCallId":"edit",
        "toolKind":"edit", "title":"Editing files", "status":"in_progress", "input":"ignored",
        "fileChanges":{"files":[
            {"path":"src/a.ts", "change":"update", "added":3, "removed":1, "lines":["-old", "+new"], "linesOmitted":12},
            {"path":"src/new.ts", "change":"add", "added":40, "removed":0, "withheld":true},
            {"path":"src/gone.ts", "change":"delete", "added":0, "removed":1, "lines":["-gone"]}
        ], "filesOmitted":2}
    })).as_deref(), Some("  ▸ Editing files (external agent)\n      src/a.ts  +3 -1\n        - old\n        + new\n        … 12 more lines\n      src/new.ts  added, +40\n        (content withheld: it matched a credential pattern)\n      src/gone.ts  deleted, -1\n        - gone\n      … 2 more files"));
}

#[test]
fn narrates_the_step_limit_and_a_failed_handoff() {
    assert_eq!(
        describe(&json!({"type": "toolStepLimitReached", "maxSteps": 2})).as_deref(),
        Some("· tool step limit reached (2 steps); asking the model for a handoff")
    );
    assert_eq!(
        describe(&json!({"type": "toolStepLimitHandoff", "maxSteps": 2, "source": "notice"}))
            .as_deref(),
        Some("· the handoff call failed; the reply is the runtime's notice of the last tool calls")
    );
    // The model's handoff is the reply; there is nothing more to say.
    assert_eq!(
        describe(&json!({"type": "toolStepLimitHandoff", "maxSteps": 2, "source": "model"})),
        None
    );
}

/// Shapes captured from a live runtime turn, not invented.
#[test]
fn narrates_a_tool_step_as_the_runtime_reports_it() {
    assert_eq!(
        describe(&json!({"type": "toolStepStarted", "step": 1, "toolCallCount": 1}))
            .as_deref(),
        Some("· step 1: 1 call")
    );
    assert_eq!(
        describe(&json!({"type": "toolStepStarted", "step": 2, "toolCallCount": 3}))
            .as_deref(),
        Some("· step 2: 3 calls")
    );
    assert_eq!(
        describe(&json!({"type": "toolCallStarted", "commandId": "list_files"}))
            .as_deref(),
        Some("  → list_files")
    );
    assert_eq!(
        describe(&json!({
            "type": "toolCallCompleted", "commandId": "list_files",
            "isError": false, "durationMs": 11
        }))
        .as_deref(),
        Some("  ✓ list_files (11ms)")
    );
}

/// A call that was not approved did not run. The line does not say the
/// operator declined: a failed prompt carries the same verdict. No
/// duration, because the time on it is the wait.
#[test]
fn renders_an_unapproved_call_as_not_approved() {
    assert_eq!(
        describe(&json!({
            "type": "toolCallCompleted", "commandId": "bash",
            "isError": true, "durationMs": 163376, "verdict": "approval_denied"
        }))
        .as_deref(),
        Some("  ⊘ bash not approved")
    );
}

/// A real failure keeps its mark and duration, with or without any other
/// verdict value a later runtime might send.
#[test]
fn a_real_failure_still_renders_as_a_failure() {
    assert_eq!(
        describe(&json!({
            "type": "toolCallCompleted", "commandId": "bash",
            "isError": true, "durationMs": 40
        }))
        .as_deref(),
        Some("  ✗ bash (40ms)")
    );
    assert_eq!(
        describe(&json!({
            "type": "toolCallCompleted", "commandId": "bash",
            "isError": true, "durationMs": 40, "verdict": "something_else"
        }))
        .as_deref(),
        Some("  ✗ bash (40ms)")
    );
}

#[test]
fn narrates_window_fitting_as_the_runtime_reports_it() {
    assert_eq!(
        describe(&json!({
            "type": "toolResultTrimmed", "commandId": "read_file", "callId": "c1",
            "contextWindow": 32768, "keptChars": 8192, "totalChars": 65536
        }))
        .as_deref(),
        Some("  · read_file result trimmed to fit the context window (8192 of 65536 chars kept)")
    );
    assert_eq!(
        describe(&json!({
            "type": "contextFitted", "modelSlug": "m", "contextWindow": 32768,
            "budgetTokens": 23347, "estimatedTokensBefore": 47716,
            "estimatedTokensAfter": 18200, "trimmedToolResults": 2,
            "compressed": false, "trigger": "before_send"
        }))
        .as_deref(),
        Some("· context fitted to the 32768-token window: 2 tool result(s) trimmed")
    );
    assert_eq!(
        describe(&json!({
            "type": "contextFitted", "contextWindow": 32768, "trimmedToolResults": 0,
            "compressed": true, "trigger": "provider_rejected"
        }))
        .as_deref(),
        Some("· context fitted to the 32768-token window after the provider rejected the request: elder turns compressed")
    );
}

/// The runtime sends why a call failed; the ✗ line carries it, on one
/// line, so the operator is not left with a mark and a duration.
#[test]
fn a_failed_tool_call_shows_its_reason() {
    assert_eq!(
        describe(&json!({
            "type": "toolCallCompleted", "commandId": "mcp.linear.save_comment",
            "isError": true, "durationMs": 1700,
            "failureReason": "upstream error: Error: Could not find issue \"BIT-99999\""
        }))
        .as_deref(),
        Some("  ✗ mcp.linear.save_comment (1.7s): upstream error: Error: Could not find issue \"BIT-99999\"")
    );
}

/// The reason is runtime-supplied text: control characters cannot reach
/// the terminal, and an oversized one is cut rather than flooding it.
#[test]
fn a_failure_reason_is_made_safe_and_bounded() {
    let long = format!("timed out\n\u{1b}[2J{}", "x".repeat(500));
    let rendered = describe(&json!({
        "type": "toolCallCompleted", "commandId": "web_fetch",
        "isError": true, "durationMs": 30000, "failureReason": long
    }))
    .expect("a line");
    assert!(!rendered.contains('\u{1b}'), "{rendered:?}");
    assert!(!rendered.contains('\n'), "{rendered:?}");
    assert!(rendered.starts_with("  ✗ web_fetch (30.0s): timed out "), "{rendered:?}");
    assert!(rendered.chars().count() <= "  ✗ web_fetch (30.0s): ".chars().count() + 161, "{rendered:?}");
    assert!(rendered.ends_with('…'), "{rendered:?}");
}

/// A successful call never shows a reason, even if one were sent.
#[test]
fn a_successful_call_shows_no_reason() {
    assert_eq!(
        describe(&json!({
            "type": "toolCallCompleted", "commandId": "list_files",
            "isError": false, "durationMs": 4, "failureReason": "stale"
        }))
        .as_deref(),
        Some("  ✓ list_files (4ms)")
    );
}

#[test]
fn a_failed_tool_call_is_marked_differently() {
    let rendered = describe(&json!({
        "type": "toolCallCompleted", "commandId": "bash",
        "isError": true, "durationMs": 4
    }));
    assert_eq!(rendered.as_deref(), Some("  ✗ bash (4ms)"));
}

/// Guards the defect this module was rewritten for: keying on a field the
/// runtime does not send renders nothing at all.
#[test]
fn keys_on_type_not_kind() {
    assert_eq!(describe(&json!({"kind": "toolCallStarted", "commandId": "x"})), None);
    assert!(describe(&json!({"type": "toolCallStarted", "commandId": "x"})).is_some());
}

/// Observed on a live runtime; none deserves a line of attention.
#[test]
fn stays_quiet_for_lifecycle_bookkeeping() {
    for event_type in [
        "sessionStart",
        "inputReceived",
        "contextBuilt",
        "modelSelected",
        "beforeProviderRequest",
        "afterProviderResponse",
        "turnCompleted",
    ] {
        assert_eq!(describe(&json!({"type": event_type})), None, "{event_type}");
    }
}

#[test]
fn warns_that_tool_markup_ran_nothing() {
    let rendered = describe(&json!({"type": "unparsedToolCallMarkupDetected"}));
    assert!(rendered.is_some(), "the operator must be told nothing ran");
}

/// A call names what it acted on, so ten reads are ten different files.
#[test]
fn a_call_line_names_its_subject() {
    assert_eq!(
        describe(&json!({"type": "toolCallStarted", "commandId": "read_file", "subject": "src/a.ts"}))
            .as_deref(),
        Some("  → read_file src/a.ts")
    );
    assert_eq!(
        describe(&json!({
            "type": "toolCallCompleted", "commandId": "read_file", "subject": "src/a.ts",
            "isError": false, "durationMs": 4
        }))
        .as_deref(),
        Some("  ✓ read_file src/a.ts (4ms)")
    );
}

/// A command that exits non-zero ran without a tool error, so the runtime
/// does not call it a failure. It is still not a ✓: a model that ran the
/// tests and saw them fail can say they pass, and this line is what
/// contradicts it.
#[test]
fn a_non_zero_exit_is_marked_as_a_reported_problem() {
    assert_eq!(
        describe(&json!({
            "type": "toolCallCompleted", "commandId": "bash", "subject": "npm test",
            "isError": false, "durationMs": 3200, "resultStatus": "exit 1"
        }))
        .as_deref(),
        Some("  ! bash npm test (3.2s) · exit 1")
    );
    assert_eq!(
        describe(&json!({
            "type": "toolCallCompleted", "commandId": "bash", "subject": "npm test",
            "isError": false, "durationMs": 3200, "resultStatus": "exit 0"
        }))
        .as_deref(),
        Some("  ✓ bash npm test (3.2s) · exit 0")
    );
    assert_eq!(
        describe(&json!({
            "type": "toolCallCompleted", "commandId": "read_file", "subject": "missing.txt",
            "isError": false, "durationMs": 5,
            "resultStatus": "error: cannot read missing.txt: not found"
        }))
        .as_deref(),
        Some("  ! read_file missing.txt (5ms) · error: cannot read missing.txt: not found")
    );
}

#[test]
fn a_subject_is_made_safe_and_bounded() {
    let line = describe(&json!({
        "type": "toolCallStarted", "commandId": "bash",
        "subject": format!("echo \u{1b}[2J{}", "y".repeat(300))
    }))
    .expect("a line");
    assert!(!line.contains('\u{1b}'), "{line:?}");
    assert!(line.ends_with('…'), "{line:?}");
    assert!(line.chars().count() <= "  → bash ".chars().count() + 81, "{line:?}");
}

#[test]
fn durations_read_as_an_operator_reads_them() {
    use super::duration;
    assert_eq!(duration(999), "999ms");
    assert_eq!(duration(1_000), "1.0s");
    assert_eq!(duration(59_949), "59.9s");
    assert_eq!(duration(61_000), "1m01s");
    assert_eq!(duration(-5), "0ms");
}

#[test]
fn ignores_an_event_with_no_type() {
    assert_eq!(describe(&json!({"step": 1})), None);
}

#[test]
fn reports_the_step_limit_because_it_explains_a_short_turn() {
    assert!(describe(&json!({"type": "toolStepLimitReached"})).is_some());
}

/// The header `describeTimeout` writes, as the probe turn produced it.
#[test]
fn a_timeout_status_is_shortened_for_the_summary() {
    use super::short_status;
    assert_eq!(
        short_status("timed out after 3000ms (killed; output shown up to the deadline)"),
        "timed out after 3000ms"
    );
    assert_eq!(short_status("timed out after 3000ms (killed)"), "timed out after 3000ms");
    assert_eq!(short_status("exit 7"), "exit 7");
}

/// A runtime from before `resultStatus` reports no exit status for any
/// command, so a non-zero exit or a timeout is indistinguishable from a
/// clean exit. That is not a success.
#[test]
fn a_command_without_an_exit_status_is_not_shown_as_ok() {
    let line = describe(&json!({
        "type": "toolCallCompleted", "commandId": "bash", "subject": "npm test",
        "isError": false, "durationMs": 3200
    }));
    assert_eq!(line.as_deref(), Some("  ? bash npm test (3.2s) · exit status not reported"));
    // Other tools have no exit status to report.
    let read = describe(&json!({
        "type": "toolCallCompleted", "commandId": "read_file", "subject": "a.ts",
        "isError": false, "durationMs": 5
    }));
    assert_eq!(read.as_deref(), Some("  ✓ read_file a.ts (5ms)"));
}

/// A command that never started, as a current runtime reports it.
#[test]
fn a_command_that_did_not_run_is_a_problem() {
    let line = describe(&json!({
        "type": "toolCallCompleted", "commandId": "git", "subject": "status",
        "isError": false, "durationMs": 2, "resultStatus": "did not run"
    }));
    assert_eq!(line.as_deref(), Some("  ! git status (2ms) · did not run"));
}

#[test]
fn external_agent_equal_input_is_omitted_after_sanitizing() {
    for (title, input) in [("printf hello", "printf hello"), ("printf\thello", "printf hello")] {
        let line = describe(&json!({
            "type": "agentProgress", "kind": "tool_call", "toolCallId": "one",
            "title": title, "input": input, "status": "in_progress"
        }));
        assert_eq!(line.as_deref(), Some("  ▸ printf hello (external agent)"));
    }
}

#[test]
fn external_agent_equal_input_leaves_directory_only() {
    let line = describe(&json!({
        "type": "agentProgress", "kind": "tool_call", "toolCallId": "one",
        "title": "pwd", "input": "pwd", "cwd": "/elsewhere", "status": "in_progress"
    }));
    assert_eq!(line.as_deref(), Some("  ▸ pwd (external agent)\n      [in /elsewhere]"));
}

#[test]
fn external_agent_different_input_is_compared_before_cutting() {
    for cwd in [None, Some("/elsewhere")] {
        let mut event = json!({
            "type": "agentProgress", "kind": "tool_call", "toolCallId": "one",
            "title": "exit 3", "input": "sh -c 'exit 3'", "status": "in_progress"
        });
        if let Some(cwd) = cwd { event["cwd"] = json!(cwd); }
        let suffix = if cwd.is_some() { "  [in /elsewhere]" } else { "" };
        assert_eq!(describe(&event).unwrap(), format!("  ▸ exit 3 (external agent)\n      sh -c 'exit 3'{suffix}"));
    }
    let prefix = "x".repeat(80);
    let event = json!({
        "type": "agentProgress", "kind": "tool_call", "toolCallId": "one",
        "title": format!("{prefix}a"), "input": format!("{prefix}b"), "status": "in_progress"
    });
    assert_eq!(describe(&event).unwrap(), format!("  ▸ {prefix}… (external agent)\n      {prefix}…"));
}

#[test]
fn external_agent_constructed_command_and_read_lines() {
    let mut lines = Vec::new();
    for (id, title, input, locations, status) in [
        ("one", "printf 'activity-one\\n'", Some("printf 'activity-one\\n'"), None, "completed"),
        ("two", "exit 3", Some("sh -c 'exit 3'"), None, "failed"),
        ("three", "Read file 'CHANGELOG.md'", None, Some(vec!["CHANGELOG.md"]), "completed"),
    ] {
        lines.push(describe(&json!({
            "type": "agentProgress", "kind": "tool_call", "toolCallId": id,
            "title": title, "input": input, "locations": locations, "status": "in_progress"
        })).unwrap());
        lines.push(describe(&json!({
            "type": "agentProgress", "kind": "tool_call", "toolCallId": id,
            "title": title, "status": status
        })).unwrap());
    }
    assert_eq!(lines.join("\n"), "  ▸ printf 'activity-one\\n' (external agent)\n  ✓ printf 'activity-one\\n' (external agent)\n  ▸ exit 3 (external agent)\n      sh -c 'exit 3'\n  ✗ exit 3 (external agent)\n  ▸ Read file 'CHANGELOG.md' (external agent)\n      CHANGELOG.md\n  ✓ Read file 'CHANGELOG.md' (external agent)");
}

/// ACP progress names a call by title only; its end is one line.
#[test]
fn external_agent_tool_calls_end_with_a_line() {
    let progress = |status: &str| {
        describe(&json!({
            "type": "agentProgress", "kind": "tool_call", "title": "Run npm test", "status": status
        }))
    };
    assert_eq!(progress("in_progress"), None);
    assert_eq!(progress("completed").as_deref(), Some("  ✓ Run npm test (external agent)"));
    assert_eq!(progress("failed").as_deref(), Some("  ✗ Run npm test (external agent)"));
    assert_eq!(describe(&json!({"type": "agentProgress", "kind": "thought"})), None);
}

/// The contract makes `title` and `name` optional. A call with neither
/// still ends with a line.
#[test]
fn an_untitled_external_agent_call_still_ends_with_a_line() {
    let line = describe(&json!({"type": "agentProgress", "kind": "tool_call", "status": "failed"}));
    assert_eq!(line.as_deref(), Some("  ✗ external tool (external agent)"));
}

#[test]
fn child_approval_parked_renders_one_line_notice_without_prompt_text() {
    let line = describe(&json!({
        "type": "childApprovalParked",
        "sessionId": "01J00000000000000000000000",
        "childSessionId": "01J00000000000000000000001",
        "label": "impl",
        "prompt": "ignored-untrusted-prompt"
    }));
    assert_eq!(
        line.as_deref(),
        Some("impl (child) is waiting for approval: dyfj --session 01J00000000000000000000001")
    );
    assert_eq!(
        describe(&json!({
            "type": "childApprovalParked",
            "childSessionId": "01J00000000000000000000001",
            "label": "../bad"
        })),
        None
    );
    assert_eq!(
        describe(&json!({
            "type": "childApprovalParked",
            "childSessionId": "bad-id",
            "label": "impl"
        })),
        None
    );
}

#[test]
fn continuity_reconstructing_renders_each_reason_left_out_singular_and_unknown_code() {
    let cases = [
        (
            json!({
                "type": "continuityReconstructing",
                "sessionId": "01J00000000000000000000000",
                "reason": "idle_limit",
                "priorMessagesProjected": 4,
                "priorMessagesLeftOut": 0
            }),
            "· agent session replaced: it was closed after the idle limit. Sending 4 earlier messages.",
        ),
        (
            json!({
                "type": "continuityReconstructing",
                "sessionId": "01J00000000000000000000000",
                "reason": "capacity",
                "priorMessagesProjected": 4,
                "priorMessagesLeftOut": 0
            }),
            "· agent session replaced: it was closed to make room for another session. Sending 4 earlier messages.",
        ),
        (
            json!({
                "type": "continuityReconstructing",
                "sessionId": "01J00000000000000000000000",
                "reason": "agent_settings_changed",
                "priorMessagesProjected": 4,
                "priorMessagesLeftOut": 0
            }),
            "· agent session replaced: the model, effort, workspace or another agent setting changed. Sending 4 earlier messages.",
        ),
        (
            json!({
                "type": "continuityReconstructing",
                "sessionId": "01J00000000000000000000000",
                "reason": "agent_session_failed",
                "priorMessagesProjected": 4,
                "priorMessagesLeftOut": 0
            }),
            "· agent session replaced: it ended with an error. Sending 4 earlier messages.",
        ),
        (
            json!({
                "type": "continuityReconstructing",
                "sessionId": "01J00000000000000000000000",
                "reason": "released",
                "priorMessagesProjected": 4,
                "priorMessagesLeftOut": 0
            }),
            "· agent session replaced: the runtime released it after a one-shot or dispatched turn. Sending 4 earlier messages.",
        ),
        (
            json!({
                "type": "continuityReconstructing",
                "sessionId": "01J00000000000000000000000",
                "reason": "not_held",
                "priorMessagesProjected": 4,
                "priorMessagesLeftOut": 0
            }),
            "· agent session replaced: this runtime holds no agent session for it (for example after a restart). Sending 4 earlier messages.",
        ),
        (
            json!({
                "type": "continuityReconstructing",
                "sessionId": "01J00000000000000000000000",
                "reason": "idle_limit",
                "priorMessagesProjected": 20,
                "priorMessagesLeftOut": 4
            }),
            "· agent session replaced: it was closed after the idle limit. Sending 20 earlier messages, 4 left out.",
        ),
        (
            json!({
                "type": "continuityReconstructing",
                "sessionId": "01J00000000000000000000000",
                "reason": "released",
                "priorMessagesProjected": 1,
                "priorMessagesLeftOut": 0
            }),
            "· agent session replaced: the runtime released it after a one-shot or dispatched turn. Sending 1 earlier message.",
        ),
        (
            json!({
                "type": "continuityReconstructing",
                "sessionId": "01J00000000000000000000000",
                "reason": "not_held",
                "priorMessagesProjected": 1,
                "priorMessagesLeftOut": 2
            }),
            "· agent session replaced: this runtime holds no agent session for it (for example after a restart). Sending 1 earlier message, 2 left out.",
        ),
        (
            json!({
                "type": "continuityReconstructing",
                "sessionId": "01J00000000000000000000000",
                "reason": "future_unknown_code",
                "priorMessagesProjected": 3,
                "priorMessagesLeftOut": 0
            }),
            "· agent session replaced: reason not reported. Sending 3 earlier messages.",
        ),
    ];

    for (event, expected) in cases {
        assert_eq!(describe(&event).as_deref(), Some(expected));
    }
}

#[test]
fn plan_without_renderable_steps_or_omissions_prints_nothing() {
    for steps in [json!([]), json!([
        {"content":"Invalid", "status":"unknown"},
        {"content":42, "status":"pending"}
    ])] {
        assert_eq!(describe(&json!({"type":"agentProgress", "kind":"plan",
            "plan":{"steps":steps}})), None);
    }
    assert_eq!(describe(&json!({"type":"agentProgress", "kind":"plan",
        "plan":{"steps":[], "stepsOmitted":2}})).as_deref(),
        Some("  · plan (external agent)\n      … 2 more steps"));
}

#[test]
fn zero_count_update_prints_only_the_path() {
    assert_eq!(describe(&json!({"type":"agentProgress", "kind":"tool_call",
        "toolCallId":"edit", "toolKind":"edit", "title":"Editing files",
        "status":"in_progress", "fileChanges":{"files":[
            {"path":"src/moved.ts", "change":"update", "added":0, "removed":0, "lines":[]}
        ]}})).as_deref(),
        Some("  ▸ Editing files (external agent)\n      src/moved.ts"));
}
