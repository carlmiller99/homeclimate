import type { ReactNode } from "react";
import { Link, useInRouterContext } from "react-router";

/**
 * One thing that needs attention, in the app's one notice style: a quiet row
 * with a line of what, a line of why, the particulars folded away, and a link
 * to where it is fixed. Every page uses this, so a warning looks the same on
 * the Dashboard as it does in My Home.
 *
 * `serious` adds a red mark before the title for the rare notice that means
 * something is not being controlled at all. It does not change the frame.
 */
export default function Notice({
  title,
  children,
  details,
  to,
  action,
  serious = false,
  testId,
}: {
  title: string;
  children: ReactNode;
  /** The particulars (which sensors, which zones), folded away by default. */
  details?: ReactNode;
  /** Where it is fixed, as an in-app path, with the link's wording. */
  to?: string;
  action?: string;
  serious?: boolean;
  testId?: string;
}) {
  // Pages are always under the router; a notice shown on its own (a test, a
  // story) falls back to a plain link rather than failing to render.
  const routed = useInRouterContext();
  return (
    <section className="notice" role="status" data-testid={testId}>
      <div className="notice-text">
        <p className="notice-title">
          {serious && <span className="notice-mark" aria-hidden="true" />}
          {title}
        </p>
        <p className="notice-body">{children}</p>
        {details && (
          <details className="notice-details">
            <summary>Details</summary>
            {details}
          </details>
        )}
      </div>
      {to && action && routed && (
        <Link className="notice-action" to={to}>
          {action}
        </Link>
      )}
      {to && action && !routed && (
        <a className="notice-action" href={to}>
          {action}
        </a>
      )}
    </section>
  );
}
