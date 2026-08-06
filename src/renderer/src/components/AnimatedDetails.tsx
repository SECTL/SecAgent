import { ReactNode, useEffect, useState } from "react";

export function AnimatedDetails({ className, summary, children, autoOpen = false, summaryRef }: { className: string; summary: ReactNode; children: ReactNode; autoOpen?: boolean; summaryRef?: { current: HTMLButtonElement | null } }) {
  const [open, setOpen] = useState(false);

  useEffect(() => {
    setOpen(autoOpen);
  }, [autoOpen]);

  const expanded = open;
  return <div className={`${className} animated-details ${expanded ? "is-open" : ""}`}>
    <button ref={summaryRef} type="button" className="details-summary" aria-expanded={expanded} onClick={() => setOpen((current) => !current)}>
      {summary}
    </button>
    <div className="details-panel" aria-hidden={!expanded}><div className="details-panel-inner">{children}</div></div>
  </div>;
}
