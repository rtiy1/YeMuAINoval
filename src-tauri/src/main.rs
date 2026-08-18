// 叙事工坊 · YeMu AI Novel 桌面壳
//
// 职责：
//   1. 开发模式（tauri dev）：beforeDevCommand 已通过 `desktop:api` 以本地模式
//      启动 Bun 服务（固定 127.0.0.1:8787），这里只等待其就绪后把 webview 指过去。
//   2. 生产模式：把随包分发的 Bun 运行时（externalBin sidecar）以 AUTH_MODE=local
//      启动，随机端口 + 端口文件回传，webview 加载 127.0.0.1:<port>。
//   3. 本地数据（db.json、skill-market、auth-secret）统一放系统应用数据目录。
//   4. 应用退出时回收 Bun 子进程。
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::fmt::Write;
use std::fs;
use std::net::{SocketAddr, TcpStream};
use std::path::PathBuf;
use std::sync::Mutex;
use std::time::Duration;

use tauri::{Manager, RunEvent, WebviewUrl, WebviewWindowBuilder};
use tauri_plugin_shell::process::{CommandChild, CommandEvent};
use tauri_plugin_shell::ShellExt;

const DEV_URL: &str = "127.0.0.1:8787";
const WINDOW_LABEL: &str = "main";

struct ServerProcess {
    child: CommandChild,
    _rx: tauri::async_runtime::Receiver<CommandEvent>,
}

static SERVER: Mutex<Option<ServerProcess>> = Mutex::new(None);

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|_app, _args, _cwd| {
            // 单实例：重复启动时聚焦已有窗口即可
        }))
        .plugin(tauri_plugin_shell::init())
        .setup(|app| {
            let handle = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                if let Err(error) = boot(&handle).await {
                    eprintln!("[desktop] failed to boot local server: {error}");
                }
            });
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("failed to build tauri application")
        .run(|_app, event| {
            if matches!(event, RunEvent::Exit) {
                if let Some(mut proc) = SERVER.lock().unwrap().take() {
                    let _ = proc.child.kill();
                }
            }
        });
}

/// 异步启动本地 Bun 服务并创建主窗口。
async fn boot(app: &tauri::AppHandle) -> Result<(), Box<dyn std::error::Error>> {
    let url = if tauri::is_dev() {
        // 开发模式：`bun run desktop:api` 已经在 127.0.0.1:8787 监听
        wait_reachable(DEV_URL, 60).await?;
        format!("http://{DEV_URL}")
    } else {
        spawn_local_server(app).await?
    };

    create_main_window(app, &url)?;
    Ok(())
}

/// 生产模式：以本地模式拉起随包 Bun sidecar。
async fn spawn_local_server(app: &tauri::AppHandle) -> Result<String, Box<dyn std::error::Error>> {
    let data_dir = app.path().app_data_dir()?;
    fs::create_dir_all(&data_dir)?;
    let resource_dir = app.path().resource_dir()?;

    let server_entry = resource_dir.join("server").join("index.mjs");
    if !server_entry.exists() {
        return Err(format!("server bundle missing: {}", server_entry.display()).into());
    }

    let auth_secret = ensure_local_auth_secret(&data_dir)?;
    let port_file = data_dir.join("port.txt");
    let story_data_file = data_dir.join("db.json");
    let skill_market_dir = data_dir.join("skill-market");

    let (rx, child) = app
        .shell()
        .sidecar("bun")?
        .args([std::ffi::OsString::from(server_entry.into_os_string())])
        .env("AUTH_MODE", "local")
        .env("AUTH_SECRET", auth_secret)
        .env("HOST", "127.0.0.1")
        .env("PORT", "0")
        .env("STORY_PORT_FILE", port_file.to_string_lossy().into_owned())
        .env("STORY_DATA_FILE", story_data_file.to_string_lossy().into_owned())
        .env("STORY_SKILL_MARKET_DIR", skill_market_dir.to_string_lossy().into_owned())
        .env("AI_TASK_QUEUE_ENABLED", "false")
        .env("DATABASE_URL", "")
        .env("REDIS_URL", "")
        .env("WEB_ORIGIN", "http://127.0.0.1")
        .env("NODE_ENV", "production")
        .env("ALLOW_SHARED_MODEL_KEY", "false")
        .current_dir(resource_dir)
        .spawn()?;

    *SERVER.lock().unwrap() = Some(ServerProcess { child, _rx: rx });

    let port = wait_for_port_file(&port_file, 60).await?;
    let url = format!("http://127.0.0.1:{port}");
    wait_reachable(&format!("127.0.0.1:{port}"), 10).await?;
    Ok(url)
}

/// 在数据目录读写持久化 AUTH_SECRET，保证本地加密的模型 Key 重启后仍可解密。
fn ensure_local_auth_secret(data_dir: &PathBuf) -> Result<String, Box<dyn std::error::Error>> {
    let secret_file = data_dir.join("auth-secret");
    if let Ok(raw) = fs::read_to_string(&secret_file) {
        let trimmed = raw.trim().to_string();
        if trimmed.len() >= 32 {
            return Ok(trimmed);
        }
    }
    let mut bytes = [0u8; 48];
    getrandom::getrandom(&mut bytes)?;
    let mut generated = String::with_capacity(96);
    for byte in bytes {
        write!(&mut generated, "{byte:02x}")?;
    }
    fs::write(&secret_file, &generated)?;
    Ok(generated)
}

fn create_main_window(app: &tauri::AppHandle, url: &str) -> Result<(), Box<dyn std::error::Error>> {
    let parsed: tauri::Url = url.parse()?;
    WebviewWindowBuilder::new(app, WINDOW_LABEL, WebviewUrl::External(parsed))
        .title("叙事工坊 · YeMu AI Novel")
        .inner_size(1280.0, 800.0)
        .min_inner_size(960.0, 600.0)
        .center()
        .build()?;
    Ok(())
}

async fn wait_reachable(addr: &str, seconds: u64) -> Result<(), Box<dyn std::error::Error>> {
    let socket_addr: SocketAddr = addr.parse()?;
    let deadline = std::time::Instant::now() + Duration::from_secs(seconds);
    while std::time::Instant::now() < deadline {
        if TcpStream::connect_timeout(&socket_addr, Duration::from_millis(800)).is_ok() {
            return Ok(());
        }
        std::thread::sleep(Duration::from_millis(250));
    }
    Err(format!("服务未在 {seconds}s 内就绪: {addr}").into())
}

async fn wait_for_port_file(port_file: &PathBuf, seconds: u64) -> Result<u16, Box<dyn std::error::Error>> {
    let deadline = std::time::Instant::now() + Duration::from_secs(seconds);
    while std::time::Instant::now() < deadline {
        if let Ok(raw) = fs::read_to_string(port_file) {
            if let Ok(port) = raw.trim().parse::<u16>() {
                if port > 0 {
                    return Ok(port);
                }
            }
        }
        std::thread::sleep(Duration::from_millis(200));
    }
    Err(format!("等待端口文件超时: {}", port_file.display()).into())
}
