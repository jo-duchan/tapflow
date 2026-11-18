package dev.tapflow.uidump;

import android.accessibilityservice.AccessibilityServiceInfo;
import android.app.UiAutomation;
import android.graphics.Point;
import android.util.Base64;
import android.view.Display;
import android.view.accessibility.AccessibilityNodeInfo;
import java.io.File;
import java.lang.reflect.InvocationTargetException;
import java.util.concurrent.TimeoutException;

/**
 * The UI tree as `uiautomator dump` writes it, without failing on a screen that never goes idle.
 *
 * `uiautomator dump` waits for one second of quiet, up to ten, and gives up with "could not get idle state" on a
 * screen that redraws continuously (a running stopwatch, a live counter), so every selector step there failed. This
 * runs the same classes from the device's own `/system/framework/uiautomator.jar`, so the XML is the same, and only
 * changes the wait: a short quiet window, bounded, and not fatal when it runs out. Run with app_process:
 *
 *   CLASSPATH=<this jar>:/system/framework/uiautomator.jar app_process /system/bin dev.tapflow.uidump.TreeDump <out> <idle ms>
 *
 * Those classes are not public API, so they are reached by reflection. When one is missing or has another shape, it
 * prints UNSUPPORTED and exits 3, and the agent goes back to `uiautomator dump` for that device. A failure inside
 * them (another UiAutomation already connected, a node changing under the dump) is not that: it prints ERROR and
 * exits 2, and only this one read falls back.
 */
public final class TreeDump {
  private static final String UNSUPPORTED = "TAPFLOW_UIDUMP_UNSUPPORTED";
  // Three times the 100 ms the framework spaces content-change events by, so the gaps inside an animation do not read
  // as quiet and a read does not land mid-transition; a screen that never goes quiet is still read once idle ms have
  // passed. uiautomator dump asks for 1000 (measured on a still screen: 2.05 s, against 1.1 s at 100 and ~2 s at 500).
  private static final long QUIET_MS = 300;

  public static void main(String[] args) throws Exception {
    String out = args.length > 0 ? args[0] : "/dev/tty";
    long idleMs = args.length > 1 ? Long.parseLong(args[1]) : 1000;
    Class<?> wrapperClass;
    Object wrapper;
    try {
      wrapperClass = Class.forName("com.android.uiautomator.core.UiAutomationShellWrapper");
      wrapper = wrapperClass.getConstructor().newInstance();
      wrapperClass.getMethod("connect").invoke(wrapper);
    } catch (InvocationTargetException e) {
      failed(e.getCause());
      return;
    } catch (ReflectiveOperationException e) {
      unsupported(e);
      return;
    }
    try {
      UiAutomation automation = (UiAutomation) wrapperClass.getMethod("getUiAutomation").invoke(wrapper);
      try {
        automation.waitForIdle(QUIET_MS, idleMs);
      } catch (TimeoutException e) {
        // The point of this class: a screen that never settles is read as it is.
      }
      if (!write(automation, new File(out))) {
        System.out.println("ERROR: no active window to read");
        System.exit(2);
      }
    } catch (InvocationTargetException e) {
      failed(e.getCause());
    } catch (ReflectiveOperationException e) {
      unsupported(e);
    } catch (ClassCastException e) {
      // A hidden method that answers with another type than this was written against: the image is the problem.
      unsupported(e);
    } catch (RuntimeException e) {
      // Anything else escaping main would end the process with a stack trace and no line the agent recognises, so it
      // would retry the jar on every read without ever deciding. Said as ERROR: this read falls back.
      failed(e);
    } finally {
      try {
        wrapperClass.getMethod("disconnect").invoke(wrapper);
      } catch (ReflectiveOperationException e) {
        // Nothing to undo: the process ends here.
      }
    }
  }

  /** The active window as `uiautomator dump`'s XML, into `out`; false when there is no window to read. */
  private static boolean write(UiAutomation automation, File out) throws ReflectiveOperationException, InterruptedException {
    AccessibilityNodeInfo root = null;
    for (int i = 0; i < 10 && root == null; i++) {
      root = automation.getRootInActiveWindow();
      if (root == null) Thread.sleep(100);
    }
    if (root == null) return false;
    Class<?> displays = Class.forName("android.hardware.display.DisplayManagerGlobal");
    Object global = displays.getMethod("getInstance").invoke(null);
    Display display = (Display) displays.getMethod("getRealDisplay", int.class).invoke(global, Display.DEFAULT_DISPLAY);
    Point size = new Point();
    display.getRealSize(size);
    Class.forName("com.android.uiautomator.core.AccessibilityNodeInfoDumper")
        .getMethod("dumpWindowToFile", AccessibilityNodeInfo.class, File.class, int.class, int.class, int.class)
        .invoke(null, root, out, display.getRotation(), size.x, size.y);
    return true;
  }

  /**
   * The same dump from FocusedServer, on its connection (`dump`): no app_process to start for each read (one-shot p50
   * 1306 ms on Pixel_9_tapflow Android 14; in the server ~330 ms, nearly all of it the 300 ms quiet window; on a held
   * connection 15–25 ms, the quiet having passed already). The dumper writes a file, so it goes through one beside the
   * jar, read back and removed; the XML travels base64 on the server's one line.
   */
  static String answer(UiAutomation automation, String idleLine) throws Exception {
    long idleMs = idleLine == null ? 1000 : Long.parseLong(new String(Base64.decode(idleLine.trim(), Base64.DEFAULT), "UTF-8").trim());
    try {
      automation.waitForIdle(QUIET_MS, idleMs);
    } catch (TimeoutException e) {
      // As the one-shot: a screen that never settles is read as it is.
    }
    File file = new File("/data/local/tmp/tapflow-dump-" + android.os.Process.myPid() + ".xml");
    // The server's connection asks for the windows (Hit, Reach, the keyboard), and with that flag the dumper leaves out
    // what another window covers: a tab bar under the keyboard, measured 12 420 bytes against the one-shot's 19 947. Off
    // for the dump, so the XML is the one-shot's, and left off: the next request that reads windows turns it on again
    // (Focused.withWindows; the window list is there at once, measured). Put back here, the setting's own events made
    // the next dump wait out its quiet window: held dumps went from 13 ms to 330 ms.
    AccessibilityServiceInfo info = automation.getServiceInfo();
    if (info != null && (info.flags & AccessibilityServiceInfo.FLAG_RETRIEVE_INTERACTIVE_WINDOWS) != 0) {
      info.flags &= ~AccessibilityServiceInfo.FLAG_RETRIEVE_INTERACTIVE_WINDOWS;
      automation.setServiceInfo(info);
    }
    try {
      if (!write(automation, file)) return "{\"error\":\"no active window to read\"}";
      byte[] xml = new byte[(int) file.length()];
      try (java.io.FileInputStream in = new java.io.FileInputStream(file)) {
        int at = 0;
        for (int n; at < xml.length && (n = in.read(xml, at, xml.length - at)) > 0; ) at += n;
      }
      return "{\"xml\":\"" + Base64.encodeToString(xml, Base64.NO_WRAP) + "\"}";
    } catch (InvocationTargetException e) {
      return "{\"error\":" + Focused.str(String.valueOf(e.getCause())) + "}";
    } finally {
      file.delete();
    }
  }

  private static void failed(Throwable cause) {
    System.out.println("ERROR " + cause);
    System.exit(2);
  }

  private static void unsupported(Exception e) {
    System.out.println(UNSUPPORTED + " " + e);
    System.exit(3);
  }
}
