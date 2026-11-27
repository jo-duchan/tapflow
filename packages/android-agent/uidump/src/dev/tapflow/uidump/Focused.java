package dev.tapflow.uidump;

import android.accessibilityservice.AccessibilityServiceInfo;
import android.app.UiAutomation;
import android.graphics.Rect;
import android.os.Bundle;
import android.util.Base64;
import android.view.accessibility.AccessibilityNodeInfo;
import android.view.accessibility.AccessibilityWindowInfo;
import java.io.BufferedReader;
import java.io.InputStreamReader;
import java.lang.reflect.InvocationTargetException;

/**
 * The text field a person is typing into, for Flow Capture (#1135): read it, set its text, or press its IME action.
 * One line of JSON out. Run with app_process, like TreeDump, and through the same queue: a device takes one
 * UiAutomation connection at a time.
 *
 *   ... dev.tapflow.uidump.Focused read            → the focused field, the keyboard's touchable rect and language
 *   ... dev.tapflow.uidump.Focused set             → stdin's first line (base64 UTF-8) typed at the field's caret, read back
 *   ... dev.tapflow.uidump.Focused ime             → the field's IME action (Done, Next, Search, …), API 30+
 *   ... dev.tapflow.uidump.Focused reach           → stdin's first line (base64 JSON targets): where a touch meant for
 *                                                     each lands (#1125), see Reach
 *   (FocusedServer only) hit `x y`                  → what a touch-down at that point hit (P4), see Hit
 *   (FocusedServer only) dump `idle ms`             → the UI tree as TreeDump writes it, see TreeDump.answer
 *
 * No idle wait, unlike TreeDump: the field is read as it is the moment it is asked (measured: the read itself takes
 * 2-16 ms; the rest of the ~1 s is starting app_process). The text to set comes on stdin, never in argv, where `ps`
 * would show it — it can be a password.
 *
 * `findFocus(FOCUS_INPUT)` is not used: on Compose it answers the host View, not the field (measured). The field is the
 * focused node that is editable or a password.
 */
public final class Focused {
  public static void main(String[] args) throws Exception {
    String mode = args.length > 0 ? args[0] : "read";
    // The text to set is read before connecting, as it always was: stdin is the agent's, not the device's.
    String line = "set".equals(mode) || "reach".equals(mode)
        ? new BufferedReader(new InputStreamReader(System.in, "UTF-8")).readLine() : null;
    out(handle(mode, line));
    // A connection's handler thread outlives a failed connect long enough for app_process to wait on it: the one-shot
    // run would then end only at its `timeout`.
    System.exit(0);
  }

  /** When FocusedServer read the request now being answered, in `System.nanoTime` (CLOCK_MONOTONIC, the clock
   *  `dumpsys gfxinfo` stamps frames with): what the agent sets its clock to the device's by. */
  static volatile long receivedNs;

  /** The connection held while a person is recorded (`hold`), which every request then uses: FocusedServer only. */
  private static Connection heldConnection;
  private static UiAutomation held;

  /**
   * One request on its own UiAutomation connection, connected and released here: the one-shot run and FocusedServer
   * both answer through it (`Connection`, which can connect again in the same process from Android 16), and the
   * connection is not kept: while one is up, the app under test sees accessibility on.
   */
  static String handle(String mode, String textLine) {
    if ("hold".equals(mode)) return hold();
    if ("release".equals(mode)) { release(); return "{}"; }
    if (held != null) {
      try {
        // A held connection keeps the node cache across requests, and nothing clears it for a screen Compose changed
        // in place: Compose sends UiAutomation no events, so the cache would answer with the screen before.
        clearCache(held);
        // The dump turns the windows off and leaves them off (TreeDump.answer); everything else reads them.
        if (!"dump".equals(mode)) withWindows(held);
        return answer(mode, textLine, held);
      } catch (Exception e) {
        return "{\"error\":" + str(String.valueOf(e)) + "}";
      }
    }
    Connection connection;
    try {
      connection = Connection.open();
    } catch (InvocationTargetException e) {
      // Another UiAutomation is connected (the tree dump, or a test framework): this read fails, the next may not.
      return "{\"error\":" + str(String.valueOf(e.getCause())) + "}";
    } catch (ReflectiveOperationException e) {
      return "{\"error\":\"unsupported\"}";
    } catch (RuntimeException e) {
      return "{\"error\":" + str(String.valueOf(e)) + "}";
    }
    try {
      if (!"dump".equals(mode)) withWindows(connection.automation);
      return answer(mode, textLine, connection.automation);
    } catch (Exception e) {
      return "{\"error\":" + str(String.valueOf(e)) + "}";
    } finally {
      connection.close();
    }
  }

  /** Ask for the windows, unless already asked: setting the service info again sends events a dump would then wait out. */
  static void withWindows(UiAutomation automation) {
    AccessibilityServiceInfo info = automation.getServiceInfo();
    if ((info.flags & AccessibilityServiceInfo.FLAG_RETRIEVE_INTERACTIVE_WINDOWS) != 0) return;
    info.flags |= AccessibilityServiceInfo.FLAG_RETRIEVE_INTERACTIVE_WINDOWS;
    automation.setServiceInfo(info);
  }

  private static String answer(String mode, String textLine, UiAutomation automation) throws Exception {
    // A touch's hit (P4) reads the windows at a point, not the focused field: asked first, since what it reads must be
    // read before the touch's up changes the screen.
    if ("hit".equals(mode)) return Hit.answer(automation, textLine, receivedNs);
    // The tree, as TreeDump writes it (FocusedServer only): on this connection, held or not, so a dump no longer
    // releases a held one and the touches recorded around it keep their hits.
    if ("dump".equals(mode)) return TreeDump.answer(automation, textLine);
    AccessibilityNodeInfo field = null;
    // Just connected, the root can be missing for a while (up to 200 ms here), and a root can come before its focused
    // field: 3 of 200 reads in one process found none with the field focused (measured), so a miss is asked again.
    int misses = 0;
    for (int i = 0; i < 40; i++) {
      AccessibilityNodeInfo root = automation.getRootInActiveWindow();
      if (root == null) { Thread.sleep(5); continue; }
      field = focusedField(root);
      if (field != null || ++misses > 3) break;
      Thread.sleep(10);
    }
    if ("set".equals(mode)) return set(field, textLine);
    if ("ime".equals(mode)) return ime(field);
    if ("read".equals(mode)) return read(automation, field);
    if ("reach".equals(mode)) return Reach.answer(automation, textLine);
    return "{\"error\":\"unknown request\"}";
  }

  /**
   * Keep one connection for every request until `release` (P4): connecting per request leaves the window list empty or
   * partial for 25–250 ms (p50 140 ms, measured 2026-11-18 on Pixel_9_tapflow Android 14), and a touch's hit has to be
   * read before its up — a tap is held 80–150 ms. Held, a hit costs its walk (m1: 2–25 ms). The tree dump goes
   * through it too (`dump`); only a one-shot dump, when the server cannot answer, needs it released, since a device
   * takes one UiAutomation at a time, and the agent holds it again
   * after. While it is held, Views apps see accessibility on (m1: no frame cost; Compose ignores UiAutomation).
   */
  private static String hold() {
    if (held != null) return "{\"held\":true}";
    Connection connection = null;
    try {
      connection = Connection.open();
      UiAutomation automation = connection.automation;
      withWindows(automation);
      // A connection whose node cache cannot be cleared answers with the screen before (Compose sends it no events), so
      // it is not held: requests connect each time, slower, and a touch whose hit comes late gets no report.
      if (!clearCache(automation)) {
        connection.close();
        return "{\"error\":\"cache cannot be cleared\"}";
      }
      // Paid here rather than by the next touch's hit: the window list fills over a few reads after connecting (Hit).
      settleWindows(automation);
      heldConnection = connection;
      held = automation;
      return "{\"held\":true}";
    } catch (InvocationTargetException e) {
      return "{\"error\":" + str(String.valueOf(e.getCause())) + "}";
    } catch (Exception e) {
      // Set up after connecting failed (a null service info): let go of the connection, or it outlives the answer.
      if (connection != null) connection.close();
      return "{\"error\":" + str(String.valueOf(e)) + "}";
    }
  }

  /**
   * Clear the connection's node cache: `UiAutomation.clearCache()` from API 34; before it the interaction client's,
   * per connection (`clearCache(int)`, Android 13) or for the process (`clearCache()`, older). `false` when none
   * could be reached.
   */
  private static boolean clearCache(UiAutomation automation) {
    try {
      automation.getClass().getMethod("clearCache").invoke(automation);
      return true;
    } catch (ReflectiveOperationException | RuntimeException e) {
      // Before API 34: the client below.
    }
    try {
      Class<?> client = Class.forName("android.view.accessibility.AccessibilityInteractionClient");
      Object instance = client.getMethod("getInstance").invoke(null);
      try {
        java.lang.reflect.Field id = UiAutomation.class.getDeclaredField("mConnectionId");
        id.setAccessible(true);
        client.getMethod("clearCache", int.class).invoke(instance, id.getInt(automation));
        return true;
      } catch (ReflectiveOperationException | RuntimeException e) {
        // From Android 13 the cache is per connection: the process-wide clear may leave this one's, so it is no answer.
        if (android.os.Build.VERSION.SDK_INT >= 33) return false;
        client.getMethod("clearCache").invoke(instance);
        return true;
      }
    } catch (ReflectiveOperationException | RuntimeException e) {
      return false;
    }
  }

  /** Until the window list holds an app window and has not changed for 120 ms, at most 400 ms. */
  private static void settleWindows(UiAutomation automation) throws InterruptedException {
    long end = System.nanoTime() + 400_000_000L;
    int seen = -1;
    long since = System.nanoTime();
    while (System.nanoTime() < end) {
      java.util.List<AccessibilityWindowInfo> windows = automation.getWindows();
      boolean app = false;
      for (AccessibilityWindowInfo w : windows) app |= w.getType() == AccessibilityWindowInfo.TYPE_APPLICATION;
      if (!app || windows.size() != seen) { seen = app ? windows.size() : -1; since = System.nanoTime(); }
      else if (System.nanoTime() - since >= 120_000_000L) return;
      Thread.sleep(10);
    }
  }

  private static void release() {
    if (heldConnection == null) return;
    heldConnection.close();
    heldConnection = null;
    held = null;
  }

  private static AccessibilityNodeInfo focusedField(AccessibilityNodeInfo node) {
    if (node == null) return null;
    if (node.isFocused() && (node.isEditable() || node.isPassword())) return node;
    for (int i = 0; i < node.getChildCount(); i++) {
      AccessibilityNodeInfo found = focusedField(node.getChild(i));
      if (found != null) return found;
    }
    return null;
  }

  /** What the field holds, never a password's, and never a hint shown in place of nothing. */
  private static String value(AccessibilityNodeInfo field) {
    if (field.isPassword()) return null;
    if (field.isShowingHintText()) return "";
    CharSequence text = field.getText();
    return text == null ? "" : text.toString();
  }

  private static String read(UiAutomation automation, AccessibilityNodeInfo field) {
    StringBuilder json = new StringBuilder("{");
    if (field == null) {
      json.append("\"reason\":\"no-focus\"");
    } else {
      Rect bounds = new Rect();
      field.getBoundsInScreen(bounds);
      String id = field.getViewIdResourceName();
      json.append("\"identifier\":").append(str(id == null ? "" : id))
          .append(",\"frame\":").append(rect(bounds))
          .append(",\"secure\":").append(field.isPassword());
      String value = value(field);
      if (value != null) json.append(",\"value\":").append(str(value));
      else json.append(",\"reason\":\"secure\"");
    }
    // Just connected, the window list can come without the keyboard's while it is up (1 in 6 in one process, measured):
    // with a field focused it is asked again, briefly. A keyboard really down costs the 20 ms.
    for (int i = 0; i < 3; i++) {
      AccessibilityWindowInfo ime = null;
      for (AccessibilityWindowInfo window : automation.getWindows()) {
        if (window.getType() == AccessibilityWindowInfo.TYPE_INPUT_METHOD) ime = window;
      }
      if (ime != null) {
        Rect r = new Rect();
        ime.getBoundsInScreen(r);
        CharSequence title = ime.getTitle();
        json.append(",\"keyboard\":").append(rect(r)).append(",\"language\":").append(str(title == null ? "" : title.toString()));
        break;
      }
      if (field == null) break;
      try { Thread.sleep(10); } catch (InterruptedException e) { break; }
    }
    return json.append("}").toString();
  }

  /**
   * Put the text where typing it would: at the caret, over the selection. A select-all before it (`inputText` with
   * `replace`) makes it the whole value, as on iOS. Then say whether it took. A field that ends up neither with the text
   * nor changed refused it (a read-only Compose field answers true and keeps its text); one that ends up changed but not
   * equal was transformed by the app (a mask, an upper-case filter, maxLength), which a person's typing would have met
   * too.
   */
  private static String set(AccessibilityNodeInfo field, String line) throws Exception {
    if (field == null) return "{\"result\":\"no-focus\"}";
    // Base64 of the UTF-8 text: one line whatever the text holds, newlines and backslashes included.
    String text = line == null ? "" : new String(Base64.decode(line.trim(), Base64.DEFAULT), "UTF-8");
    String before = value(field);
    boolean secure = field.isPassword();
    CharSequence was = field.getText();
    // An empty field showing its hint reports the hint as its text: the length is the value's, the bullets' only for a
    // password, which has no value to read — and none at all for a password showing its hint. Counted, an empty React
    // Native password field (hint "Password") read as one holding eight characters, and typing into it was refused as
    // appending to a password (wdio demo app, Android 14 and 16).
    int beforeLength = before != null ? before.length() : (was == null || field.isShowingHintText() ? 0 : was.length());
    // No selection reported (-1) is a caret at the end, where a field that was just tapped puts it.
    int start = field.getTextSelectionStart();
    int end = field.getTextSelectionEnd();
    if (start < 0 || end < 0 || start > beforeLength || end > beforeLength) start = end = beforeLength;
    if (start > end) { int t = start; start = end; end = t; }
    String wanted;
    if (start == 0 && end == beforeLength) wanted = text;
    // A password reads as bullets: what is around the caret cannot be put back.
    else if (secure) return "{\"result\":\"cannot-append-secure\"}";
    else wanted = before.substring(0, start) + text + before.substring(end);
    Bundle arguments = new Bundle();
    arguments.putCharSequence(AccessibilityNodeInfo.ACTION_ARGUMENT_SET_TEXT_CHARSEQUENCE, wanted);
    if (!field.performAction(AccessibilityNodeInfo.ACTION_SET_TEXT, arguments)) return "{\"result\":\"rejected\"}";
    Thread.sleep(150);
    field.refresh();
    CharSequence now = field.getText();
    // Still showing its hint is still empty: a field that said yes and kept nothing is refused, not "transformed".
    int length = now == null || field.isShowingHintText() ? 0 : now.length();
    if (secure) {
      // A password reads as its bullets, one per character (measured): the length is all there is to check.
      boolean took = length == wanted.length() || length != beforeLength;
      return "{\"result\":\"" + (length == wanted.length() ? "ok" : took ? "transformed" : "refused") + "\"}";
    }
    String after = value(field);
    if (wanted.equals(after)) return "{\"result\":\"ok\"}";
    return "{\"result\":\"" + (after != null && after.equals(before) ? "refused" : "transformed") + "\"}";
  }

  private static String ime(AccessibilityNodeInfo field) {
    if (field == null) return "{\"result\":\"no-focus\"}";
    if (android.os.Build.VERSION.SDK_INT < 30) return "{\"result\":\"unsupported\"}";
    boolean done = field.performAction(AccessibilityNodeInfo.AccessibilityAction.ACTION_IME_ENTER.getId());
    return "{\"result\":\"" + (done ? "ok" : "rejected") + "\"}";
  }

  private static String rect(Rect r) {
    return "{\"x\":" + r.left + ",\"y\":" + r.top + ",\"width\":" + r.width() + ",\"height\":" + r.height() + "}";
  }

  static String str(String s) {
    StringBuilder b = new StringBuilder("\"");
    for (int i = 0; i < s.length(); i++) {
      char c = s.charAt(i);
      if (c == '"' || c == '\\') b.append('\\').append(c);
      else if (c == '\n') b.append("\\n");
      else if (c == '\r') b.append("\\r");
      else if (c == '\t') b.append("\\t");
      else if (c < 0x20) b.append(String.format("\\u%04x", (int) c));
      else b.append(c);
    }
    return b.append('"').toString();
  }

  private static void out(String line) {
    System.out.println(line);
  }
}
