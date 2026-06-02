// SSH execution primitive.
//
// Opens a connection, runs a sequence of commands, streams stdout/stderr to a
// log callback, returns aggregated output + exit code. Always closes the
// connection so we don't leak file descriptors when jobs are short.

import { Client } from "ssh2";

export function execOverSsh(connection, commands, onLog) {
  return new Promise((resolve) => {
    const client = new Client();
    const outputs = [];
    let cancelled = false;

    function close(result) {
      try { client.end(); } catch { /* noop */ }
      resolve(result);
    }

    client.on("error", (err) => {
      onLog?.("error", null, `SSH error: ${err.message}`);
      close({ ok: false, error: err.message, outputs });
    });

    client.on("ready", async () => {
      onLog?.("info", "ssh", `Connected to ${connection.host}:${connection.port}`);
      try {
        for (let i = 0; i < commands.length; i++) {
          const cmd = commands[i];
          if (cancelled) break;
          const step = cmd.step ?? `cmd ${i + 1}`;
          onLog?.("info", step, `$ ${cmd.run}`);
          const out = await new Promise((res) => {
            client.exec(cmd.run, (err, stream) => {
              if (err) return res({ stdout: "", stderr: err.message, exit: -1 });
              let stdout = "";
              let stderr = "";
              let exit = null;
              stream.on("data", (d) => {
                const s = d.toString();
                stdout += s;
                // Emit per-line for live logs without spamming.
                for (const line of s.split("\n")) {
                  if (line.trim()) onLog?.("stdout", step, line);
                }
              });
              stream.stderr.on("data", (d) => {
                const s = d.toString();
                stderr += s;
                for (const line of s.split("\n")) {
                  if (line.trim()) onLog?.("stderr", step, line);
                }
              });
              stream.on("close", (code) => {
                exit = code ?? 0;
                res({ stdout, stderr, exit });
              });
            });
          });
          outputs.push({ step, ...out });
          if (out.exit !== 0 && !cmd.allow_failure) {
            close({ ok: false, error: `Command failed at step "${step}" (exit ${out.exit})`, outputs });
            return;
          }
        }
        close({ ok: true, outputs });
      } catch (e) {
        close({ ok: false, error: e?.message ?? String(e), outputs });
      }
    });

    client.connect({
      host: connection.host,
      port: connection.port ?? 22,
      username: connection.user,
      privateKey: connection.private_key,
      readyTimeout: 15_000,
      // Limit algorithm selection to commonly-supported ones; modern Ubuntu fine.
      algorithms: {
        serverHostKey: ["ssh-ed25519", "ecdsa-sha2-nistp256", "rsa-sha2-512", "rsa-sha2-256", "ssh-rsa"],
      },
    });
  });
}
