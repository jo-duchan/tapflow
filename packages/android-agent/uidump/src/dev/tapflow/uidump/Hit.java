package dev.tapflow.uidump;

import android.app.UiAutomation;
import android.graphics.Rect;
import android.util.Base64;
import android.view.accessibility.AccessibilityNodeInfo;
import android.view.accessibility.AccessibilityWindowInfo;
import java.util.ArrayList;
import java.util.List;
import org.json.JSONArray;
import org.json.JSONObject;

/**
 * What a touch-down hit, for Flow Capture's record-time observation (P4): asked by the agent through FocusedServer just
 * after it sent the down, so the screen is still the one the person touched. The request is `x y` (base64, as every
 * request's argument), the point as a fraction of the screen as it is drawn.
 *
 * The answer is facts, not verdicts: the topmost window at the point (by layer, as Reach takes it), its package and
 * type, the package of the app window under it (for a touch on the soft keyboard), and the branch of nodes under the
 * point from the deepest up — each one's class, id, name and touch flags. Which of them is the element, the button, an
 * input or a surface is decided by the agent with `uiTree.ts`'s rules, so the two cannot drift. A text field's and a
 * password's text never leave here.
 *
 * Measured on Pixel_9_tapflow Android 14 (m4, `.work` P4 plan): 26–42 ms p50 including the connection, every one of 192
 * under 100 ms; no frame cost to the app (Compose, Views, React Native). Without FLAG_RETRIEVE_INTERACTIVE_WINDOWS, set
 * by `Focused.handle`, the window list was empty for 200 ms.
 */
final class Hit {
  private Hit() {}

  /** Deepest first; a branch deeper than this is cut at the top, which names nothing anyway (decor views). */
  private static final int MAX_BRANCH = 64;
  private static final long WINDOWS_WAIT_NS = 300_000_000L;

  static String answer(UiAutomation automation, String line, long receivedNs) throws Exception {
    String point = line == null ? "" : new String(Base64.decode(line.trim(), Base64.DEFAULT), "UTF-8");
    String[] p = point.trim().split(" ");
    if (p.length < 2) return "{\"error\":\"bad point\"}";
    double fx = Double.parseDouble(p[0]), fy = Double.parseDouble(p[1]);
    Rect screen = Reach.displaySize();
    // Just connected, the window list fills in over a few reads: empty, then the status bar alone, then the app's window
    // 40–110 ms after connecting (measured, Pixel_9_tapflow Android 14). A list without an app window, or one still
    // growing, would name what is under a dialog, so it is read until it holds an app window (the launcher is one too)
    // and two reads agree. Bounded: past it the answer names no window, and the touch gets no report.
    List<AccessibilityWindowInfo> windows = new ArrayList<>();
    long until = System.nanoTime() + WINDOWS_WAIT_NS;
    for (int seen = -1; System.nanoTime() < until; ) {
      windows = new ArrayList<>(automation.getWindows());
      boolean app = false;
      for (AccessibilityWindowInfo w : windows) app |= w.getType() == AccessibilityWindowInfo.TYPE_APPLICATION;
      if (app && windows.size() == seen) break;
      seen = app ? windows.size() : -1;
      Thread.sleep(5);
    }
    windows.sort((a, b) -> Integer.compare(b.getLayer(), a.getLayer()));
    if (screen == null) {
      screen = new Rect();
      Rect r = new Rect();
      for (AccessibilityWindowInfo w : windows) {
        w.getBoundsInScreen(r);
        screen.union(r);
      }
    }
    JSONObject out = new JSONObject().put("rx", receivedNs).put("w", screen.width()).put("h", screen.height());
    if (screen.isEmpty()) return out.put("error", "no screen").toString();
    int x = (int) Math.round(fx * screen.width()), y = (int) Math.round(fy * screen.height());

    AccessibilityWindowInfo top = null;
    String under = null;
    Rect r = new Rect();
    for (AccessibilityWindowInfo w : windows) {
      w.getBoundsInScreen(r);
      if (top == null && r.contains(x, y)) top = w;
      if (under == null && w.getType() == AccessibilityWindowInfo.TYPE_APPLICATION) {
        AccessibilityNodeInfo root = w.getRoot();
        if (root != null && root.getPackageName() != null) under = root.getPackageName().toString();
      }
    }
    if (under != null) out.put("under", under);
    if (top == null) return out.toString();
    out.put("type", top.getType());
    AccessibilityNodeInfo root = top.getRoot();
    if (root == null) return out.toString();
    if (root.getPackageName() != null) out.put("pkg", root.getPackageName().toString());

    // Down the branch: at each node the child on top at the point, by drawing order and the later child on a tie
    // (Reach.under's order).
    List<AccessibilityNodeInfo> branch = new ArrayList<>();
    for (AccessibilityNodeInfo n = root; n != null; ) {
      branch.add(n);
      List<AccessibilityNodeInfo> kids = new ArrayList<>();
      for (int i = n.getChildCount() - 1; i >= 0; i--) {
        AccessibilityNodeInfo c = n.getChild(i);
        if (c != null) kids.add(c);
      }
      kids.sort((a, b) -> Integer.compare(b.getDrawingOrder(), a.getDrawingOrder()));
      AccessibilityNodeInfo next = null;
      for (AccessibilityNodeInfo c : kids) {
        c.getBoundsInScreen(r);
        if (c.isVisibleToUser() && r.contains(x, y)) { next = c; break; }
      }
      n = next;
    }
    JSONArray nodes = new JSONArray();
    for (int i = branch.size() - 1; i >= 0 && nodes.length() < MAX_BRANCH; i--) nodes.put(node(branch.get(i)));
    // When the branch was read: a read the touch's up may already have changed is not used (the agent's deadline).
    return out.put("branch", nodes).put("done", System.nanoTime()).toString();
  }

  private static JSONObject node(AccessibilityNodeInfo n) throws Exception {
    JSONObject o = new JSONObject();
    if (n.getClassName() != null) o.put("c", n.getClassName().toString());
    if (n.getViewIdResourceName() != null) o.put("id", n.getViewIdResourceName());
    boolean secret = n.isEditable() || n.isPassword();
    // What a person typed, and a password's dots, stay on the device, from its text or its description (an app can put
    // the value there): an input is named by its id only.
    if (!secret && n.getText() != null && n.getText().length() > 0) o.put("t", n.getText().toString());
    if (!secret && n.getContentDescription() != null && n.getContentDescription().length() > 0) o.put("d", n.getContentDescription().toString());
    int k = (n.isClickable() ? 1 : 0) | (n.isLongClickable() ? 2 : 0) | (n.isEditable() ? 4 : 0)
        | (n.isPassword() ? 8 : 0) | (n.isScrollable() ? 16 : 0) | (n.isCheckable() ? 32 : 0);
    if (k != 0) o.put("k", k);
    Rect b = new Rect();
    n.getBoundsInScreen(b);
    o.put("b", new JSONArray().put(b.left).put(b.top).put(b.right).put(b.bottom));
    return o;
  }
}
