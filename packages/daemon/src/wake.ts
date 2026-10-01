// Runs on the `via` host named in a wake config — the one that can actually
// reach the sleeping machine (magic packets don't cross routers).
import { exec } from "node:child_process";
import { createSocket } from "node:dgram";
import type { WakeConfig } from "./fleet-config.js";

function magicPacket(macAddress: string): Buffer {
  const hex = macAddress.replace(/[^0-9a-f]/gi, "");
  if (hex.length !== 12) throw new Error(`invalid MAC address: ${macAddress}`);
  const mac = Buffer.from(hex, "hex");
  return Buffer.concat([Buffer.alloc(6, 0xff), ...Array.from({ length: 16 }, () => mac)]);
}

function sendWol(macAddress: string, broadcast = "255.255.255.255"): Promise<void> {
  const packet = magicPacket(macAddress);
  return new Promise((resolve, reject) => {
    const socket = createSocket("udp4");
    socket.once("error", (err) => {
      socket.close();
      reject(err);
    });
    socket.bind(() => {
      socket.setBroadcast(true);
      // Ports 9 and 7 are both conventional; NICs listen on the frame, not
      // the port, but some routers only forward one of them.
      socket.send(packet, 9, broadcast, (err9) => {
        socket.send(packet, 7, broadcast, (err7) => {
          socket.close();
          const err = err9 ?? err7;
          if (err) reject(err);
          else resolve();
        });
      });
    });
  });
}

function runCommand(command: string): Promise<void> {
  return new Promise((resolve, reject) => {
    exec(command, { timeout: 30_000 }, (err, _stdout, stderr) => {
      if (err) reject(new Error(`wake command failed: ${stderr.trim() || err.message}`));
      else resolve();
    });
  });
}

export async function performWake(wake: WakeConfig): Promise<void> {
  if (wake.method === "wol") await sendWol(wake.macAddress, wake.broadcast);
  else if (wake.method === "command") await runCommand(wake.run);
}
