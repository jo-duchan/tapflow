package dev.tapflow.uidump;

import java.io.BufferedReader;
import java.io.InputStreamReader;
import java.io.PrintStream;

/**
 * Focused, kept running (#1135): the agent starts it once per device and sends it requests on stdin, so a field read
 * costs its own work (p50 28 ms, p95 45 ms over 200 in one process, measured) instead of starting app_process (~1 s).
 * Appium's UiAutomator2 server and Maestro's are resident for the same reason.
 *
 *   ... app_process /system/bin dev.tapflow.uidump.FocusedServer <nonce>
 *
 * It prints READY, then answers each line `<id> <read|set|ime> [base64 text]` with `<id> <json>`, the JSON Focused
 * prints. Each request connects UiAutomation and releases it (Focused.handle), so between requests the app sees what it
 * sees today and a tree dump can connect. No socket: stdin and stdout are the adb shell's, so only the agent that
 * started it can talk to it, and the text to set — a password, maybe — is never in argv. It ends when stdin closes (the
 * agent went away) or after a minute with no request; the agent starts it again when it next needs it. The nonce is
 * only there for the agent to find this process again to kill it.
 */
public final class FocusedServer {
  private static final long IDLE_MS = 60_000;
  private static volatile long last = System.currentTimeMillis();

  public static void main(String[] args) throws Exception {
    PrintStream out = new PrintStream(System.out, true, "UTF-8");
    Thread idle = new Thread(() -> {
      while (true) {
        try { Thread.sleep(5_000); } catch (InterruptedException e) { return; }
        if (System.currentTimeMillis() - last > IDLE_MS) System.exit(0);
      }
    });
    idle.setDaemon(true);
    idle.start();
    out.println("READY");
    BufferedReader in = new BufferedReader(new InputStreamReader(System.in, "UTF-8"));
    String line;
    while ((line = in.readLine()) != null) {
      last = System.currentTimeMillis();
      String[] parts = line.trim().split(" ", 3);
      if (parts.length < 2) continue;
      String answer = Focused.handle(parts[1], parts.length > 2 ? parts[2] : null);
      out.println(parts[0] + " " + answer);
      last = System.currentTimeMillis();
    }
    System.exit(0);
  }
}
