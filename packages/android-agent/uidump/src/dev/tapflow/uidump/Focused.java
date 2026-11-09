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
    String line = "set".equals(mode) ? new BufferedReader(new InputStreamReader(System.in, "UTF-8")).readLine() : null;
    out(handle(mode, line));
    // A wrapper that failed to connect leaves its handler thread running, and app_process waits for it: the one-shot
    // run would then end only at its `timeout`.
    System.exit(0);
  }

  /**
   * One request on its own UiAutomation connection, connected and released here: the one-shot run and FocusedServer
   * both answer through it. A wrapper is not reused across connections (its handler thread ends with `disconnect`), and
   * the connection is not kept: while one is up, the app under test sees accessibility on.
   */
  static String handle(String mode, String textLine) {
    Class<?> wrapperClass;
    Object wrapper = null;
    try {
      wrapperClass = Class.forName("com.android.uiautomator.core.UiAutomationShellWrapper");
      wrapper = wrapperClass.getConstructor().newInstance();
      wrapperClass.getMethod("connect").invoke(wrapper);
    } catch (InvocationTargetException e) {
      // Another UiAutomation is connected (the tree dump, or a test framework): this read fails, the next may not. The
      // wrapper started its handler thread before failing; a server would gather one per refused request.
      quitHandlerThread(wrapper);
      return "{\"error\":" + str(String.valueOf(e.getCause())) + "}";
    } catch (ReflectiveOperationException e) {
      return "{\"error\":\"unsupported\"}";
    }
    try {
      UiAutomation automation = (UiAutomation) wrapperClass.getMethod("getUiAutomation").invoke(wrapper);
      AccessibilityServiceInfo info = automation.getServiceInfo();
      info.flags |= AccessibilityServiceInfo.FLAG_RETRIEVE_INTERACTIVE_WINDOWS;
      automation.setServiceInfo(info);
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
      return "{\"error\":\"unknown request\"}";
    } catch (Exception e) {
      return "{\"error\":" + str(String.valueOf(e)) + "}";
    } finally {
      try {
        wrapperClass.getMethod("disconnect").invoke(wrapper);
      } catch (ReflectiveOperationException e) {
        // A one-shot run ends here anyway; the server's next request makes a new wrapper.
      }
    }
  }

  private static void quitHandlerThread(Object wrapper) {
    if (wrapper == null) return;
    try {
      java.lang.reflect.Field f = wrapper.getClass().getDeclaredField("mHandlerThread");
      f.setAccessible(true);
      Object thread = f.get(wrapper);
      if (thread instanceof android.os.HandlerThread) ((android.os.HandlerThread) thread).quitSafely();
    } catch (ReflectiveOperationException | RuntimeException e) {
      // Another shape of the class: the thread stays, as it did.
    }
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
    int beforeLength = was == null ? 0 : was.length();
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
    int length = now == null ? 0 : now.length();
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
