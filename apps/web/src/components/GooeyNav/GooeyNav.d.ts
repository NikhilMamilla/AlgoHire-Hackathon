// Types for the vendored React Bits GooeyNav (JavaScript + CSS variant). Source: https://reactbits.dev
import type { CSSProperties, ReactNode } from 'react';

export type GooeyNavItem = { label: string; href?: string; icon?: ReactNode };

export interface GooeyNavProps {
  items: GooeyNavItem[];
  initialActiveIndex?: number;
  activeIndex?: number;
  onChange?: (index: number, item: GooeyNavItem) => void;
  theme?: 'dark' | 'light';
  color?: string;
  activeTextColor?: string;
  colors?: string[];
  size?: 'sm' | 'md' | 'lg';
  frame?: boolean;
  animationTime?: number;
  particleCount?: number;
  spread?: number;
  timeVariance?: number;
  gooeyness?: number;
  wobble?: number;
  hoverEffect?: boolean;
  className?: string;
  style?: CSSProperties;
  /** Accessible name for the <nav> landmark (local addition). */
  ariaLabel?: string;
}

declare const GooeyNav: (props: GooeyNavProps) => JSX.Element;
export default GooeyNav;
