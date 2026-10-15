/** Inline SVG icon set (fork pattern P4): one module, stroke follows
 * currentColor, no icon font. 20px design grid. */
import React from 'react'

function Svg(props: { children: React.ReactNode; size?: number }): React.JSX.Element {
  return (
    <svg
      width={props.size ?? 20}
      height={props.size ?? 20}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.8}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      {props.children}
    </svg>
  )
}

export const IconChat = (p: { size?: number }): React.JSX.Element => (
  <Svg size={p.size}>
    <path d="M21 12a8 8 0 0 1-8 8H5l-2 2V12a8 8 0 0 1 8-8h2a8 8 0 0 1 8 8Z" />
  </Svg>
)
export const IconList = (p: { size?: number }): React.JSX.Element => (
  <Svg size={p.size}>
    <path d="M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01" />
  </Svg>
)
export const IconCrew = (p: { size?: number }): React.JSX.Element => (
  <Svg size={p.size}>
    <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2" />
    <circle cx="9" cy="7" r="4" />
    <path d="M23 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75" />
  </Svg>
)
export const IconChip = (p: { size?: number }): React.JSX.Element => (
  <Svg size={p.size}>
    <rect x="4" y="4" width="16" height="16" rx="2" />
    <rect x="9" y="9" width="6" height="6" />
    <path d="M9 1v3M15 1v3M9 20v3M15 20v3M1 9h3M1 15h3M20 9h3M20 15h3" />
  </Svg>
)
export const IconTimer = (p: { size?: number }): React.JSX.Element => (
  <Svg size={p.size}>
    <circle cx="12" cy="13" r="8" />
    <path d="M12 9v4l2 2M9 2h6" />
  </Svg>
)
export const IconCube = (p: { size?: number }): React.JSX.Element => (
  <Svg size={p.size}>
    <path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z" />
    <path d="M3.27 6.96 12 12.01l8.73-5.05M12 22.08V12" />
  </Svg>
)
export const IconTerminal = (p: { size?: number }): React.JSX.Element => (
  <Svg size={p.size}>
    <path d="m4 17 6-6-6-6M12 19h8" />
  </Svg>
)
export const IconBrowser = (p: { size?: number }): React.JSX.Element => (
  <Svg size={p.size}>
    <circle cx="12" cy="12" r="10" />
    <path d="M2 12h20M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z" />
  </Svg>
)
export const IconLink = (p: { size?: number }): React.JSX.Element => (
  <Svg size={p.size}>
    <path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71" />
    <path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71" />
  </Svg>
)
export const IconGear = (p: { size?: number }): React.JSX.Element => (
  <Svg size={p.size}>
    <circle cx="12" cy="12" r="3" />
    <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
  </Svg>
)
export const IconSkills = (p: { size?: number }): React.JSX.Element => (
  <Svg size={p.size}>
    <path d="m14.7 6.3 3 3L21 6l-3-3-3.3 3.3zM3 21l7.5-7.5M12 9l3 3" />
    <path d="m14.7 6.3-8.4 8.4a2 2 0 0 0-.5.9L3 21l5.8-2.8a2 2 0 0 0 .9-.5L18 9" />
  </Svg>
)
export const IconPlus = (p: { size?: number }): React.JSX.Element => (
  <Svg size={p.size}>
    <path d="M12 5v14M5 12h14" />
  </Svg>
)
export const IconSend = (p: { size?: number }): React.JSX.Element => (
  <Svg size={p.size}>
    <path d="m22 2-7 20-4-9-9-4 20-7z" />
  </Svg>
)
export const IconStop = (p: { size?: number }): React.JSX.Element => (
  <Svg size={p.size}>
    <rect x="6" y="6" width="12" height="12" rx="2" />
  </Svg>
)
export const IconRefresh = (p: { size?: number }): React.JSX.Element => (
  <Svg size={p.size}>
    <path d="M21 12a9 9 0 1 1-3-6.7L21 8M21 3v5h-5" />
  </Svg>
)
export const IconSearch = (p: { size?: number }): React.JSX.Element => (
  <Svg size={p.size}>
    <circle cx="11" cy="11" r="8" />
    <path d="m21 21-4.35-4.35" />
  </Svg>
)
export const IconClose = (p: { size?: number }): React.JSX.Element => (
  <Svg size={p.size}>
    <path d="M18 6 6 18M6 6l12 12" />
  </Svg>
)
