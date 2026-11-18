package dev.tapflow.uidump;

import android.app.UiAutomation;
import android.os.HandlerThread;
import android.os.Looper;
import java.lang.reflect.InvocationTargetException;

/**
 * A UiAutomation connection made the way uiautomator's `UiAutomationShellWrapper.connect` makes one — a handler thread
 * of its own, `new UiAutomation(looper, new UiAutomationConnection())`, `connect()` — but any number of times in one
 * process. From Android 16 the wrapper prepares the main Looper on every connect (`Looper.prepareMainLooper`, measured
 * on Pixel_9_Pro_Fold_API_36), which a process can do once: FocusedServer, which connects per request, answered its
 * first request and failed every later one with "Only one Looper may be created per thread" — a field read or set, a
 * reach, a hold. Here the main Looper is prepared at most once (some framework code wants one), and each connection
 * only starts its own thread. Measured repeated connects on Android 14 and 16, 9–51 ms each.
 */
final class Connection {
  final UiAutomation automation;
  private final HandlerThread thread;

  private Connection(UiAutomation automation, HandlerThread thread) {
    this.automation = automation;
    this.thread = thread;
  }

  /**
   * @throws InvocationTargetException when the device refused the connection (another UiAutomation is connected)
   * @throws ReflectiveOperationException when this Android has no such classes
   */
  static Connection open() throws ReflectiveOperationException {
    synchronized (Connection.class) {
      if (Looper.getMainLooper() == null) Looper.prepareMainLooper();
    }
    HandlerThread thread = new HandlerThread("tapflow-uiautomation");
    thread.start();
    try {
      Object connection = Class.forName("android.app.UiAutomationConnection").getConstructor().newInstance();
      UiAutomation automation = (UiAutomation) UiAutomation.class
          .getConstructor(Looper.class, Class.forName("android.app.IUiAutomationConnection"))
          .newInstance(thread.getLooper(), connection);
      UiAutomation.class.getMethod("connect").invoke(automation);
      return new Connection(automation, thread);
    } catch (ReflectiveOperationException | RuntimeException e) {
      thread.quitSafely();
      throw e;
    }
  }

  void close() {
    try {
      UiAutomation.class.getMethod("disconnect").invoke(automation);
    } catch (ReflectiveOperationException | RuntimeException e) {
      // Gone with the process at worst.
    }
    thread.quitSafely();
  }
}
