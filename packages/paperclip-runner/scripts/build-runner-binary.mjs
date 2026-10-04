import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";

const packageRoot = path.resolve(import.meta.dirname, "..");
const env = { ...process.env };
// The generated AWS crates can exhaust memory with a job per CPU on Windows.
// Operators can still override this for larger build machines.
if (process.platform === "win32" && !env.CARGO_BUILD_JOBS) env.CARGO_BUILD_JOBS = "2";
// rustup's pinned channel defaults to MSVC on Windows. A GNU installation is
// also supported; prefer the same pinned version when MSVC is unavailable.
if (process.platform === "win32" && !env.RUSTUP_TOOLCHAIN) {
  const pin = /channel\s*=\s*"([^"]+)"/.exec(readFileSync(path.join(packageRoot, "rust-toolchain.toml"), "utf8"))[1];
  const host = spawnSync("rustc", ["-vV"], { cwd: packageRoot, encoding: "utf8" }).stdout?.match(/^host: (.+)$/m)?.[1];
  const hasLinker = spawnSync("where.exe", ["link.exe"], { stdio: "ignore" }).status === 0;
  const hasGcc = spawnSync("where.exe", ["gcc.exe"], { stdio: "ignore" }).status === 0;
  if (host?.endsWith("windows-msvc") && !hasLinker && hasGcc) {
    const gnu = `${pin}-${host.replace(/windows-msvc$/, "windows-gnu")}`;
    const installed = spawnSync("rustup", ["run", gnu, "rustc", "--version"], { stdio: "ignore" }).status === 0;
    if (!installed) throw new Error(`Install the pinned GNU compiler with: rustup toolchain install ${gnu} --profile minimal. Keep gcc.exe on PATH, or install Visual Studio C++ Build Tools for MSVC.`);
    env.RUSTUP_TOOLCHAIN = gnu;
    console.log(`Building the runner with ${gnu}.`);
  }
}
const result = spawnSync("cargo", ["build", "--release", "--manifest-path", "runner/Cargo.toml", "--locked", "-p", "paperclip-runner-core", "--bin", "paperclip-runnerd"], { cwd: packageRoot, env, stdio: "inherit" });
if (result.error) throw result.error;
if (result.status !== 0) process.exit(result.status ?? 1);
await import("./stage-runner-binary.mjs");
