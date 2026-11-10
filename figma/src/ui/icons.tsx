import type { JSX } from 'preact';

type P = { size?: number };

const svg = (size: number, children: JSX.Element | JSX.Element[]) => (
  <svg width={size} height={size} viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
    {children}
  </svg>
);

export const IconCheck = ({ size = 14 }: P) => svg(size, <path d="M3.5 8.5l3 3 6-7" />);
export const IconWarn = ({ size = 14 }: P) => svg(size, [<path d="M8 2.5l6 11H2z" />, <path d="M8 7v3" />, <path d="M8 12h.01" />]);
export const IconStop = ({ size = 14 }: P) => svg(size, [<circle cx="8" cy="8" r="6" />, <path d="M5.5 5.5l5 5M10.5 5.5l-5 5" />]);
export const IconGear = ({ size = 14 }: P) =>
  svg(size, [
    <circle cx="8" cy="8" r="2.2" />,
    <path d="M8 1.8v1.6M8 12.6v1.6M14.2 8h-1.6M3.4 8H1.8M12.4 3.6l-1.1 1.1M4.7 11.3l-1.1 1.1M12.4 12.4l-1.1-1.1M4.7 4.7L3.6 3.6" />,
  ]);
export const IconClock = ({ size = 14 }: P) => svg(size, [<circle cx="8" cy="8" r="6" />, <path d="M8 4.5V8l2.5 1.5" />]);
export const IconArrow = ({ size = 14 }: P) => svg(size, <path d="M3 8h10M9.5 4.5L13 8l-3.5 3.5" />);
export const IconBack = ({ size = 14 }: P) => svg(size, <path d="M13 8H3M6.5 4.5L3 8l3.5 3.5" />);
export const IconExternal = ({ size = 12 }: P) => svg(size, [<path d="M9 3h4v4" />, <path d="M13 3L7.5 8.5" />, <path d="M11 9.5V13H3V5h3.5" />]);
export const IconTarget = ({ size = 14 }: P) => svg(size, [<circle cx="8" cy="8" r="5.5" />, <circle cx="8" cy="8" r="2" />]);
export const IconPlay = ({ size = 14 }: P) => svg(size, <path d="M5 3.5l7 4.5-7 4.5z" />);
export const IconPin = ({ size = 14 }: P) => svg(size, [<path d="M8 14.5s4.5-4.2 4.5-7.7A4.5 4.5 0 003.5 6.8C3.5 10.3 8 14.5 8 14.5z" />, <circle cx="8" cy="6.8" r="1.6" />]);
export const IconRefresh = ({ size = 14 }: P) => svg(size, [<path d="M13 8a5 5 0 11-1.5-3.6" />, <path d="M13 2.5v3h-3" />]);
export const IconFrame = ({ size = 12 }: P) => svg(size, <path d="M5 1.5v13M11 1.5v13M1.5 5h13M1.5 11h13" />);

/** The Å ring, the one bit of brand in the panel. */
export const Mark = ({ size = 16 }: P) => (
  <svg width={size} height={size} viewBox="0 0 16 16" aria-hidden="true">
    <circle cx="8" cy="3.2" r="2.1" fill="none" stroke="var(--accent)" stroke-width="1.5" />
    <path d="M2.6 15L8 6.4 13.4 15" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round" />
    <path d="M4.6 11.6h6.8" stroke="currentColor" stroke-width="1.4" />
  </svg>
);
