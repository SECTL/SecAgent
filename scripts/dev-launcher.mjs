import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const electronPath = path.join(projectRoot, "node_modules", "electron", "dist", process.platform === "win32" ? "electron.exe" : "Electron.app/Contents/MacOS/Electron");
const mainEntry = path.join(projectRoot, "out", "main", "main.cjs");

if (!fs.existsSync(electronPath)) throw new Error(`找不到 Electron：${electronPath}。请先运行 pnpm install，并在 pnpm approve-builds 中允许 electron。`);
if (!fs.existsSync(mainEntry)) throw new Error(`找不到已构建入口：${mainEntry}。请先运行 pnpm build。`);

const child = spawn(electronPath, [mainEntry], { cwd: projectRoot, stdio: "inherit", env: { ...process.env, SECAGENT_DEV_LAUNCHER: "1" } });
child.on("exit", (code, signal) => { if (signal) process.kill(process.pid, signal); else process.exit(code ?? 0); });
