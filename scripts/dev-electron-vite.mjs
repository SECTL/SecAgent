import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { spawn } from "node:child_process";

const require = createRequire(import.meta.url);
const electronPackagePath = require.resolve("electron/package.json");
const electronPackageDir = path.dirname(electronPackagePath);
const electronPackage = JSON.parse(fs.readFileSync(electronPackagePath, "utf8"));
const electronPathFile = path.join(electronPackageDir, "path.txt");

function getElectronBinaryPath() {
  if (!fs.existsSync(electronPathFile)) return undefined;

  const relativePath = fs.readFileSync(electronPathFile, "utf8").trim();
  if (!relativePath) return undefined;

  const binaryPath = path.join(electronPackageDir, "dist", relativePath);
  return fs.existsSync(binaryPath) ? binaryPath : undefined;
}

function repairElectronInstall() {
  if (getElectronBinaryPath()) return;

  const installScript = path.join(electronPackageDir, electronPackage.bin["install-electron"]);
  console.warn("Electron binary is missing; downloading it now...");

  const result = spawn(process.execPath, [installScript], {
    stdio: "inherit",
    env: withoutElectronRunAsNode(process.env),
  });

  result.on("error", (error) => {
    console.error("Failed to start Electron installer:", error);
    process.exitCode = 1;
  });

  result.on("exit", (code, signal) => {
    if (signal || code !== 0) {
      process.exitCode = code ?? 1;
      return;
    }

    startElectronVite();
  });
}

function withoutElectronRunAsNode(environment) {
  const cleanedEnvironment = { ...environment };
  delete cleanedEnvironment.ELECTRON_RUN_AS_NODE;
  return cleanedEnvironment;
}

function startElectronVite() {
  const electronVitePackagePath = require.resolve("electron-vite/package.json");
  const electronViteCli = path.join(path.dirname(electronVitePackagePath), "bin", "electron-vite.js");
  const child = spawn(process.execPath, [electronViteCli, ...process.argv.slice(2)], {
    stdio: "inherit",
    env: withoutElectronRunAsNode(process.env),
  });

  child.on("error", (error) => {
    console.error("Failed to start electron-vite:", error);
    process.exitCode = 1;
  });

  child.on("exit", (code, signal) => {
    if (signal) {
      process.kill(process.pid, signal);
    } else {
      process.exitCode = code ?? 0;
    }
  });
}

if (getElectronBinaryPath()) {
  startElectronVite();
} else {
  repairElectronInstall();
}
