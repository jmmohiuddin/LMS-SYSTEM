export interface SidebarItem { value: string; label: string; icon?: React.ReactNode; }
export interface SidebarProps {
  items?: SidebarItem[];
  active?: string;
  brand?: string;
}
export function Sidebar(props: SidebarProps): JSX.Element;
