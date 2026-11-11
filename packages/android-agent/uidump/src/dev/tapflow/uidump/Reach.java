package dev.tapflow.uidump;

import android.app.UiAutomation;
import android.graphics.Rect;
import android.util.Base64;
import android.view.accessibility.AccessibilityNodeInfo;
import android.view.accessibility.AccessibilityWindowInfo;
import java.util.ArrayList;
import java.util.HashSet;
import java.util.List;
import java.util.Set;
import org.json.JSONArray;
import org.json.JSONObject;

/**
 * Where a touch meant for an element lands (#1125), so the flow engine taps there rather than at its frame's centre,
 * which a tab bar, a floating button or a scrim can cover — a covered row passed as tapped.
 *
 * Nothing on Android answers "which node takes a touch at this point", so the answer is read from the accessibility
 * tree, by rules each measured against a real tap on the sample apps (occluded-elements plan, measurements 3–5):
 *
 *   - What is on top: windows by layer, then within a parent the higher drawing order, and on a tie the later child.
 *     Compose reports 0 for every sibling and orders its children by z (a `zIndex` badge declared first came first);
 *     classic Views report their real drawing order (an elevated badge added first read 4 over the list's 1).
 *   - A point is clear when nothing but the element, its ancestors and its descendants is above it there, and no
 *     descendant that takes touches (a row's trailing switch) is the one on top.
 *   - Covered by a node that takes touches (clickable, long-clickable) is occluded. Covered only by nodes that take none
 *     cannot be judged: a decoration lets the touch through, and a scrim with a touch listener and no clickable flag
 *     takes it (both measured), and the tree tells them apart in neither.
 *
 * The centre is tried first; then points across the element, nearest the centre first.
 */
final class Reach {
  private Reach() {}

  private static final int GRID = 5;

  static String answer(UiAutomation automation, String line) throws Exception {
    JSONArray targets = new JSONArray(new String(Base64.decode(line == null ? "" : line.trim(), Base64.DEFAULT), "UTF-8"));
    AccessibilityNodeInfo root = automation.getRootInActiveWindow();
    JSONArray results = new JSONArray();
    if (root == null) {
      for (int i = 0; i < targets.length(); i++) results.put(unknown("no window"));
      return new JSONObject().put("results", results).toString();
    }
    // The tree's basis, as uiTree.ts normalizes against the dump's root.
    Rect basis = new Rect();
    root.getBoundsInScreen(basis);
    List<AccessibilityWindowInfo> windows = new ArrayList<>(automation.getWindows());
    windows.sort((a, b) -> Integer.compare(b.getLayer(), a.getLayer()));
    List<AccessibilityNodeInfo> all = new ArrayList<>();
    collect(root, all);
    for (int i = 0; i < targets.length(); i++) results.put(one(targets.getJSONObject(i), all, windows, basis));
    return new JSONObject().put("results", results).toString();
  }

  private static JSONObject one(JSONObject t, List<AccessibilityNodeInfo> all, List<AccessibilityWindowInfo> windows, Rect basis) throws Exception {
    String id = t.optString("identifier", "");
    String label = t.optString("label", "");
    JSONObject f = t.getJSONObject("frame");
    double fx = f.getDouble("x"), fy = f.getDouble("y"), fw = f.getDouble("width"), fh = f.getDouble("height");
    AccessibilityNodeInfo best = null;
    double bestD = Double.MAX_VALUE, runnerUp = Double.MAX_VALUE;
    int candidates = 0, onScreen = 0;
    for (AccessibilityNodeInfo n : all) {
      String nid = n.getViewIdResourceName();
      if (!id.isEmpty() ? !id.equals(nid) : !label.equals(labelOf(n))) continue;
      candidates++;
      Rect r = new Rect();
      n.getBoundsInScreen(r);
      if (!r.intersect(basis) || r.isEmpty()) continue;
      onScreen++;
      double d = Math.abs(nx(r.left, basis) - fx) + Math.abs(ny(r.top, basis) - fy)
          + Math.abs((double) r.width() / basis.width() - fw) + Math.abs((double) r.height() / basis.height() - fh);
      if (d < bestD) { runnerUp = bestD; bestD = d; best = n; } else if (d < runnerUp) runnerUp = d;
    }
    if (candidates > 0 && onScreen == 0) return new JSONObject().put("state", "offscreen");
    // Not the element the client read — gone, moved, or two equally near: read again, never guess.
    if (best == null || bestD >= 0.02 || runnerUp - bestD <= 0.002) return new JSONObject().put("state", "missing").put("candidates", onScreen);
    if (!best.isVisibleToUser()) return new JSONObject().put("state", "offscreen");

    Rect r = new Rect();
    best.getBoundsInScreen(r);
    r.intersect(basis);
    Set<AccessibilityNodeInfo> ancestors = new HashSet<>();
    for (AccessibilityNodeInfo p = best.getParent(); p != null; p = p.getParent()) ancestors.add(p);
    String blockedBy = null, unsureBy = null;
    for (int[] pt : points(r)) {
      Verdict v = at(pt[0], pt[1], best, ancestors, windows);
      if (v.clear) {
        JSONObject frame = new JSONObject().put("x", nx(r.left, basis)).put("y", ny(r.top, basis))
            .put("width", (double) r.width() / basis.width()).put("height", (double) r.height() / basis.height());
        return new JSONObject().put("state", "reachable")
            .put("point", new JSONArray().put(nx(pt[0], basis)).put(ny(pt[1], basis)))
            .put("atCentre", pt[0] == r.centerX() && pt[1] == r.centerY())
            .put("frame", frame);
      }
      if (v.consumer != null && blockedBy == null) blockedBy = v.consumer;
      if (v.consumer == null && v.cover != null && unsureBy == null) unsureBy = v.cover;
    }
    if (blockedBy != null) return new JSONObject().put("state", "occluded").put("by", blockedBy);
    return unknown(unsureBy == null ? "no point of it could be read"
        : "covered by " + unsureBy + ", which takes no touches in the tree but may in the app");
  }

  private static final class Verdict {
    boolean clear;
    /** What takes the touch instead: a covering node, or a descendant, that takes touches. */
    String consumer;
    /** What covers it without saying it takes touches. */
    String cover;
  }

  /** Who is above `target` at a point, topmost first, and whether that leaves the touch to it. */
  private static Verdict at(int x, int y, AccessibilityNodeInfo target, Set<AccessibilityNodeInfo> ancestors, List<AccessibilityWindowInfo> windows) {
    List<AccessibilityNodeInfo> stack = new ArrayList<>();
    for (AccessibilityWindowInfo w : windows) {
      Rect wr = new Rect();
      w.getBoundsInScreen(wr);
      if (!wr.contains(x, y)) continue;
      AccessibilityNodeInfo wroot = w.getRoot();
      if (wroot != null) under(wroot, x, y, stack);
    }
    Verdict v = new Verdict();
    for (AccessibilityNodeInfo n : stack) {
      if (n.equals(target)) { v.clear = v.consumer == null && v.cover == null; return v; }
      if (ancestors.contains(n)) continue;
      boolean inside = isDescendant(n, target);
      boolean takes = n.isClickable() || n.isLongClickable();
      if (inside) {
        // A row's own switch or button on top takes the tap, not the row.
        if (takes && v.consumer == null) v.consumer = name(n);
        continue;
      }
      if (takes) { if (v.consumer == null) v.consumer = name(n); }
      else if (v.cover == null) v.cover = name(n);
    }
    return v;
  }

  /** Nodes containing the point, topmost first: a parent's children last-drawn first, each before its parent. */
  private static void under(AccessibilityNodeInfo node, int x, int y, List<AccessibilityNodeInfo> out) {
    Rect r = new Rect();
    node.getBoundsInScreen(r);
    if (!r.contains(x, y)) return;
    List<AccessibilityNodeInfo> kids = new ArrayList<>();
    for (int i = node.getChildCount() - 1; i >= 0; i--) {
      AccessibilityNodeInfo c = node.getChild(i);
      if (c != null) kids.add(c);
    }
    // Stable: equal drawing orders (every Compose sibling's 0) keep the later child first.
    kids.sort((a, b) -> Integer.compare(b.getDrawingOrder(), a.getDrawingOrder()));
    for (AccessibilityNodeInfo c : kids) under(c, x, y, out);
    out.add(node);
  }

  private static boolean isDescendant(AccessibilityNodeInfo n, AccessibilityNodeInfo of) {
    for (AccessibilityNodeInfo p = n.getParent(); p != null; p = p.getParent()) if (p.equals(of)) return true;
    return false;
  }

  /** The centre, then a grid across the element nearest the centre first, kept a pixel inside its edges. */
  private static List<int[]> points(Rect r) {
    List<int[]> pts = new ArrayList<>();
    pts.add(new int[] {r.centerX(), r.centerY()});
    List<int[]> grid = new ArrayList<>();
    for (int i = 0; i < GRID; i++) {
      for (int j = 0; j < GRID; j++) {
        int x = r.left + 1 + (int) ((r.width() - 2) * (i + 0.5) / GRID);
        int y = r.top + 1 + (int) ((r.height() - 2) * (j + 0.5) / GRID);
        grid.add(new int[] {x, y});
      }
    }
    grid.sort((a, b) -> Long.compare(dist2(a, r), dist2(b, r)));
    pts.addAll(grid);
    return pts;
  }

  private static long dist2(int[] p, Rect r) {
    long dx = p[0] - r.centerX(), dy = p[1] - r.centerY();
    return dx * dx + dy * dy;
  }

  private static void collect(AccessibilityNodeInfo node, List<AccessibilityNodeInfo> out) {
    out.add(node);
    for (int i = 0; i < node.getChildCount(); i++) {
      AccessibilityNodeInfo c = node.getChild(i);
      if (c != null) collect(c, out);
    }
  }

  /** As uiTree.ts names a node: its text, else its content description. */
  private static String labelOf(AccessibilityNodeInfo n) {
    CharSequence text = n.getText();
    if (text != null && text.length() > 0) return text.toString();
    CharSequence desc = n.getContentDescription();
    return desc == null ? "" : desc.toString();
  }

  /** Who covers the element, for a step's failure message, which reaches CI logs: never the text of a field or a password,
   *  as the engine names no input's label among its candidates either. */
  private static String name(AccessibilityNodeInfo n) {
    String id = n.getViewIdResourceName();
    String label = n.isPassword() || n.isEditable() ? "" : labelOf(n);
    String cls = String.valueOf(n.getClassName());
    return cls.substring(cls.lastIndexOf('.') + 1) + (id != null ? " " + id : "") + (label.isEmpty() ? "" : " '" + label + "'");
  }

  private static double nx(int x, Rect basis) { return (double) (x - basis.left) / basis.width(); }

  private static double ny(int y, Rect basis) { return (double) (y - basis.top) / basis.height(); }

  private static JSONObject unknown(String reason) {
    try {
      return new JSONObject().put("state", "unknown").put("reason", reason);
    } catch (org.json.JSONException e) {
      return new JSONObject();
    }
  }
}
