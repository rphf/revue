// A page cannot bring its own tab forward: browsers allow focus() only
// during a user action. A click on a notification is one, so when
// `revue open` finds this tab already open, a notification carries the
// user back; without permission, the title blinks until the tab is seen.

import { api } from "../api";

export type NotifyPermission = NotificationPermission | "unsupported";

export function notifyPermission(): NotifyPermission {
  return typeof Notification === "undefined"
    ? "unsupported"
    : Notification.permission;
}

// Must run from a user action: Firefox refuses the prompt otherwise.
export async function askNotifyPermission(): Promise<NotifyPermission> {
  if (typeof Notification === "undefined") return "unsupported";
  return Notification.requestPermission();
}

function inFront(): boolean {
  return document.visibilityState === "visible" && document.hasFocus();
}

// requestAttention reports whether the tab still needs the user to act:
// false when it is already in front or a notification is up.
export function requestAttention(title: string, body: string): boolean {
  if (inFront()) return false;
  if (notifyPermission() === "granted") {
    // No tag: one with the tag of a notification still up replaces it
    // without alerting, so a second `revue open` went unseen.
    shown?.close();
    const n = new Notification(title, { body });
    n.onclick = () => {
      window.focus();
      n.close();
      // The click selects the tab; on macOS the server then raises the
      // browser app, which a page cannot do.
      void api.raise().catch(() => {});
    };
    shown = n;
    return false;
  }
  blinkTitle();
  return true;
}

let shown: Notification | null = null;
let blinking = false;

function blinkTitle() {
  if (blinking) return;
  blinking = true;
  const original = document.title;
  let on = false;
  const timer = window.setInterval(() => {
    on = !on;
    document.title = on ? `● ${original}` : original;
  }, 1000);
  const stop = () => {
    if (!inFront()) return;
    window.clearInterval(timer);
    document.title = original;
    blinking = false;
    window.removeEventListener("focus", stop);
    document.removeEventListener("visibilitychange", stop);
  };
  window.addEventListener("focus", stop);
  document.addEventListener("visibilitychange", stop);
}
