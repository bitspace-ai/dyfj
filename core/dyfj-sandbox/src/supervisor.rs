//! The root side of the launcher: install a role's nftables rules, drop to the
//! role's uid and start its bubblewrap sandbox; and, for a run, supervise the
//! pair: start the runtime, serve the executor transport to it alone, run each
//! command in a fresh executor sandbox, and kill every executor the moment the
//! runtime exits.

use crate::attest;
use crate::lease::Lease;
use crate::plan::LaunchPlan;
use crate::protocol::{self, Attestation, Outcome, Probe, Request, Termination};
use std::io::{Read, Write};
use std::os::unix::fs::{MetadataExt, PermissionsExt};
use std::os::unix::net::{UnixListener, UnixStream};
use std::os::unix::process::CommandExt;
use std::path::Path;
use std::process::{Child, Command, Stdio};
use crate::gate::Gate;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

const NFT: &str = "/usr/sbin/nft";
/// Output kept per stream; the rest is read and discarded. Two full streams,
/// even fully escaped as JSON, stay inside the client's reply cap.
const MAX_STREAM_BYTES: usize = 1024 * 1024;
/// Requests in flight at once; a connection past this is closed unread.
pub const MAX_CONNECTIONS: usize = 16;
/// How long a connection may take to send its whole request line.
const REQUEST_DEADLINE: Duration = Duration::from_secs(10);
/// How long a reply may wait for the runtime to read it.
const REPLY_DEADLINE: Duration = Duration::from_secs(10);
/// How long the enforcement probe may take; its connect gives up after 3 s.
const PROBE_DEADLINE: Duration = Duration::from_secs(15);

fn fail(message: impl Into<String>) -> String {
    message.into()
}

/// A plan file the launcher trusts: owned by root and writable by no one else.
pub fn load_plan(path: &str) -> Result<LaunchPlan, String> {
    let meta = std::fs::metadata(path).map_err(|e| fail(format!("{path}: {e}")))?;
    if meta.uid() != 0 || meta.mode() & 0o022 != 0 {
        return Err(fail(format!("{path}: a plan must be owned by root and not group- or world-writable")));
    }
    let text = std::fs::read_to_string(path).map_err(|e| fail(format!("{path}: {e}")))?;
    LaunchPlan::parse(&text)
}

pub fn require_root() -> Result<(), String> {
    // SAFETY: geteuid has no preconditions.
    if unsafe { libc::geteuid() } != 0 {
        return Err("the launcher must run as root".into());
    }
    Ok(())
}

pub fn install_nftables(plan: &LaunchPlan) -> Result<(), String> {
    let mut child = Command::new(NFT)
        .args(["-f", "-"])
        .env_clear()
        .stdin(Stdio::piped())
        .spawn()
        .map_err(|e| fail(format!("nft: {e}")))?;
    child
        .stdin
        .take()
        .expect("piped")
        .write_all(plan.nftables.as_bytes())
        .map_err(|e| fail(format!("nft: {e}")))?;
    let status = child.wait().map_err(|e| fail(format!("nft: {e}")))?;
    if !status.success() {
        return Err(fail(format!("nft refused the {:?} ruleset", plan.role)));
    }
    Ok(())
}

/// `argv` (a `bwrap` command line) as the plan's role: no supplementary
/// groups, its gid and uid, its process limit, in its own process group.
fn role_command(plan: &LaunchPlan, argv: &[String]) -> Command {
    let mut command = Command::new(&argv[0]);
    command.args(&argv[1..]).env_clear();
    let (uid, gid, nproc) = (plan.uid, plan.gid, plan.max_processes);
    // SAFETY: only async-signal-safe calls between fork and exec.
    unsafe {
        command.pre_exec(move || {
            if libc::setgroups(0, std::ptr::null()) != 0
                || libc::setgid(gid) != 0
                || libc::setuid(uid) != 0
            {
                return Err(std::io::Error::last_os_error());
            }
            if let Some(n) = nproc {
                let limit = libc::rlimit { rlim_cur: n, rlim_max: n };
                if libc::setrlimit(libc::RLIMIT_NPROC, &limit) != 0 {
                    return Err(std::io::Error::last_os_error());
                }
            }
            Ok(())
        });
    }
    command.process_group(0);
    command
}

fn environment() -> Vec<(String, String)> {
    std::env::vars().collect()
}

/// Runs `command` once as the plan's role, with this process's environment
/// filtered to the plan's names, and returns its exit code.
pub fn run(plan: &LaunchPlan, cwd: Option<&str>, command: &[String]) -> Result<i32, String> {
    install_nftables(plan)?;
    let argv = plan.argv(cwd, &environment(), command)?;
    let status = role_command(plan, &argv)
        .status()
        .map_err(|e| fail(format!("bwrap: {e}")))?;
    Ok(status.code().unwrap_or(128 + status.signal_number()))
}

trait SignalNumber {
    fn signal_number(&self) -> i32;
}

impl SignalNumber for std::process::ExitStatus {
    fn signal_number(&self) -> i32 {
        use std::os::unix::process::ExitStatusExt;
        self.signal().unwrap_or(0)
    }
}

fn signal_name(signal: i32) -> String {
    match signal {
        libc::SIGKILL => "SIGKILL".into(),
        libc::SIGTERM => "SIGTERM".into(),
        libc::SIGINT => "SIGINT".into(),
        libc::SIGSEGV => "SIGSEGV".into(),
        libc::SIGABRT => "SIGABRT".into(),
        other => format!("SIG{other}"),
    }
}

fn kill(pid: i32) {
    // SAFETY: plain kill on a pid this process started.
    unsafe {
        libc::kill(pid, libc::SIGKILL);
    }
}

fn collect<R: Read + Send + 'static>(mut stream: R) -> std::thread::JoinHandle<String> {
    std::thread::spawn(move || {
        let mut kept = Vec::new();
        let mut buffer = [0u8; 8192];
        while let Ok(n) = stream.read(&mut buffer) {
            if n == 0 {
                break;
            }
            let room = MAX_STREAM_BYTES.saturating_sub(kept.len());
            kept.extend_from_slice(&buffer[..n.min(room)]);
        }
        String::from_utf8_lossy(&kept).into_owned()
    })
}

fn peer_uid(stream: &UnixStream) -> Option<u32> {
    use std::os::fd::AsRawFd;
    // SAFETY: an all-zero ucred is a valid out buffer.
    let mut cred: libc::ucred = unsafe { std::mem::zeroed() };
    let mut len = std::mem::size_of::<libc::ucred>() as libc::socklen_t;
    // SAFETY: stream is open and cred/len describe a valid buffer.
    let rc = unsafe {
        libc::getsockopt(
            stream.as_raw_fd(),
            libc::SOL_SOCKET,
            libc::SO_PEERCRED,
            &mut cred as *mut libc::ucred as *mut libc::c_void,
            &mut len,
        )
    };
    (rc == 0).then_some(cred.uid)
}

/// The request line, read within `REQUEST_DEADLINE` and the size cap; an
/// idle, slow or oversized sender gets nothing.
fn read_request(stream: &mut UnixStream) -> Result<Vec<u8>, String> {
    let started = Instant::now();
    let mut line = Vec::new();
    let mut buffer = [0u8; 8192];
    loop {
        let left = REQUEST_DEADLINE.checked_sub(started.elapsed()).ok_or("request deadline passed")?;
        stream.set_read_timeout(Some(left.max(Duration::from_millis(1)))).map_err(|e| e.to_string())?;
        let n = stream.read(&mut buffer).map_err(|e| e.to_string())?;
        if n == 0 {
            return Err("connection closed before a request line".into());
        }
        line.extend_from_slice(&buffer[..n]);
        if let Some(end) = line.iter().position(|b| *b == b'\n') {
            line.truncate(end);
            return Ok(line);
        }
        if line.len() > protocol::MAX_REQUEST_BYTES {
            return Err("request too large".into());
        }
    }
}

/// The files and facts a pair was started from, for `attest` (BIT-736).
pub struct ServeFiles {
    pub executor_plan: String,
    pub executor_policy: Option<String>,
    pub grant: Option<String>,
}

struct Attested {
    instance: String,
    landlock_abi: i32,
    files: ServeFiles,
    /// The plan and policy files' bytes as loaded.
    plan_bytes: Vec<u8>,
    policy: Option<(serde_json::Value, Vec<u8>)>,
    probe: Probe,
}

impl Attested {
    /// The attestation for `nonce`. The files are read again, so a changed
    /// plan, policy or grant shows in the next answer.
    fn answer(&self, nonce: String, lease: &Mutex<Lease>) -> Attestation {
        let now = |path: &str| attest::read_trusted(path).ok();
        let plan_same = now(&self.files.executor_plan).as_ref() == Some(&self.plan_bytes);
        let policy_same = match (&self.files.executor_policy, &self.policy) {
            (Some(path), Some((_, bytes))) => now(path).as_ref() == Some(bytes),
            _ => true,
        };
        let policy_digest = self.policy.as_ref().and_then(|(value, _)| attest::policy_digest(value));
        let (grant, grant_refusal) = match policy_digest {
            Some(digest) => attest::grant_status(self.files.grant.as_deref(), digest),
            None => (None, None),
        };
        Attestation {
            nonce,
            instance: self.instance.clone(),
            landlock_abi: self.landlock_abi,
            lease: if lease.lock().expect("lease lock").is_live() { "live" } else { "expired" },
            executor_policy: self.policy.as_ref().map(|(value, _)| value.clone()),
            files_unchanged: plan_same && policy_same,
            grant,
            grant_refusal,
            probe: self.probe.clone(),
        }
    }
}

/// One transport request: attest, or run a command in a fresh executor
/// sandbox, and answer.
fn serve_one(
    mut stream: UnixStream,
    executor: &LaunchPlan,
    lease: &Mutex<Lease>,
    attested: &Attested,
) -> Result<(), String> {
    let line = read_request(&mut stream)?;
    stream.set_write_timeout(Some(REPLY_DEADLINE)).map_err(|e| e.to_string())?;
    let mut writer = stream;
    let answer = |writer: &mut UnixStream, text: String| writer.write_all(text.as_bytes()).map_err(|e| e.to_string());

    let request = match protocol::parse_request(line.trim_ascii_end()) {
        Ok(Request::Exec(request)) => request,
        Ok(Request::Attest { nonce }) => {
            return answer(&mut writer, protocol::attestation(&attested.answer(nonce, lease)));
        }
        Err(reason) => return answer(&mut writer, protocol::refusal(&reason)),
    };
    if !attest::binding_matches(request.binding.as_deref(), &attested.instance) {
        return answer(&mut writer, protocol::refusal("attestation mismatch"));
    }
    let env: Vec<(String, String)> = request.env.into_iter().collect();
    let argv = match executor.argv(Some(&request.cwd), &env, &request.argv) {
        Ok(argv) => argv,
        Err(reason) => return answer(&mut writer, protocol::refusal(&reason)),
    };

    let mut child: Child = {
        let mut held = lease.lock().expect("lease lock");
        if !held.is_live() {
            return answer(&mut writer, protocol::refusal("lease expired"));
        }
        let child = role_command(executor, &argv)
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .map_err(|e| e.to_string())?;
        held.admit(child.id() as i32);
        child
    };
    let pid = child.id() as i32;
    let stdout = collect(child.stdout.take().expect("piped"));
    let stderr = collect(child.stderr.take().expect("piped"));

    let deadline = Instant::now() + Duration::from_millis(request.timeout_ms);
    let mut timed_out = false;
    let status = loop {
        match child.try_wait().map_err(|e| e.to_string())? {
            Some(status) => break status,
            None if Instant::now() >= deadline => {
                timed_out = true;
                // The sandbox's init dies with bwrap, and the kernel then ends
                // every process in its PID namespace.
                kill(pid);
                break child.wait().map_err(|e| e.to_string())?;
            }
            None => std::thread::sleep(Duration::from_millis(10)),
        }
    };
    lease.lock().expect("lease lock").release(pid);
    let (stdout, stderr) = (stdout.join().unwrap_or_default(), stderr.join().unwrap_or_default());
    let signal = status.signal_number();
    answer(
        &mut writer,
        protocol::reply(&Outcome {
            code: status.code(),
            signal: (signal != 0).then(|| signal_name(signal)),
            stdout,
            stderr,
            timed_out,
            termination: timed_out.then_some(Termination {
                group: "stopped",
                exited: true,
                output_closed: true,
            }),
        }),
    )
}

/// Runs the enforcement probe in a fresh executor sandbox, before any request
/// is served, and records what it saw and how long it took.
fn run_probe(executor: &LaunchPlan) -> Probe {
    let failed = |ms: u64| Probe { passed: false, connect: "none".into(), write: "none".into(), ms };
    let started = Instant::now();
    let Some(cwd) = executor.writable_targets.first() else { return failed(0) };
    let env = vec![("PATH".to_string(), "/usr/local/bin:/usr/bin:/bin".to_string())];
    let command = ["node".to_string(), "-e".to_string(), attest::PROBE_SCRIPT.to_string()];
    let Ok(argv) = executor.argv(Some(cwd), &env, &command) else { return failed(0) };
    let Ok(mut child) = role_command(executor, &argv)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
    else {
        return failed(0);
    };
    let stdout = collect(child.stdout.take().expect("piped"));
    let deadline = started + PROBE_DEADLINE;
    loop {
        match child.try_wait() {
            Ok(Some(_)) => break,
            Ok(None) if Instant::now() < deadline => std::thread::sleep(Duration::from_millis(5)),
            _ => {
                kill(child.id() as i32);
                let _ = child.wait();
                return failed(started.elapsed().as_millis() as u64);
            }
        }
    }
    let ms = started.elapsed().as_millis() as u64;
    let (passed, connect, write) = attest::probe_verdict(&stdout.join().unwrap_or_default());
    Probe { passed, connect, write, ms }
}

fn bind_socket(path: &str, runtime: &LaunchPlan) -> Result<UnixListener, String> {
    let socket = Path::new(path);
    let dir = socket.parent().ok_or("socket path has no directory")?;
    std::fs::create_dir_all(dir).map_err(|e| fail(format!("{}: {e}", dir.display())))?;
    std::os::unix::fs::chown(dir, Some(0), Some(runtime.gid)).map_err(|e| e.to_string())?;
    std::fs::set_permissions(dir, std::fs::Permissions::from_mode(0o750)).map_err(|e| e.to_string())?;
    let _ = std::fs::remove_file(socket);
    let listener = UnixListener::bind(socket).map_err(|e| fail(format!("{path}: {e}")))?;
    std::os::unix::fs::chown(socket, Some(0), Some(runtime.gid)).map_err(|e| e.to_string())?;
    std::fs::set_permissions(socket, std::fs::Permissions::from_mode(0o660)).map_err(|e| e.to_string())?;
    Ok(listener)
}

/// Runs a contained pair: `command` as the runtime, and the executor
/// transport at `socket` for it alone. Returns when the runtime exits.
pub fn serve(
    runtime: LaunchPlan,
    executor: LaunchPlan,
    files: ServeFiles,
    socket: &str,
    command: &[String],
) -> Result<i32, String> {
    let plan_bytes = attest::read_trusted(&files.executor_plan)?;
    let policy = match &files.executor_policy {
        None => None,
        Some(path) => {
            let bytes = attest::read_trusted(path)?;
            let value: serde_json::Value =
                serde_json::from_slice(&bytes).map_err(|e| fail(format!("{path}: {e}")))?;
            if attest::policy_digest(&value) != Some(executor.policy_digest.as_str()) {
                return Err(fail(format!("{path}: its digest is not the executor plan's policy digest")));
            }
            Some((value, bytes))
        }
    };
    install_nftables(&runtime)?;
    install_nftables(&executor)?;
    let probe = run_probe(&executor);
    eprintln!(
        "dyfj-sandbox: enforcement probe {} in {} ms (connect {}, write {})",
        if probe.passed { "passed" } else { "FAILED" },
        probe.ms,
        probe.connect,
        probe.write
    );
    let attested = Arc::new(Attested {
        instance: attest::new_instance()?,
        landlock_abi: crate::landlock::abi()?,
        files,
        plan_bytes,
        policy,
        probe,
    });
    let listener = bind_socket(socket, &runtime)?;

    let mut env = environment();
    env.retain(|(key, _)| key != "DYFJ_EXECUTOR_SOCKET");
    env.push(("DYFJ_EXECUTOR_SOCKET".into(), socket.into()));
    let argv = runtime.argv(None, &env, command)?;
    let mut child = role_command(&runtime, &argv).spawn().map_err(|e| fail(format!("bwrap: {e}")))?;
    eprintln!(
        "dyfj-sandbox: runtime {} started (policy {}, execute scope {:?})",
        child.id(),
        runtime.policy_digest,
        runtime.execute_scope
    );

    let lease = Arc::new(Mutex::new(Lease::default()));
    let watcher = {
        let lease = Arc::clone(&lease);
        let socket = socket.to_string();
        std::thread::spawn(move || {
            let status = child.wait();
            let running = lease.lock().expect("lease lock").expire();
            for pid in &running {
                kill(*pid);
            }
            let _ = std::fs::remove_file(&socket);
            eprintln!(
                "dyfj-sandbox: runtime exited ({status:?}); lease expired; killed {} executor(s)",
                running.len()
            );
            let code = status.map(|s| s.code().unwrap_or(128 + s.signal_number())).unwrap_or(1);
            std::process::exit(code);
        })
    };

    let runtime_uid = runtime.uid;
    let executor = Arc::new(executor);
    let gate = Gate::new(MAX_CONNECTIONS);
    for stream in listener.incoming() {
        let Ok(stream) = stream else { continue };
        if peer_uid(&stream) != Some(runtime_uid) {
            continue;
        }
        let Some(pass) = gate.enter() else { continue };
        let (executor, lease, attested) = (Arc::clone(&executor), Arc::clone(&lease), Arc::clone(&attested));
        std::thread::spawn(move || {
            if let Err(e) = serve_one(stream, &executor, &lease, &attested) {
                eprintln!("dyfj-sandbox: executor request failed: {e}");
            }
            drop(pass);
        });
    }
    let _ = watcher.join();
    Ok(1)
}
