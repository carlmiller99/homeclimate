import type { ReactNode } from "react";
import { Link } from "react-router";

export interface Section {
  id: string;
  label: string;
  /** Shown greyed out with "Planned" and not linked. */
  planned?: boolean;
}

/**
 * A page with a left-side section menu (Smart Control, Settings). Sections are
 * a query parameter, not a path segment: the bundle loads its assets from
 * relative URLs (HA ingress), which a nested path would break.
 */
export default function SectionLayout({
  title,
  subtitle,
  basePath,
  sections,
  current,
  children,
}: {
  title: string;
  subtitle: string;
  basePath: string;
  sections: Section[];
  current: string;
  children: ReactNode;
}) {
  return (
    <div className="section-page">
      <div className="page-header">
        <div>
          <h1 className="page-title">{title}</h1>
          <p className="page-subtitle">{subtitle}</p>
        </div>
      </div>
      <div className="sc-layout">
        <nav className="sc-nav" aria-label={`${title} sections`}>
          {sections.map((s) =>
            s.planned ? (
              <div key={s.id} className="sc-nav-item is-planned">
                <span>{s.label}</span>
                <span className="sc-nav-note">Planned</span>
              </div>
            ) : (
              // A plain Link: NavLink matches on the path alone, so it would
              // mark every section current.
              <Link
                key={s.id}
                to={`${basePath}?section=${s.id}`}
                className={`sc-nav-item${current === s.id ? " is-current" : ""}`}
                aria-current={current === s.id ? "page" : undefined}
              >
                {s.label}
              </Link>
            )
          )}
        </nav>
        <div className="sc-main">{children}</div>
      </div>
    </div>
  );
}
