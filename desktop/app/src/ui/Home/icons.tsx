/** Minimal stroke icons for the Home surface — currentColor only, so the
 * theme tokens stay in charge. Kept local: the shell's icon table moves
 * with the shell rebuild, these mean "example task", not "nav screen". */
import type { ReactElement } from 'react'

function base(props: { size?: number }): { width: number; height: number; viewBox: string; fill: string; stroke: string; strokeWidth: number; strokeLinecap: 'round'; strokeLinejoin: 'round' } {
  const size = props.size ?? 16
  return {
    width: size,
    height: size,
    viewBox: '0 0 24 24',
    fill: 'none',
    stroke: 'currentColor',
    strokeWidth: 1.8,
    strokeLinecap: 'round',
    strokeLinejoin: 'round',
  }
}

export function IconResearch(props: { size?: number }): ReactElement {
  return (
    <svg {...base(props)} aria-hidden>
      <circle cx="11" cy="11" r="6.5" />
      <path d="m20 20-4.4-4.4" />
    </svg>
  )
}

export function IconPlan(props: { size?: number }): ReactElement {
  return (
    <svg {...base(props)} aria-hidden>
      <rect x="5" y="4" width="14" height="17" rx="2" />
      <path d="M9 9h6M9 13h6M9 17h3.5" />
    </svg>
  )
}

export function IconReview(props: { size?: number }): ReactElement {
  return (
    <svg {...base(props)} aria-hidden>
      <path d="M2.5 12S6 5.8 12 5.8 21.5 12 21.5 12 18 18.2 12 18.2 2.5 12 2.5 12Z" />
      <circle cx="12" cy="12" r="2.6" />
    </svg>
  )
}

export function IconGoal(props: { size?: number }): ReactElement {
  return (
    <svg {...base(props)} aria-hidden>
      <circle cx="12" cy="12" r="8.5" />
      <circle cx="12" cy="12" r="4.8" />
      <circle cx="12" cy="12" r="1.2" fill="currentColor" stroke="none" />
    </svg>
  )
}

export function IconCron(props: { size?: number }): ReactElement {
  return (
    <svg {...base(props)} aria-hidden>
      <circle cx="12" cy="12" r="8.5" />
      <path d="M12 7.5V12l3 2" />
    </svg>
  )
}

export function IconLearn(props: { size?: number }): ReactElement {
  return (
    <svg {...base(props)} aria-hidden>
      <path d="M12 21v-8" />
      <path d="M12 13C12 9 9.5 7 5.5 7c0 4 2.5 6 6.5 6Z" />
      <path d="M12 10c0-3.2 2-5 5.5-5 0 3.5-2 5.3-5.5 5.3" />
    </svg>
  )
}

export function IconBrowser(props: { size?: number }): ReactElement {
  return (
    <svg {...base(props)} aria-hidden>
      <circle cx="12" cy="12" r="8.5" />
      <path d="M3.5 12h17M12 3.5c2.6 2.3 3.9 5.1 3.9 8.5s-1.3 6.2-3.9 8.5c-2.6-2.3-3.9-5.1-3.9-8.5s1.3-6.2 3.9-8.5Z" />
    </svg>
  )
}

export function IconBranch(props: { size?: number }): ReactElement {
  return (
    <svg {...base(props)} aria-hidden>
      <circle cx="6.5" cy="6" r="2.2" />
      <circle cx="6.5" cy="18" r="2.2" />
      <circle cx="17.5" cy="8" r="2.2" />
      <path d="M6.5 8.2v7.6M17.5 10.2c0 3-2.5 4.3-6 4.6" />
    </svg>
  )
}

/** Generic glyph for catalog picks outside the curated set. */
export function IconBolt(props: { size?: number }): ReactElement {
  return (
    <svg {...base(props)} aria-hidden>
      <path d="M13 3 5.5 13.5H11L10 21l7.5-10.5H13L13 3Z" />
    </svg>
  )
}

export function IconChevronRight(props: { size?: number }): ReactElement {
  return (
    <svg {...base(props)} aria-hidden>
      <path d="m9.5 6 6 6-6 6" />
    </svg>
  )
}

export function IconArrowUp(props: { size?: number }): ReactElement {
  return (
    <svg {...base(props)} aria-hidden>
      <path d="M12 19V5M5.5 11.5 12 5l6.5 6.5" />
    </svg>
  )
}

export function IconStop(props: { size?: number }): ReactElement {
  return (
    <svg {...base(props)} aria-hidden>
      <rect x="7" y="7" width="10" height="10" rx="1.5" fill="currentColor" stroke="none" />
    </svg>
  )
}
