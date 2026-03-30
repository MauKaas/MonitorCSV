import { Client } from "ssh2";
import * as fs from "fs";
import * as path from "path";

// ──── CONFIG ────

interface NodeConfig {
  name: string;
  host: string;
  username: string;
  privateKeyPath: string;
  local?: boolean; // true = read /proc/stat directly, skip SSH
}

const nodes: NodeConfig[] = [
  {
    name: "pi5-control",
    host: "localhost",
    username: "mauflits",
    privateKeyPath: "~/.ssh/id_rsa",
    local: true, // running on the Pi itself, no SSH needed
  },
  {
    name: "optiplex-worker0",
    host: "192.168.0.101", // <-- maurits-minion0 IP
    username: "mauflits",
    privateKeyPath: "~/.ssh/id_rsa",
  },
  {
    name: "optiplex-worker1",
    host: "192.168.0.103", // <-- maurits-minion1 IP
    username: "mauflits",
    privateKeyPath: "~/.ssh/id_rsa",
  },
];

// Shelly Plug S Gen3 IP (powers entire cluster)
const SHELLY_IP = "192.168.0.73";

const OUTPUT_FILE = path.join(__dirname, "cluster_metrics.csv");
const INTERVAL_MS = 5000; // every 5 seconds

// ──── LOCAL CPU READING (for the Pi itself) ────

function readProcStat(): number[] {
  const content = fs.readFileSync("/proc/stat", "utf-8");
  const line = content.split("\n").find((l) => l.startsWith("cpu "));
  if (!line) throw new Error("Could not read /proc/stat");
  return line.split(/\s+/).slice(1).map(Number);
}

function getLocalCpuUsage(): Promise<number> {
  return new Promise((resolve) => {
    const a = readProcStat();
    setTimeout(() => {
      const b = readProcStat();

      const idleDelta = b[3] - a[3];
      const totalDelta =
        b.reduce((s, v) => s + v, 0) - a.reduce((s, v) => s + v, 0);

      const usage =
        totalDelta === 0
          ? 0
          : ((totalDelta - idleDelta) / totalDelta) * 100;

      resolve(Math.round(usage * 100) / 100);
    }, 1000);
  });
}

// ──── SSH CPU READING (for remote nodes) ────

function getPrivateKey(keyPath: string): Buffer {
  const resolved = keyPath.replace("~", process.env.HOME || "");
  return fs.readFileSync(resolved);
}

function getRemoteCpuUsage(node: NodeConfig): Promise<number> {
  return new Promise((resolve, reject) => {
    const conn = new Client();
    conn
      .on("ready", () => {
        const cmd = `grep 'cpu ' /proc/stat && sleep 1 && grep 'cpu ' /proc/stat`;
        conn.exec(cmd, (err, stream) => {
          if (err) return reject(err);
          let output = "";
          stream.on("data", (data: Buffer) => (output += data.toString()));
          stream.on("close", () => {
            conn.end();
            const lines = output.trim().split("\n");
            if (lines.length < 2)
              return reject(new Error("Bad /proc/stat output"));

            const parse = (line: string) =>
              line.split(/\s+/).slice(1).map(Number);
            const a = parse(lines[0]);
            const b = parse(lines[1]);

            const idleDelta = b[3] - a[3];
            const totalDelta =
              b.reduce((s, v) => s + v, 0) - a.reduce((s, v) => s + v, 0);

            const usage =
              totalDelta === 0
                ? 0
                : ((totalDelta - idleDelta) / totalDelta) * 100;

            resolve(Math.round(usage * 100) / 100);
          });
        });
      })
      .on("error", reject)
      .connect({
        host: node.host,
        port: 22,
        username: node.username,
        privateKey: getPrivateKey(node.privateKeyPath),
      });
  });
}

function getCpuUsage(node: NodeConfig): Promise<number> {
  if (node.local) return getLocalCpuUsage();
  return getRemoteCpuUsage(node);
}

// ──── SHELLY PLUG S GEN3 POWER READING ────

interface ShellyStatus {
  apower: number; // active power in watts
  voltage: number; // voltage in V
  current: number; // current in A
  temperature: number; // plug temperature in °C
}

async function getClusterPower(): Promise<ShellyStatus> {
  const res = await fetch(
    `http://${SHELLY_IP}/rpc/Switch.GetStatus?id=0`
  );
  if (!res.ok) throw new Error(`Shelly returned ${res.status}`);
  const data = await res.json();
  return {
    apower: data.apower,
    voltage: data.voltage,
    current: data.current,
    temperature: data.temperature.tC,
  };
}

// ──── MAIN LOOP ────

async function collectAndLog() {
  const timestamp = new Date().toISOString();
  const values: string[] = [timestamp];

  // Collect CPU from all nodes in parallel
  const cpuResults = await Promise.allSettled(
    nodes.map((node) => getCpuUsage(node))
  );

  for (let i = 0; i < nodes.length; i++) {
    const result = cpuResults[i];
    if (result.status === "fulfilled") {
      values.push(result.value.toString());
    } else {
      console.error(`CPU error [${nodes[i].name}]:`, result.reason);
      values.push("NaN");
    }
  }

  // Collect cluster power from Shelly
  try {
    const shelly = await getClusterPower();
    values.push(
      shelly.apower.toString(),
      shelly.voltage.toString(),
      shelly.current.toString(),
      shelly.temperature.toString()
    );
  } catch (err) {
    console.error("Shelly error:", err);
    values.push("NaN", "NaN", "NaN", "NaN");
  }

  const line = values.join(",") + "\n";
  fs.appendFileSync(OUTPUT_FILE, line);
  console.log(line.trim());
}

// ──── INIT ────

if (!fs.existsSync(OUTPUT_FILE)) {
  const header = [
    "timestamp",
    ...nodes.map((n) => `${n.name}_cpu_pct`),
    "cluster_power_w",
    "cluster_voltage_v",
    "cluster_current_a",
    "shelly_temp_c",
  ].join(",");
  fs.writeFileSync(OUTPUT_FILE, header + "\n");
}

console.log("━".repeat(50));
console.log("Cluster Monitor Started");
console.log(`Interval: ${INTERVAL_MS / 1000}s`);
console.log(`Nodes: ${nodes.map((n) => `${n.name} (${n.local ? "local" : n.host})`).join(", ")}`);
console.log(`Shelly: ${SHELLY_IP}`);
console.log(`Output: ${OUTPUT_FILE}`);
console.log("━".repeat(50));

setInterval(collectAndLog, INTERVAL_MS);
collectAndLog();