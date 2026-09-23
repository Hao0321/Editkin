use super::*;

const FIXTURE: &str = r#"
import { createInterface } from 'node:readline';
import { spawn } from 'node:child_process';
import { appendFileSync, writeFileSync } from 'node:fs';
const schema = 'editkin.service-stream/v1';
const serviceArtifact = {schema:'editkin.auto-roto-service-artifact/v1',kind:'product',externalResearchRuntime:'disabled'};
console.log(JSON.stringify({schema, kind:'ready', pid:process.pid}));
for await (const line of createInterface({input:process.stdin})) {
  const {id,request} = JSON.parse(line);
  const p = request.payload;
  const command = p.action ?? request.command;
  if(p.counter) appendFileSync(p.counter, 'attempt\n');
  if(command === 'crash') process.exit(9);
  if(command === 'hang') { writeFileSync(p.started, String(process.pid)); await new Promise(()=>{}); }
  if(command === 'child') {
    const child = spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{windowsHide:true,stdio:'ignore'});
    console.log(JSON.stringify({schema,id,response:{serviceArtifact,ok:true,result:{pid:process.pid,child:child.pid}}})); continue;
  }
  if(command === 'stderr') process.stderr.write('x'.repeat(200000));
  console.log(JSON.stringify({schema,id:command==='wrong-id'?'stale':id,response:
    command==='error'?{serviceArtifact,ok:false,error:'fixture rejection'}:{serviceArtifact,ok:true,result:{pid:process.pid,value:p.responseBytes?'x'.repeat(p.responseBytes):p.value}}}));
}
"#;

struct Fixture { root: PathBuf, node: PathBuf, service: PathBuf }
impl Fixture {
    fn new() -> Self {
        static NEXT: AtomicU64 = AtomicU64::new(0);
        let base = PathBuf::from(std::env::var("EDITKIN_HOST_TEST_ROOT").expect("explicit isolated test root"));
        assert!(base.is_absolute());
        let root = base.join(format!("fixture-{}-{}", std::process::id(), NEXT.fetch_add(1, Ordering::Relaxed)));
        fs::create_dir_all(&root).unwrap();
        let service = root.join("worker.mjs");
        fs::write(&service, FIXTURE).unwrap();
        let node = PathBuf::from(std::env::var("EDITKIN_TEST_NODE").expect("explicit bundled Node"));
        Self {root,node,service}
    }
    fn request(&self, host:&ResidentService, command:&str, payload:Value) -> Result<Value,String> {
        host.request(&self.node,&self.service,json!({"command":command,"payload":payload}),Duration::from_secs(5))
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        // Only the unique directory created by this test; never source/media.
        if self.root.file_name().unwrap().to_string_lossy().starts_with("fixture-") {
            let _ = fs::remove_dir_all(&self.root);
        }
    }
}

#[test]
fn reuse_errors_and_stderr_preserve_one_worker() {
    let f=Fixture::new(); let host=ResidentService::default();
    let first=f.request(&host,"echo",json!({"value":"繁體中文"})).unwrap();
    assert_eq!(first["result"]["value"],"繁體中文");
    assert_eq!(f.request(&host,"error",json!({})).unwrap()["ok"],false);
    let next=f.request(&host,"stderr",json!({"value":42})).unwrap();
    assert_eq!(first["result"]["pid"],next["result"]["pid"]);
    host.shutdown(); assert!(lock(&host.worker).is_none());
    assert!(f.request(&host,"echo",json!({})).unwrap_err().contains("shut down"));
}

#[test]
fn crash_is_not_replayed_and_next_generation_can_start() {
    let f=Fixture::new(); let host=ResidentService::default();
    let counter=f.root.join("attempts.txt");
    let error=f.request(&host,"crash",json!({"counter":counter})).unwrap_err();
    assert!(error.contains("not replayed"),"{error}");
    assert_eq!(fs::read_to_string(counter).unwrap(),"attempt\n");
    assert!(f.request(&host,"echo",json!({})).unwrap()["ok"].as_bool().unwrap());
    host.shutdown(); assert!(lock(&host.worker).is_none());
}

#[test]
fn wrong_id_is_rejected_and_worker_retired() {
    let f=Fixture::new(); let host=ResidentService::default();
    let error=f.request(&host,"wrong-id",json!({})).unwrap_err();
    assert!(error.contains("ID mismatch"),"{error}");
    assert!(lock(&host.worker).is_none());
    assert_eq!(f.request(&host,"echo",json!({})).unwrap()["ok"],true);
}

#[test]
fn deadline_kills_worker_without_replay() {
    let f=Fixture::new(); let host=ResidentService::default();
    f.request(&host,"echo",json!({})).unwrap();
    let started=f.root.join("started");
    let before=Instant::now();
    let result=host.request(&f.node,&f.service,json!({"command":"hang","payload":{"started":started}}),Duration::from_millis(250));
    assert!(result.unwrap_err().contains("not replayed"));
    assert!(before.elapsed()<Duration::from_secs(3));
    assert!(started.exists()); assert!(lock(&host.worker).is_none());
    assert_eq!(f.request(&host,"echo",json!({})).unwrap()["ok"],true);
}

#[test]
fn queue_timeout_does_not_cancel_active_job_and_shutdown_wakes_it() {
    let f=Fixture::new(); let host=Arc::new(ResidentService::default());
    f.request(&host,"echo",json!({})).unwrap();
    let started=f.root.join("started"); let other=host.clone(); let node=f.node.clone(); let service=f.service.clone(); let marker=started.clone();
    let active=thread::spawn(move||other.request(&node,&service,json!({"command":"hang","payload":{"started":marker}}),Duration::from_secs(5)));
    let deadline=Instant::now()+Duration::from_secs(2);
    while !started.exists() && Instant::now()<deadline { thread::sleep(POLL); }
    assert!(started.exists());
    let result=host.request(&f.node,&f.service,json!({"command":"echo","payload":{}}),Duration::from_millis(60));
    assert!(result.unwrap_err().contains("not submitted"));
    assert!(lock(&host.worker).as_ref().unwrap().is_alive().unwrap());
    host.shutdown(); assert!(active.join().unwrap().is_err());
    assert!(lock(&host.worker).is_none());
}

#[test]
fn shutdown_proves_owned_descendant_tree_empty() {
    let f=Fixture::new(); let host=ResidentService::default();
    let result=f.request(&host,"child",json!({})).unwrap();
    assert!(result["result"]["child"].as_u64().unwrap()>0);
    let owned=lock(&host.worker).as_ref().unwrap().clone();
    assert!(!lock(&owned.process).tree_is_empty().unwrap());
    host.shutdown();
    assert!(lock(&owned.process).tree_is_empty().unwrap());
    assert!(lock(&owned.cleanup).as_ref().unwrap().is_ok());
}

#[test]
fn oversized_request_never_launches_worker() {
    let f=Fixture::new(); let host=ResidentService::default();
    let error=f.request(&host,"echo",json!({"value":"x".repeat(MAX_REQUEST)})).unwrap_err();
    assert!(error.contains("not submitted")); assert!(lock(&host.worker).is_none());
}

#[test]
fn real_product_cli_pool_preserves_project_write_conflicts() {
    let f = Fixture::new();
    let service = PathBuf::from(std::env::var("EDITKIN_TEST_SERVICE_CANDIDATE").expect("fresh actual CLI bundle"));
    let fixture = PathBuf::from(std::env::var("EDITKIN_TEST_PROJECT_FIXTURE").expect("real EditGraph fixture"));
    let project: Value = serde_json::from_slice(&fs::read(fixture).unwrap()).unwrap();
    let pool = crate::service_pool::ServicePool::default();
    let call = |command: &str, payload: Value| pool.request(&f.node, &service, command, json!({"command":command,"payload":payload}));
    let parsed = call("parse_project", json!({"project": project})).unwrap();
    assert_eq!(parsed["ok"], true);
    let path = f.root.join("saved.editkin.json");
    let created = call("write_project", json!({"path":path,"project":parsed["result"],"expectedRevision":null})).unwrap();
    assert_eq!(created["ok"], true);
    // null is deliberately Save As / force-save, not create-only. A stale
    // explicit revision must fail without changing the on-disk project.
    let conflict = call("write_project", json!({"path":path,"project":parsed["result"],"expectedRevision":parsed["result"]["revision"]})).unwrap();
    assert_eq!(conflict["ok"], false);
    let readback = call("read_project", json!({"path":path})).unwrap();
    assert_eq!(readback["ok"], true);
    assert_eq!(readback["result"], created["result"]);
    let next = call("write_project", json!({"path":path,"project":readback["result"],"expectedRevision":readback["result"]["revision"]})).unwrap();
    assert_eq!(next["ok"], true);
    assert_eq!(next["result"]["revision"].as_u64().unwrap(), created["result"]["revision"].as_u64().unwrap() + 1);
    pool.shutdown();
}

#[test]
fn preview_limits_fail_before_spawn_or_retire_oversized_response() {
    let f = Fixture::new(); let host = ResidentService::for_preview();
    assert!(f.request(&host, "echo", json!({"value":"x".repeat(65_536)})).unwrap_err().contains("not submitted"));
    assert!(lock(&host.worker).is_none());
    let error = f.request(&host, "echo", json!({"responseBytes":1_048_576})).unwrap_err();
    assert!(error.contains("1048576 byte frame limit"), "{error}");
    assert!(lock(&host.worker).is_none());
    assert_eq!(f.request(&host, "echo", json!({"value":7})).unwrap()["result"]["value"], 7);
}

#[test]
fn canceled_before_admission_never_resolves_runtime_or_spawns() {
    let host = ResidentService::for_preview(); let cancel = AtomicBool::new(true);
    let result = host.request_with_cancel(Path::new("absent"), Path::new("absent"), json!({}), Duration::from_secs(1), Some(&cancel));
    assert!(result.unwrap_err().contains("canceled"));
    assert!(lock(&host.worker).is_none());
}

#[test]
fn blocked_preview_does_not_block_second_preview_or_project_and_cancel_recovers() {
    let f = Fixture::new();
    let pool = Arc::new(crate::service_pool::ServicePool::default());
    let cancel = Arc::new(AtomicBool::new(false));
    let started = f.root.join("preview-started");
    let p = pool.clone(); let c = cancel.clone();
    let node = f.node.clone(); let service = f.service.clone(); let marker = started.clone();
    let active = thread::spawn(move || p.request_preview(&node, &service,
        json!({"command":"resolve_creative_preview","payload":{"action":"hang","started":marker}}), &c));
    let deadline = Instant::now() + Duration::from_secs(3);
    while !started.exists() && Instant::now() < deadline { thread::sleep(POLL); }
    assert!(started.exists());
    let first_pid: u64 = fs::read_to_string(&started).unwrap().parse().unwrap();
    let other_cancel = AtomicBool::new(false);
    let preview = || pool.request_preview(&f.node, &f.service,
        json!({"command":"resolve_creative_preview","payload":{"value":9}}), &other_cancel).unwrap();
    let second = preview();
    assert_ne!(second["result"]["pid"].as_u64().unwrap(), first_pid);
    assert_eq!(preview()["result"]["pid"], second["result"]["pid"]);
    let project = || pool.request(&f.node, &f.service, "parse_project",
        json!({"command":"parse_project","payload":{"value":73}})).unwrap();
    let control = project();
    assert_eq!(control["result"]["value"], 73);
    assert_ne!(control["result"]["pid"], second["result"]["pid"]);
    let before_cancel = Instant::now();
    cancel.store(true, Ordering::Release);
    let error = active.join().unwrap().unwrap_err();
    assert!(error.contains("canceled") && error.contains("cleanup confirmed"), "{error}");
    assert!(before_cancel.elapsed() < Duration::from_secs(3));
    assert_eq!(project()["result"]["pid"], control["result"]["pid"]);
    assert_eq!(preview()["result"]["value"], 9);
    pool.shutdown();
}

#[test]
fn real_product_cli_pool_resolves_verified_creative_previews() {
    let f = Fixture::new();
    let service = PathBuf::from(std::env::var("EDITKIN_TEST_SERVICE_CANDIDATE").expect("fresh actual CLI bundle"));
    let pack = PathBuf::from(std::env::var("EDITKIN_TEST_CREATIVE_PACK").expect("read-only real Creative Pack"));
    let manifest: Value = serde_json::from_slice(&fs::read(pack.join("editkin-pack.json")).unwrap()).unwrap();
    let id = "owner-visual:7fde9fa7913853f4261e";
    let asset = manifest["assets"].as_array().unwrap().iter().find(|asset| asset["id"] == id).unwrap();
    let pool = crate::service_pool::ServicePool::default(); let cancel = AtomicBool::new(false);
    let call = |mode: &str| pool.request_preview(&f.node, &service,
        json!({"command":"resolve_creative_preview","payload":{"assetId":id,"mode":mode},"runtime":{"creativePackRoot":pack}}), &cancel).unwrap();
    for mode in ["poster", "media", "poster"] {
        let response = call(mode); assert_eq!(response["ok"], true, "{response}");
        let result = &response["result"];
        assert_eq!(result["asset"]["id"], id);
        assert_eq!(result["asset"]["license"], asset["license"]);
        assert_eq!(result["asset"]["rightsBasis"], asset["rightsBasis"]);
        assert_eq!(result["sha256"], asset["derivatives"][mode]["sha256"]);
        assert_eq!(fs::canonicalize(result["absolutePath"].as_str().unwrap()).unwrap(),
            fs::canonicalize(pack.join(asset["derivatives"][mode]["path"].as_str().unwrap())).unwrap());
    }
    assert_eq!(call("source")["ok"], false, "invalid preview mode must not become a source request");
    assert_eq!(call("poster")["ok"], true, "a rejected command must not poison the resident worker");
    pool.shutdown();
}
