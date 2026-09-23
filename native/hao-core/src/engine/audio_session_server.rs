//! Native process boundary for the resident audio controller. No listener,
//! website or executable from a message. Stdin/stdout belong to the caller.
use std::path::Path;
#[cfg(not(windows))]
pub fn run_server(_root: &Path, _decoder: &Path, _sha: &str) -> Result<(), String> {
    Err("resident audio IPC is not available on this platform yet".into())
}
#[cfg(windows)]
pub use windows::run_server;
#[cfg(windows)]
mod windows {
    use crate::engine::{
        audio_codec_pipe::DecoderAudit,
        audio_codec_stream::{CodecAudioStream, ValidatedDecoder},
        audio_device::physical_output_run_session,
        audio_session::{self, SessionClient, SessionCommand},
        audio_session_protocol::{EVENT_SCHEMA, MAX_SAFE_ID, WireCommand, local_absolute},
        audio_session_stdio::{self, Input, Output},
    };
    use serde_json::{Value, json};
    use std::{
        collections::BTreeMap,
        path::{Path, PathBuf},
        sync::{
            Arc,
            atomic::{AtomicBool, Ordering},
            mpsc::TryRecvError,
        },
        thread::{self, JoinHandle},
        time::{Duration, Instant},
    };

    struct Load {
        request: u64,
        generation: u64,
        path: PathBuf,
        sha: String,
        autoplay: bool,
    }
    struct Preparing {
        spec: Load,
        cancel: Arc<AtomicBool>,
        worker: Option<JoinHandle<Result<CodecAudioStream, String>>>,
    }
    fn bound_plan(root: &Path, path: &Path) -> Result<PathBuf, String> {
        if !local_absolute(path) {
            return Err("plan must be a local absolute path".into());
        }
        let resolved = std::fs::canonicalize(path).map_err(|e| format!("plan unavailable: {e}"))?;
        if !resolved.starts_with(root) || resolved == root || !resolved.is_file() {
            return Err("plan escaped broker-selected directory".into());
        }
        Ok(resolved)
    }
    impl Preparing {
        fn start(spec: Load, root: PathBuf, decoder: ValidatedDecoder) -> Result<Self, String> {
            let cancel = Arc::new(AtomicBool::new(false));
            let token = cancel.clone();
            let path = spec.path.clone();
            let sha = spec.sha.clone();
            let generation = spec.generation;
            let worker = thread::Builder::new()
                .name("editkin-session-prepare".into())
                .spawn(move || {
                    let path = bound_plan(&root, &path)?;
                    let reader = CodecAudioStream::open_with_decoder(&path, &sha, &decoder, token)?;
                    if reader.generation != generation {
                        return Err("plan generation differs from command".into());
                    }
                    Ok(reader)
                })
                .map_err(|e| e.to_string())?;
            Ok(Self {
                spec,
                cancel,
                worker: Some(worker),
            })
        }
        fn finished(&self) -> bool {
            self.worker.as_ref().is_some_and(|h| h.is_finished())
        }
        fn take(&mut self) -> Result<CodecAudioStream, String> {
            self.worker
                .take()
                .ok_or("prepare worker already taken")?
                .join()
                .map_err(|_| "prepare worker panicked")?
        }
        fn close(&mut self) -> Result<(), String> {
            if self.worker.is_none() {
                return Ok(());
            }
            self.cancel.store(true, Ordering::Release);
            let begun = Instant::now();
            while self.worker.as_ref().is_some_and(|h| !h.is_finished()) {
                audio_session_stdio::cancel_thread(self.worker.as_ref().unwrap());
                if begun.elapsed() > Duration::from_millis(2500) {
                    return Err("prepare worker failed to close".into());
                }
                thread::sleep(Duration::from_millis(2));
            }
            if self.worker.is_some() {
                let _ = self.take();
            }
            Ok(())
        }
    }
    impl Drop for Preparing {
        fn drop(&mut self) {
            let _ = self.close();
        }
    }
    struct Binding {
        request: u64,
        load: bool,
    }
    struct Control {
        sequence: u64,
        bindings: BTreeMap<u64, Binding>,
    }
    impl Control {
        fn send(
            &mut self,
            client: &SessionClient,
            request: u64,
            load: bool,
            make: impl FnOnce(u64) -> SessionCommand,
        ) -> Result<(), String> {
            if self.bindings.len() >= 128 {
                return Err("IPC command correlation capacity exceeded".into());
            }
            self.sequence = self
                .sequence
                .checked_add(1)
                .filter(|n| *n <= MAX_SAFE_ID)
                .ok_or("IPC sequence exhausted")?;
            client.submit(make(self.sequence))?;
            self.bindings
                .insert(self.sequence, Binding { request, load });
            Ok(())
        }
    }
    fn send(
        out: &mut Output,
        event: &str,
        request: u64,
        generation: u64,
        data: Value,
    ) -> Result<(), String> {
        out.send(&json!({"schema":EVENT_SCHEMA,"event":event,"requestId":request,"generation":generation,"data":data}))
    }
    fn retire_audit(out: &mut Output, generation: u64, audit: DecoderAudit) -> Result<(), String> {
        let entries = audit.lock().map_err(|_| "decoder audit poisoned")?.clone();
        if entries.iter().any(|v| {
            v["treeClosed"] != true
                || v["pipeThreadsClosed"] != true
                || !v["cleanupError"].is_null()
        }) {
            return Err("decoder tree/thread closure unproven".into());
        }
        // Validate every actual worker above, but do not let a long catalog
        // overflow the fixed wire envelope with per-clip diagnostics.
        let data = if entries.len() > 32 {
            json!({"decoderCount":entries.len(),"aggregate":true,"decoders":[{
                "treeClosed":true,"pipeThreadsClosed":true,"cleanupError":null,"validatedDecoderCount":entries.len()
            }]})
        } else {
            json!({"decoders":entries})
        };
        send(out, "decoder-closed", 0, generation, data)
    }
    pub fn run_server(root: &Path, decoder: &Path, sha: &str) -> Result<(), String> {
        if !local_absolute(root) {
            return Err("IPC plan directory must be local and absolute".into());
        }
        let root = std::fs::canonicalize(root).map_err(|e| e.to_string())?;
        if !root.is_dir() {
            return Err("IPC plan directory is not a directory".into());
        }
        // Bound, immutable executable validation once per server. Source validation
        // for each plan is cancellable and lives on the preparation worker below.
        let decoder = ValidatedDecoder::open(decoder, sha, &AtomicBool::new(false))?;
        let (input, mut input_worker) = audio_session_stdio::input()?;
        let mut output = Output::start()?;
        let (client, io) = audio_session::channel();
        let device = thread::Builder::new()
            .name("editkin-session-device".into())
            .spawn(move || physical_output_run_session(io))
            .map_err(|e| e.to_string())?;
        let mut control = Control {
            sequence: 0,
            bindings: BTreeMap::new(),
        };
        let mut preparing: Option<Preparing> = None;
        let mut queued: Option<Load> = None;
        let mut audits: BTreeMap<u64, DecoderAudit> = BTreeMap::new();
        let mut last_request = 0;
        let mut max_generation = 0;
        let mut closing = false;
        let result = (|| -> Result<u64, String> {
            'server: loop {
                if output.worker.finished() {
                    return Err("IPC output worker stopped".into());
                }
                // Drain a finite event batch, then admit one wire command; neither
                // event traffic nor expensive source hashing can monopolize control.
                for _ in 0..16 {
                    let Some(native) = client.try_receive()? else {
                        break;
                    };
                    let kind = native["event"]
                        .as_str()
                        .ok_or("native event kind missing")?
                        .to_owned();
                    let internal = native["requestId"]
                        .as_u64()
                        .ok_or("native request missing")?;
                    let generation = native["streamGeneration"]
                        .as_u64()
                        .ok_or("native generation missing")?;
                    let request = if internal == 0 {
                        0
                    } else {
                        control
                            .bindings
                            .get(&internal)
                            .ok_or("native event lost request correlation")?
                            .request
                    };
                    if kind == "loading" {
                        let retired = audits
                            .keys()
                            .copied()
                            .filter(|g| *g < generation)
                            .collect::<Vec<_>>();
                        for g in retired {
                            retire_audit(&mut output, g, audits.remove(&g).unwrap())?;
                        }
                        // Previous load event streams terminate at replacement.
                        let obsolete = control
                            .bindings
                            .iter()
                            .filter(|(seq, b)| **seq < internal && b.load)
                            .map(|(seq, _)| *seq)
                            .collect::<Vec<_>>();
                        for seq in obsolete {
                            control.bindings.remove(&seq);
                        }
                    }
                    let mut data = native.clone();
                    if kind == "ready" {
                        data["decoderIdentityChecks"] = 1.into();
                        data["controlTransport"] = "bounded-stdio/v1".into();
                    }
                    send(&mut output, &kind, request, generation, data)?;
                    if kind == "ended" {
                        if let Some(audit) = audits.remove(&generation) {
                            retire_audit(&mut output, generation, audit)?;
                        }
                        control.bindings.remove(&internal);
                    } else if internal != 0
                        && control.bindings.get(&internal).is_some_and(|b| !b.load)
                    {
                        control.bindings.remove(&internal);
                    }
                    if kind == "failed" {
                        return Err(native["reason"]
                            .as_str()
                            .unwrap_or("native device failed")
                            .into());
                    }
                    if kind == "closed" {
                        break 'server Ok(request);
                    }
                }
                if !closing {
                    match input.try_recv() {
                        Ok(Input::Eof) => return Err("controller input EOF before close".into()),
                        Err(TryRecvError::Disconnected) => {
                            return Err("input worker stopped or malformed command".into());
                        }
                        Err(TryRecvError::Empty) => {}
                        Ok(Input::Command(command)) => {
                            let request = command.request();
                            if request <= last_request {
                                send(
                                    &mut output,
                                    "rejected",
                                    request,
                                    0,
                                    json!({"reason":"stale or duplicate wire request"}),
                                )?;
                            } else {
                                last_request = request;
                                match command {
                                    WireCommand::Replace {
                                        request_id,
                                        generation,
                                        plan_path,
                                        plan_sha256,
                                        autoplay,
                                        ..
                                    } => {
                                        if generation <= max_generation {
                                            send(
                                                &mut output,
                                                "rejected",
                                                request,
                                                generation,
                                                json!({"reason":"stale wire generation"}),
                                            )?;
                                        } else {
                                            max_generation = generation;
                                            let spec = Load {
                                                request: request_id,
                                                generation,
                                                path: plan_path,
                                                sha: plan_sha256,
                                                autoplay,
                                            };
                                            if let Some(p) = preparing.as_ref() {
                                                if !p.cancel.swap(true, Ordering::AcqRel) {
                                                    send(
                                                        &mut output,
                                                        "superseded",
                                                        p.spec.request,
                                                        p.spec.generation,
                                                        Value::Null,
                                                    )?;
                                                }
                                                if let Some(old) = queued.take() {
                                                    send(
                                                        &mut output,
                                                        "superseded",
                                                        old.request,
                                                        old.generation,
                                                        Value::Null,
                                                    )?;
                                                }
                                                queued = Some(spec);
                                                send(
                                                    &mut output,
                                                    "queued",
                                                    request,
                                                    generation,
                                                    Value::Null,
                                                )?;
                                            } else {
                                                preparing = Some(Preparing::start(
                                                    spec,
                                                    root.clone(),
                                                    decoder.clone(),
                                                )?);
                                                send(
                                                    &mut output,
                                                    "preparing",
                                                    request,
                                                    generation,
                                                    Value::Null,
                                                )?;
                                            }
                                        }
                                    }
                                    WireCommand::Pause { generation, .. }
                                    | WireCommand::Resume { generation, .. } => {
                                        let play = matches!(command, WireCommand::Resume { .. });
                                        let mut pending = false;
                                        if let Some(p) = preparing.as_mut() {
                                            if p.spec.generation == generation
                                                && !p.cancel.load(Ordering::Acquire)
                                            {
                                                p.spec.autoplay = play;
                                                pending = true;
                                            }
                                        }
                                        if let Some(q) = queued.as_mut() {
                                            if q.generation == generation {
                                                q.autoplay = play;
                                                pending = true;
                                            }
                                        }
                                        if pending {
                                            send(
                                                &mut output,
                                                if play {
                                                    "resume-pending"
                                                } else {
                                                    "pause-pending"
                                                },
                                                request,
                                                generation,
                                                Value::Null,
                                            )?;
                                        } else {
                                            control.send(&client, request, false, |id| {
                                                if play {
                                                    SessionCommand::Resume {
                                                        request: id,
                                                        generation,
                                                    }
                                                } else {
                                                    SessionCommand::Pause {
                                                        request: id,
                                                        generation,
                                                    }
                                                }
                                            })?;
                                        }
                                    }
                                    WireCommand::Snapshot { .. } => {
                                        control.send(&client, request, false, |id| {
                                            SessionCommand::Snapshot { request: id }
                                        })?
                                    }
                                    WireCommand::Close { .. } => {
                                        closing = true;
                                        queued = None;
                                        if let Some(p) = preparing.as_ref() {
                                            p.cancel.store(true, Ordering::Release);
                                        }
                                        control.send(&client, request, false, |id| {
                                            SessionCommand::Close { request: id }
                                        })?;
                                        input_worker.close(false)?;
                                    }
                                }
                            }
                        }
                    }
                }
                if preparing.as_ref().is_some_and(|p| p.finished()) {
                    let mut p = preparing.take().unwrap();
                    let cancelled = p.cancel.load(Ordering::Acquire);
                    let prepared = p.take();
                    if !cancelled && !closing {
                        match prepared {
                            Ok(reader) => {
                                if audits.len() >= 8 {
                                    return Err("IPC active decoder audit capacity exceeded".into());
                                }
                                let audit = reader.audit.clone();
                                let playback = reader.into_prepared_playback()?;
                                let request = p.spec.request;
                                let autoplay = p.spec.autoplay;
                                control.send(&client, request, true, |id| {
                                    SessionCommand::Replace {
                                        request: id,
                                        playback,
                                        autoplay,
                                    }
                                })?;
                                audits.insert(p.spec.generation, audit);
                            }
                            Err(reason) => send(
                                &mut output,
                                "prepare-failed",
                                p.spec.request,
                                p.spec.generation,
                                json!({"reason":reason}),
                            )?,
                        }
                    }
                }
                if preparing.is_none() && !closing {
                    if let Some(spec) = queued.take() {
                        let request = spec.request;
                        let generation = spec.generation;
                        preparing = Some(Preparing::start(spec, root.clone(), decoder.clone())?);
                        send(&mut output, "preparing", request, generation, Value::Null)?;
                    }
                }
                thread::sleep(Duration::from_millis(1));
            }
        })();
        // Explicit closure executes on *every* result. Pipe cancellation refers only
        // to our own join handles; no user process/window is terminated here.
        drop(client);
        let mut problems = Vec::new();
        if let Some(p) = preparing.as_mut() {
            if let Err(e) = p.close() {
                problems.push(e);
            }
        }
        let loader_joined = preparing.as_ref().is_none_or(|p| p.worker.is_none());
        let input_result = input_worker.close(false);
        if let Err(e) = input_result {
            problems.push(e);
        }
        let input_joined = input_worker.finished();
        let begun = Instant::now();
        while !device.is_finished() && begun.elapsed() < Duration::from_millis(2500) {
            thread::sleep(Duration::from_millis(2));
        }
        let device_joined = device.is_finished();
        if device_joined {
            let outcome = device
                .join()
                .map_err(|_| "native device worker panicked".to_string());
            if result.is_ok() {
                if let Err(e) = outcome.and_then(|v| v) {
                    problems.push(e);
                }
            }
        } else {
            problems.push("native device worker failed to join".into());
        }
        let mut decoder_count = 0;
        for (generation, audit) in audits {
            if let Ok(rows) = audit.lock() {
                decoder_count += rows.len();
            }
            if let Err(e) = retire_audit(&mut output, generation, audit) {
                problems.push(e);
            }
        }
        let request = result.as_ref().copied().unwrap_or(0);
        let base_ok =
            result.is_ok() && problems.is_empty() && loader_joined && input_joined && device_joined;
        let final_event = json!({"inputWorkerJoined":input_joined,"prepareWorkerJoined":loader_joined,"deviceWorkerJoined":device_joined,
        "decoderIdentityChecks":1,"remainingDecoderRecords":decoder_count,"droppedProgress":output.dropped_progress});
        if let Err(e) = send(
            &mut output,
            if base_ok {
                "session-closed"
            } else {
                "session-failed"
            },
            request,
            0,
            final_event.clone(),
        ) {
            problems.push(e);
        }
        let output_result = output.close();
        if let Err(e) = output_result {
            problems.push(e);
        }
        let output_joined = output.worker.finished();
        let success = base_ok && problems.is_empty() && output_joined;
        eprintln!(
            "AUDIO_SESSION_IPC_CLEANUP {}",
            json!({"success":success,"inputWorkerJoined":input_joined,
        "prepareWorkerJoined":loader_joined,"deviceWorkerJoined":device_joined,"outputWorkerJoined":output_joined,
        "droppedProgress":output.dropped_progress,"errors":problems})
        );
        if success {
            Ok(())
        } else {
            Err(format!(
                "audio session IPC failed: {}; {}",
                result.err().unwrap_or_else(|| "closure failure".into()),
                problems.join("; ")
            ))
        }
    }
}
