export interface TableColumn { key: string; label: string; align?: 'left' | 'right' | 'center'; }
export interface TableProps {
  columns?: TableColumn[];
  rows?: Record<string, React.ReactNode>[];
}
export function Table(props: TableProps): JSX.Element;
