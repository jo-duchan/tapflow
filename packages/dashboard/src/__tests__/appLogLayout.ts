/**
 * jsdom lays nothing out, so a virtualized list there mounts no rows at all. This gives the app log's scroll box a
 * height and each row a height (`FAKE_ROW_HEIGHT`, or what `rowHeight` says for its text), and makes `scrollTop` a real,
 * clamped
 * value that fires `scroll` when it changes, which is all the virtualizer reads. As in a browser, `scroll` comes with the
 * next frame (through `requestAnimationFrame`, which the tests stub and flush), once per frame: fired at once, it would
 * reach a listener between two layout effects of one commit, a state no browser shows.
 */
/** The rows' height here: the viewer's estimate for one line, so a row lands where it was estimated to. */
export const FAKE_ROW_HEIGHT = 27

export function fakeAppLogLayout({ viewport = 220, rowHeight = (_text: string): number => FAKE_ROW_HEIGHT } = {}) {
  const scrollTops = new WeakMap<Element, number>()
  const pending = new WeakSet<Element>()
  const isBox = (el: Element) => el.getAttribute('aria-label') === 'App log output'
  const contentHeight = (el: Element) => {
    const sizer = el.firstElementChild as HTMLElement | null
    return sizer ? parseFloat(sizer.style.height) || sizer.offsetHeight : 0
  }
  const clamp = (el: Element, top: number) => Math.max(0, Math.min(top, contentHeight(el) - viewport))
  const restore: Array<() => void> = []
  const define = (proto: object, name: string, descriptor: PropertyDescriptor) => {
    const original = Object.getOwnPropertyDescriptor(proto, name)
    Object.defineProperty(proto, name, { configurable: true, ...descriptor })
    restore.push(() => original ? Object.defineProperty(proto, name, original) : delete (proto as Record<string, unknown>)[name])
  }

  define(HTMLElement.prototype, 'clientHeight', { get(this: HTMLElement) { return isBox(this) ? viewport : 0 } })
  define(HTMLElement.prototype, 'clientWidth', { get(this: HTMLElement) { return isBox(this) ? 300 : 0 } })
  define(HTMLElement.prototype, 'offsetHeight', {
    get(this: HTMLElement) { return this.hasAttribute('data-log-line') ? rowHeight(this.textContent) : 0 },
  })
  define(Element.prototype, 'scrollHeight', { get(this: Element) { return isBox(this) ? contentHeight(this) : 0 } })
  define(Element.prototype, 'scrollTop', {
    // Read clamped as well: when the content shrinks under it (rows measured shorter than estimated), a browser moves
    // `scrollTop` down to the new end.
    get(this: Element) { const top = scrollTops.get(this) ?? 0; return isBox(this) ? clamp(this, top) : top },
    set(this: Element, top: number) {
      const next = isBox(this) ? clamp(this, top) : top
      if (next === (scrollTops.get(this) ?? 0)) return
      scrollTops.set(this, next)
      if (pending.has(this)) return
      pending.add(this)
      requestAnimationFrame(() => {
        pending.delete(this)
        this.dispatchEvent(new Event('scroll'))
      })
    },
  })
  define(Element.prototype, 'scrollTo', {
    value(this: Element, options: ScrollToOptions) {
      if (options.top === undefined) return
      this.scrollTop = options.top
    },
  })

  /** Scrolls the box as a reader would. */
  const scrollBox = (box: Element, top: number) => {
    box.scrollTop = top
  }
  return { scrollBox, restore: () => restore.reverse().forEach((undo) => undo()) }
}
