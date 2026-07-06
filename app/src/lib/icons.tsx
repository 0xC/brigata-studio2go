// Monochrome stroke icons. They inherit currentColor, so they adopt whichever
// theme color the parent element uses (text-dim, accent on hover, etc.).
// Style: 1.75px stroke, 18px default size — Lucide-ish proportions.

import type { CSSProperties } from 'react'

interface IconProps {
  size?: number
  className?: string
  style?: CSSProperties
  'aria-label'?: string
  title?: string
}

function base(props: IconProps, children: React.ReactNode) {
  const { size = 18, ...rest } = props
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.75}
      strokeLinecap="round"
      strokeLinejoin="round"
      style={{ display: 'inline-block', verticalAlign: '-2px', ...rest.style }}
      className={rest.className}
      aria-label={rest['aria-label']}
    >
      {rest.title && <title>{rest.title}</title>}
      {children}
    </svg>
  )
}

export const IconPencil = (p: IconProps) => base(p, (
  <>
    <path d="M12 20h9" />
    <path d="M16.5 3.5a2.121 2.121 0 1 1 3 3L7 19l-4 1 1-4 12.5-12.5z" />
  </>
))

export const IconTrash = (p: IconProps) => base(p, (
  <>
    <path d="M3 6h18" />
    <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6" />
    <path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
    <line x1="10" y1="11" x2="10" y2="17" />
    <line x1="14" y1="11" x2="14" y2="17" />
  </>
))

export const IconDownload = (p: IconProps) => base(p, (
  <>
    <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
    <polyline points="7 10 12 15 17 10" />
    <line x1="12" y1="15" x2="12" y2="3" />
  </>
))

export const IconPrint = (p: IconProps) => base(p, (
  <>
    <polyline points="6 9 6 2 18 2 18 9" />
    <path d="M6 18H4a2 2 0 0 1-2-2v-5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2h-2" />
    <rect x="6" y="14" width="12" height="8" />
  </>
))

export const IconPaperclip = (p: IconProps) => base(p, (
  <path d="M21.44 11.05l-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48" />
))

export const IconPalette = (p: IconProps) => base(p, (
  <>
    <circle cx="13.5" cy="6.5" r="0.75" fill="currentColor" stroke="none" />
    <circle cx="17.5" cy="10.5" r="0.75" fill="currentColor" stroke="none" />
    <circle cx="8.5" cy="7.5" r="0.75" fill="currentColor" stroke="none" />
    <circle cx="6.5" cy="12.5" r="0.75" fill="currentColor" stroke="none" />
    <path d="M12 22a10 10 0 1 1 10-10 4 4 0 0 1-4 4h-1.5a1.5 1.5 0 0 0-1.06 2.56A1.5 1.5 0 0 1 14.5 21.5 1.5 1.5 0 0 1 13 23a1 1 0 0 1-1-1z" />
  </>
))

export const IconSplit = (p: IconProps) => base(p, (
  <>
    <rect x="3" y="4" width="18" height="16" rx="2" />
    <line x1="12" y1="4" x2="12" y2="20" />
  </>
))

export const IconPin = (p: IconProps) => base(p, (
  <>
    <path d="M12 17v5" />
    <path d="M9 10.76V6a2 2 0 0 1 2-2h2a2 2 0 0 1 2 2v4.76l2 2.24v2H7v-2l2-2.24z" />
  </>
))

export const IconFolder = (p: IconProps) => base(p, (
  <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7z" />
))

export const IconDocument = (p: IconProps) => base(p, (
  <>
    <path d="M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z" />
    <polyline points="14 3 14 9 20 9" />
  </>
))

// In focus — a target/spotlight (ring + center node). Replaces the ❖ glyph,
// which rendered as a movie-clapper in some fonts.
export const IconFocus = (p: IconProps) => base(p, (
  <>
    <circle cx="12" cy="12" r="8.4" />
    <circle cx="12" cy="12" r="2.4" fill="currentColor" stroke="none" />
  </>
))

// Relay — an agent→agent handoff: two nodes joined by an arrow.
export const IconRelay = (p: IconProps) => base(p, (
  <>
    <circle cx="5.5" cy="12" r="2.3" fill="currentColor" stroke="none" />
    <circle cx="18.5" cy="12" r="2.3" fill="currentColor" stroke="none" />
    <path d="M8.4 12 H14.4" />
    <path d="M12.4 9.4 L15 12 L12.4 14.6" fill="none" />
  </>
))

// Brigade — a little crew: three antenna'd heads above their shoulders (two in
// front, one behind). The antennas make them read as agents, not just people,
// and the heads-and-shoulders silhouette is unmistakably distinct from the
// constellation channel glyph (which Chris found too close to the old network
// mark). Heads/shoulders are stroked; antenna tips are filled dots.
export const IconBrigade = (p: IconProps) => base(p, (
  <>
    {/* back (center) figure, slightly raised */}
    <path d="M8 13.7 a4 3.4 0 0 1 8 0" opacity={0.85} />
    <circle cx="12" cy="6.3" r="2.3" />
    <path d="M12 4 V2.5" />
    <circle cx="12" cy="2.0" r="0.62" fill="currentColor" stroke="none" />
    {/* front-left figure */}
    <path d="M2.4 19.4 a4.4 4 0 0 1 8.8 0" />
    <circle cx="6.8" cy="10.4" r="2.5" />
    <path d="M6.8 7.9 V6.3" />
    <circle cx="6.8" cy="5.85" r="0.62" fill="currentColor" stroke="none" />
    {/* front-right figure */}
    <path d="M12.8 19.4 a4.4 4 0 0 1 8.8 0" />
    <circle cx="17.2" cy="10.4" r="2.5" />
    <path d="M17.2 7.9 V6.3" />
    <circle cx="17.2" cy="5.85" r="0.62" fill="currentColor" stroke="none" />
  </>
))

// Dashboard / Overview — a trend line whose data points are nodes (ties to the
// constellation motif while reading clearly as "metrics / dashboard").
export const IconDashboard = (p: IconProps) => base(p, (
  <>
    <path d="M4 19h16" strokeWidth={1.4} strokeLinecap="round" opacity={0.3} />
    <polyline points="4.8,14.5 9.5,10.3 13.5,12.8 19.2,6.4" fill="none" strokeWidth={1.7} />
    <circle cx="4.8" cy="14.5" r="1.5" fill="currentColor" stroke="none" />
    <circle cx="9.5" cy="10.3" r="1.5" fill="currentColor" stroke="none" />
    <circle cx="13.5" cy="12.8" r="1.5" fill="currentColor" stroke="none" />
    <circle cx="19.2" cy="6.4" r="1.8" fill="currentColor" stroke="none" />
  </>
))

// Settings — sliders whose knobs are nodes (bespoke + cohesive with the
// node-motif family; clearer at small size than a fiddly cog). Exported as
// IconGear for the existing rail import.
export const IconGear = (p: IconProps) => base(p, (
  <>
    <g strokeWidth={1.7} strokeLinecap="round">
      <path d="M4 8.5h16" />
      <path d="M4 15.5h16" />
    </g>
    <circle cx="15" cy="8.5" r="2.5" fill="currentColor" stroke="none" />
    <circle cx="9" cy="15.5" r="2.5" fill="currentColor" stroke="none" />
  </>
))

// Brigata channel glyph — the brand constellation. Three stars in the exact
// triangle of the favicon (scaled from its 32px viewBox), now joined by faint
// connecting lines so it reads unmistakably as a constellation rather than a
// generic cluster of dots. Monochrome (currentColor) so it tints with theme/
// hover/active. This replaces the Slack-style # as the room prefix.
export const IconChannel = (p: IconProps) => {
  const { size = 14, ...rest } = p
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      style={{ display: 'inline-block', verticalAlign: '-2px', ...rest.style }}
      className={rest.className}
      aria-hidden="true"
    >
      {/* constellation lines — faint triangle joining the three stars */}
      <g stroke="currentColor" strokeWidth="1.1" strokeLinecap="round" strokeLinejoin="round" opacity="0.4">
        <path d="M7.5 8.5 L16.5 9.5 L10.5 17 Z" />
      </g>
      {/* the three brand stars (largest = the lead, per the favicon) */}
      <g fill="currentColor">
        <circle cx="16.5" cy="9.5" r="2.7" />
        <circle cx="7.5" cy="8.5" r="2.05" />
        <circle cx="10.5" cy="17" r="1.85" />
      </g>
    </svg>
  )
}
