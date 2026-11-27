import { useEffect } from "react";

const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

/** The dialog on top: the last backdrop in the page, and the box inside it. */
function topDialog(): { backdrop: HTMLElement; box: HTMLElement } | null {
  const all = document.querySelectorAll<HTMLElement>(".modal-backdrop");
  const backdrop = all[all.length - 1];
  if (!backdrop) return null;
  return { backdrop, box: backdrop.querySelector<HTMLElement>(".modal") ?? backdrop };
}

/**
 * Keyboard behaviour for every dialog in the app, in one place, so no dialog
 * can be without it.
 *
 * - Escape leaves the dialog the way its own Close or Cancel button does (or
 *   a click outside it, for one with neither).
 * - Tab stays inside the dialog.
 * - Opening a dialog moves focus into it; closing it puts focus back where it
 *   was.
 *
 * Mounted once, in App. It reads the page's own markup (`.modal-backdrop`
 * holding a `.modal`), which every dialog already shares.
 */
export default function ModalKeys() {
  useEffect(() => {
    let seen: HTMLElement | null = null;
    // The last thing focused outside every dialog: where focus goes back to.
    let outside: Element | null = document.activeElement;
    const onFocus = (e: FocusEvent) => {
      const at = e.target;
      if (at instanceof Element && !at.closest(".modal-backdrop")) outside = at;
    };
    // Focus dropped to nothing outside a dialog (a click on something that
    // takes no focus): there is then nowhere to go back to.
    const onBlur = (e: FocusEvent) => {
      const at = e.target;
      if (!e.relatedTarget && at instanceof Element && !at.closest(".modal-backdrop"))
        outside = null;
    };

    const settle = () => {
      const top = topDialog();
      if (top?.backdrop === seen) return;
      if (top) {
        seen = top.backdrop;
        if (!top.box.contains(document.activeElement)) {
          if (!top.box.hasAttribute("tabindex")) top.box.setAttribute("tabindex", "-1");
          top.box.focus();
        }
        return;
      }
      seen = null;
      if (outside instanceof HTMLElement && document.contains(outside))
        outside.focus({ preventScroll: true });
    };

    const onKey = (e: KeyboardEvent) => {
      const top = topDialog();
      // A key something else has already used (a picker, text being composed) is left alone.
      if (!top || e.defaultPrevented || e.isComposing) return;
      if (e.key === "Escape") {
        e.preventDefault();
        const leave = Array.from(top.box.querySelectorAll<HTMLButtonElement>("button")).find(
          (b) => !b.disabled && ["Close", "Cancel"].includes(String(b.textContent).trim())
        );
        (leave ?? top.backdrop).click();
        return;
      }
      if (e.key !== "Tab") return;
      const stops = Array.from(top.box.querySelectorAll<HTMLElement>(FOCUSABLE));
      if (stops.length === 0) {
        e.preventDefault();
        return;
      }
      const first = stops[0];
      const last = stops[stops.length - 1];
      const at = document.activeElement;
      if (!top.box.contains(at) || at === top.box) {
        e.preventDefault();
        (e.shiftKey ? last : first).focus();
      } else if (e.shiftKey && at === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && at === last) {
        e.preventDefault();
        first.focus();
      }
    };

    const watch = new MutationObserver(settle);
    watch.observe(document.body, { childList: true, subtree: true });
    document.addEventListener("keydown", onKey);
    document.addEventListener("focusin", onFocus);
    document.addEventListener("focusout", onBlur);
    settle();
    return () => {
      watch.disconnect();
      document.removeEventListener("keydown", onKey);
      document.removeEventListener("focusin", onFocus);
      document.removeEventListener("focusout", onBlur);
    };
  }, []);
  return null;
}
