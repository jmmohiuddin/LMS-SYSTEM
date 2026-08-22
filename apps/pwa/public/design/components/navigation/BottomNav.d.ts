export interface BottomNavItem { value: string; label: string; icon?: React.ReactNode; }
export interface BottomNavProps {
  items?: BottomNavItem[];
  active?: string;
}
export function BottomNav(props: BottomNavProps): JSX.Element;
