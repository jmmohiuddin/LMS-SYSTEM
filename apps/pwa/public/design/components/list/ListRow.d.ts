export interface ListRowProps {
  leading?: React.ReactNode;
  title?: React.ReactNode;
  subtitle?: React.ReactNode;
  trailing?: React.ReactNode;
  onClick?: () => void;
}
export function ListRow(props: ListRowProps): JSX.Element;
