export interface BadgeProps {
  tone?: 'success' | 'warning' | 'danger' | 'info' | 'accent' | 'neutral';
  icon?: React.ReactNode;
  children?: React.ReactNode;
}
export function Badge(props: BadgeProps): JSX.Element;
