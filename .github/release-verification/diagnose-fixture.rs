use std::{fs,io::{BufRead,BufReader,Read,Write},path::Path,process::{Command,Stdio},sync::mpsc,thread,time::{Duration,Instant}};
use std::os::windows::process::CommandExt;
fn run(name:&str,program:&Path,args:&[&str],cwd:&Path) {
    let start=Instant::now();
    let mut child=Command::new(program).args(args).current_dir(cwd).creation_flags(0x0800_0000)
        .stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::piped()).spawn().unwrap();
    let mut input=child.stdin.take().unwrap();
    input.write_all(b"{\"type\":\"control_request\",\"request_id\":\"models-init\",\"request\":{\"subtype\":\"initialize\",\"hooks\":{}}}\n").unwrap();
    let output=child.stdout.take().unwrap();
    let error=child.stderr.take().unwrap();
    let(tx,rx)=mpsc::channel();
    let reader=thread::spawn(move||for line in BufReader::new(output).lines(){let _=tx.send(line);});
    let errors=thread::spawn(move||{let mut text=String::new();BufReader::new(error).read_to_string(&mut text).unwrap();text});
    match rx.recv_timeout(Duration::from_secs(30)){Ok(line)=>println!("{name}: {:?} after {:?}",line,start.elapsed()),Err(e)=>println!("{name}: TIMEOUT {e} after {:?}",start.elapsed())}
    drop(input);
    let _=Command::new("taskkill.exe").args(["/PID",&child.id().to_string(),"/T","/F"]).stdout(Stdio::null()).stderr(Stdio::null()).status();
    let _=child.kill();let _=child.wait();let _=reader.join();
    println!("{name}: stderr={:?}",errors.join().unwrap());
}
fn main(){
    let directory=std::env::temp_dir().join(format!("tcplus-fixture-diagnostic-{}",std::process::id()));fs::create_dir_all(&directory).unwrap();
    let script=directory.join("fixture.ps1");
    fs::write(&script,r#"
$init = [Console]::ReadLine() | ConvertFrom-Json
if ($init.type -ne 'control_request' -or $init.request.subtype -ne 'initialize') { exit 2 }
[Console]::WriteLine('{"type":"control_response","response":{"subtype":"success","request_id":"models-init","response":{"models":[{"value":"sonnet","displayName":"Sonnet"}]}}}')
[Console]::ReadLine() | Out-Null
"#).unwrap();
    let batch=directory.join("fixture.cmd");
    fs::write(&batch,"@echo off\r\npowershell.exe -NoProfile -ExecutionPolicy Bypass -File \"%~dp0fixture.ps1\"\r\n").unwrap();
    run("claude-exact-batch",&batch,&["-p","--input-format","stream-json","--output-format","stream-json","--verbose","--no-session-persistence","--strict-mcp-config","--setting-sources","","--tools",""],&directory);
    run("batch-no-empty-arguments",&batch,&["app-server","--listen","stdio://"],&directory);
    run("powershell-direct",Path::new("powershell.exe"),&["-NoProfile","-ExecutionPolicy","Bypass","-File",script.to_str().unwrap()],&directory);
    run("claude-exact-batch-repeat",&batch,&["-p","--input-format","stream-json","--output-format","stream-json","--verbose","--no-session-persistence","--strict-mcp-config","--setting-sources","","--tools",""],&directory);
}
