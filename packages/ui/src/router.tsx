/** A minimal History API router: real URLs (/overview, /entity/AUTH-03) that survive a refresh. */
import { useSyncExternalStore, type MouseEvent, type ReactNode } from "react";

const EVENT = "duo:navigate";
const subscribe = (fn: () => void) => {
  window.addEventListener("popstate", fn);
  window.addEventListener(EVENT, fn);
  return () => { window.removeEventListener("popstate", fn); window.removeEventListener(EVENT, fn); };
};

export function usePath(): string {
  return useSyncExternalStore(subscribe, () => window.location.pathname + window.location.search, () => "/overview");
}

export function navigate(to: string): void {
  window.history.pushState(null, "", to);
  window.dispatchEvent(new Event(EVENT));
  document.getElementById("main")?.focus();
}

export function Link(props: { readonly to: string; readonly children: ReactNode; readonly className?: string; readonly current?: boolean }) {
  const onClick = (e: MouseEvent<HTMLAnchorElement>) => {
    if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    e.preventDefault();
    navigate(props.to);
  };
  return <a href={props.to} onClick={onClick} className={props.className} aria-current={props.current === true ? "page" : undefined}>{props.children}</a>;
}

export const entityPath = (id: string) => `/entity/${encodeURIComponent(id)}`;
